#!/usr/bin/env python3
"""Offline campaign-launch safety tests. No boto3 import or AWS requests."""
import copy
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'aws'))
module = importlib.util.spec_from_file_location(
    'v2_campaign_launch', ROOT / 'aws/launch_stage2h_v2_campaign.py')
launch = importlib.util.module_from_spec(module)
module.loader.exec_module(launch)


def product(rate='0.2300000000', unit='Hrs'):
    return {'terms': {'OnDemand': {'t': {'priceDimensions': {'d': {
        'unit': unit, 'pricePerUnit': {'USD': rate}}}}}}}


def clients():
    names = ('sts', 's3', 'sagemaker', 'iam', 'service-quotas', 'ecr', 'pricing')
    result = {name: Mock() for name in names}
    result['sts'].get_caller_identity.return_value = {'Account': launch.base.ACCOUNT}
    result['s3'].get_bucket_location.return_value = {'LocationConstraint': None}
    result['s3'].get_public_access_block.return_value = {
        'PublicAccessBlockConfiguration': {k: True for k in launch.base.PUBLIC_BLOCK_KEYS}}
    result['iam'].get_role.return_value = {'Role': {'Arn': launch.base.ROLE}}
    result['service-quotas'].get_service_quota.return_value = {'Quota': {'Value': 16}}
    result['ecr'].batch_get_image.return_value = {'images': [{'imageId': {
        'imageDigest': launch.base.DIGEST, 'imageTag': '4.3.2-cpu'}}]}
    result['pricing'].get_products.return_value = {'PriceList': [json.dumps(product())]}
    result['sagemaker'].get_paginator.return_value.paginate.return_value = [
        {'ProcessingJobSummaries': []}]
    return result


class CampaignLaunchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.archive = ROOT / 'aws/build/stage2h-20260918-v2.tar.gz'
        cls.closure = ROOT / 'research/results/si_stage2h_v2_cloud_closure_2026-09-19.json'
        cls.job = 'plumenav-stage2h-v2-campaign-offline-test'

    def test_accepted_closure_and_sealed_archive(self):
        closure = launch.validate_closure(self.closure)
        bootstrap, count = launch.base.validate_archive(self.archive.read_bytes())
        self.assertTrue(closure['cloudValidated'])
        self.assertEqual(count, 202)
        self.assertIn(b'python aws/stage2h_v2/run.py', bootstrap)

    def test_changed_closure_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            changed = Path(folder) / 'closure.json'
            changed.write_bytes(self.closure.read_bytes() + b' ')
            with self.assertRaisesRegex(ValueError, 'accepted Stage 2h v2 cloud closure'):
                launch.validate_closure(changed)

    def test_campaign_resources_and_mode(self):
        spec = launch.build_spec(self.job)
        self.assertEqual(spec['Environment']['STAGE2H_MODE'], 'campaign')
        self.assertEqual(spec['StoppingCondition']['MaxRuntimeInSeconds'], 50_400)
        self.assertEqual(spec['Environment']['STAGE2H_INTERNAL_GUARD'], '50280')
        self.assertEqual(spec['ProcessingResources']['ClusterConfig'], {
            'InstanceCount': 1, 'InstanceType': 'ml.m5.xlarge', 'VolumeSizeInGB': 80})
        self.assertIn('/jobs/' + self.job + '/output/',
                      spec['ProcessingOutputConfig']['Outputs'][0]['S3Output']['S3Uri'])

    def test_reject_smoke_or_unsafe_names(self):
        for name in ('plumenav-stage2h-v2-smoke-1', 'plumenav-stage2h-v2-campaign-../a',
                     self.job * 3):
            with self.subTest(name=name), self.assertRaises(ValueError):
                launch.build_spec(name)

    def test_unapproved_launch_stops_before_file_or_network(self):
        with self.assertRaisesRegex(ValueError, 'Explicit approval'):
            launch.main(['--archive', '/nonexistent', '--closure', '/nonexistent', '--launch'])

    def test_preview_name_cannot_be_launched(self):
        with self.assertRaisesRegex(ValueError, 'unique launch job name'):
            launch.main(['--archive', '/nonexistent', '--closure', '/nonexistent',
                         '--launch', '--approve-one-campaign'])

    def test_read_only_cloud_preflight_and_cost(self):
        cloud = clients()
        result = launch.check_aws(cloud.__getitem__, self.job)
        self.assertEqual(result['computeExposureUSD'], '3.2200000000')
        self.assertEqual(result['maxRuntimeSeconds'], 50_400)
        cloud['s3'].put_object.assert_not_called()
        cloud['sagemaker'].create_processing_job.assert_not_called()

    def test_higher_price_exceeds_campaign_ceiling(self):
        cloud = clients()
        cloud['pricing'].get_products.return_value = {'PriceList': [json.dumps(product('.24'))]}
        with self.assertRaises(ValueError):
            launch.check_aws(cloud.__getitem__, self.job)

    def test_active_stage2h_job_blocks(self):
        cloud = clients()
        cloud['sagemaker'].get_paginator.return_value.paginate.return_value = [
            {'ProcessingJobSummaries': [{'ProcessingJobName': 'active'}]}]
        with self.assertRaisesRegex(ValueError, 'active'):
            launch.check_aws(cloud.__getitem__, self.job)

    def test_single_attempt_submission_policy_is_present(self):
        source = (ROOT / 'aws/launch_stage2h_v2_campaign.py').read_text()
        self.assertIn("retries={'total_max_attempts': 1}", source)
        self.assertIn('--approve-one-campaign', source)
        self.assertIn("STAGE2H_MODE='campaign'", source)

    def test_submit_reuses_immutable_input_and_checks_description(self):
        s3, sm = Mock(), Mock()
        spec = launch.build_spec(self.job)
        sm.create_processing_job.return_value = {'ProcessingJobArn': 'mock-arn'}
        sm.describe_processing_job.return_value = copy.deepcopy(spec)
        with tempfile.TemporaryDirectory() as folder:
            response = launch.base.submit(
                s3, sm, spec, b'archive', b'bootstrap', {'offline': True}, Path(folder))
            self.assertEqual(response['ProcessingJobArn'], 'mock-arn')
        sm.create_processing_job.assert_called_once_with(**spec)

    def test_uncertain_submission_is_not_retried(self):
        s3, sm = Mock(), Mock()
        sm.create_processing_job.side_effect = TimeoutError('uncertain')
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(TimeoutError):
            launch.base.submit(
                s3, sm, launch.build_spec(self.job), b'a', b'b', {}, Path(folder))
        self.assertEqual(sm.create_processing_job.call_count, 1)
        sm.describe_processing_job.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
