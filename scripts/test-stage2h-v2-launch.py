#!/usr/bin/env python3
"""Offline launcher safety tests. No boto3 import or AWS requests."""
import copy
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
module = importlib.util.spec_from_file_location('v2_smoke_launch', ROOT / 'aws/launch_stage2h_v2_smoke.py')
launch = importlib.util.module_from_spec(module)
module.loader.exec_module(launch)


def product(rate='0.2300000000', unit='Hrs'):
    return {'terms': {'OnDemand': {'t': {'priceDimensions': {'d': {
        'unit': unit, 'pricePerUnit': {'USD': rate}}}}}}}


def clients():
    result = {name: Mock() for name in ('sts', 's3', 'sagemaker', 'iam', 'service-quotas', 'ecr', 'pricing')}
    result['sts'].get_caller_identity.return_value = {'Account': launch.ACCOUNT}
    result['s3'].get_bucket_location.return_value = {'LocationConstraint': None}
    result['s3'].get_public_access_block.return_value = {
        'PublicAccessBlockConfiguration': {k: True for k in launch.PUBLIC_BLOCK_KEYS}}
    result['iam'].get_role.return_value = {'Role': {'Arn': launch.ROLE}}
    result['service-quotas'].get_service_quota.return_value = {'Quota': {'Value': 16}}
    result['ecr'].batch_get_image.return_value = {'images': [{'imageId': {
        'imageDigest': launch.DIGEST, 'imageTag': '4.3.2-cpu'}}]}
    result['pricing'].get_products.return_value = {'PriceList': [json.dumps(product())]}
    result['sagemaker'].get_paginator.return_value.paginate.return_value = [{'ProcessingJobSummaries': []}]
    return result


class Collision(Exception):
    response = {'Error': {'Code': 'PreconditionFailed'}}


class LaunchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = (ROOT / 'aws/build/stage2h-20260918-v2.tar.gz').read_bytes()
        cls.job = 'plumenav-stage2h-v2-smoke-offline-test'

    def test_sealed_archive_and_all_payloads(self):
        bootstrap, count = launch.validate_archive(self.data)
        self.assertEqual(count, 202)
        self.assertIn(b'python aws/stage2h_v2/run.py', bootstrap)

    def test_reject_modified_archive(self):
        with self.assertRaises(ValueError):
            launch.validate_archive(self.data[:-1] + bytes([self.data[-1] ^ 1]))

    def test_original_and_added_scientific_files_unchanged(self):
        bundle = json.loads((ROOT / 'aws/build/stage2h-20260918-v2/bundle.json').read_text())
        for source in bundle['frozenSources'] + bundle['additions']:
            self.assertEqual(launch.sha((ROOT / source.get('original', source['file'])).read_bytes()), source['sha256'])
        self.assertEqual(launch.sha((ROOT / 'research/results/si_stage2h_v2_local_closure_2026-09-18.json').read_bytes()),
                         launch.LOCAL_CLOSURE_SHA)

    def test_smoke_resources_and_distinct_prefix(self):
        spec = launch.build_spec(self.job)
        self.assertEqual(spec['Environment']['STAGE2H_MODE'], 'smoke')
        self.assertEqual(spec['StoppingCondition']['MaxRuntimeInSeconds'], 3600)
        self.assertEqual(spec['Environment']['STAGE2H_INTERNAL_GUARD'], '3480')
        self.assertEqual(spec['ProcessingResources']['ClusterConfig'], {
            'InstanceCount': 1, 'InstanceType': 'ml.m5.xlarge', 'VolumeSizeInGB': 80})
        self.assertIn('20260918-v2-5f17d1505d28', spec['ProcessingInputs'][0]['S3Input']['S3Uri'])

    def test_reject_campaign_or_unsafe_names(self):
        for name in ('plumenav-stage2h-campaign-1', 'plumenav-stage2h-v2-smoke-../a', self.job * 3):
            with self.subTest(name=name), self.assertRaises(ValueError):
                launch.build_spec(name)

    def test_unapproved_launch_stops_before_file_or_network(self):
        with self.assertRaisesRegex(ValueError, 'Explicit approval'):
            launch.main(['--archive', '/nonexistent', '--launch'])

    def test_preview_name_cannot_be_launched(self):
        with self.assertRaisesRegex(ValueError, 'unique launch job name'):
            launch.main(['--archive', '/nonexistent', '--launch', '--approve-one-smoke'])

    def test_read_only_cloud_preflight(self):
        cloud = clients()
        result = launch.check_aws(cloud.__getitem__, self.job)
        self.assertEqual(float(result['computeExposureUSD']), .23)
        cloud['s3'].put_object.assert_not_called()
        cloud['sagemaker'].create_processing_job.assert_not_called()

    def test_context_guards(self):
        mutations = [
            ('sts', 'get_caller_identity', {'Account': 'wrong'}),
            ('iam', 'get_role', {'Role': {'Arn': 'wrong'}}),
            ('s3', 'get_bucket_location', {'LocationConstraint': 'eu-west-2'}),
            ('s3', 'get_public_access_block', {'PublicAccessBlockConfiguration': {}}),
            ('service-quotas', 'get_service_quota', {'Quota': {'Value': 0}}),
            ('ecr', 'batch_get_image', {'images': []}),
        ]
        for service, method, value in mutations:
            with self.subTest(service=service, method=method):
                cloud = clients()
                getattr(cloud[service], method).return_value = value
                with self.assertRaises(ValueError):
                    launch.check_aws(cloud.__getitem__, self.job)

    def test_active_job_on_later_page_blocks(self):
        cloud = clients()
        cloud['sagemaker'].get_paginator.return_value.paginate.return_value = [
            {'ProcessingJobSummaries': []}, {'ProcessingJobSummaries': [{'ProcessingJobName': 'old-active'}]}]
        with self.assertRaisesRegex(ValueError, 'active'):
            launch.check_aws(cloud.__getitem__, self.job)

    def test_completed_same_name_blocks(self):
        cloud = clients()
        cloud['sagemaker'].get_paginator.return_value.paginate.side_effect = [
            [{'ProcessingJobSummaries': []}], [{'ProcessingJobSummaries': []}],
            [{'ProcessingJobSummaries': [{'ProcessingJobName': self.job}]}]]
        with self.assertRaisesRegex(ValueError, 'already exists'):
            launch.check_aws(cloud.__getitem__, self.job)

    def test_price_guards(self):
        for rate, unit in (('.24', 'Hrs'), ('0', 'Hrs'), ('NaN', 'Hrs'), ('.23', 'GB-Mo')):
            with self.subTest(rate=rate, unit=unit):
                client = Mock()
                client.get_products.return_value = {'PriceList': [json.dumps(product(rate, unit))]}
                with self.assertRaises(ValueError):
                    launch.read_price(client)

    def test_price_pagination(self):
        client = Mock()
        client.get_products.side_effect = [{'PriceList': [], 'NextToken': 'page2'},
                                           {'PriceList': [json.dumps(product())]}]
        self.assertEqual(float(launch.read_price(client)[1]), .23)
        self.assertEqual(client.get_products.call_args.kwargs['NextToken'], 'page2')

    def test_input_collision_checks_actual_bytes(self):
        s3 = Mock()
        s3.put_object.side_effect = Collision()
        s3.get_object.return_value = {'ServerSideEncryption': 'AES256', 'Body': io.BytesIO(b'correct')}
        launch.put_immutable(s3, 'key', b'correct', allow_identical=True)
        s3.get_object.return_value['Body'] = io.BytesIO(b'changed')
        with self.assertRaisesRegex(ValueError, 'collision'):
            launch.put_immutable(s3, 'key', b'correct', allow_identical=True)
        self.assertEqual(s3.put_object.call_args.kwargs['IfNoneMatch'], '*')

    def test_launch_record_never_overwritten(self):
        s3 = Mock()
        s3.put_object.side_effect = Collision()
        with self.assertRaises(Collision):
            launch.put_immutable(s3, 'launch.json', b'{}')
        s3.get_object.assert_not_called()

    def test_one_submission_and_description_check(self):
        s3, sm = Mock(), Mock()
        spec = launch.build_spec(self.job)
        sm.create_processing_job.return_value = {'ProcessingJobArn': 'mock-arn'}
        sm.describe_processing_job.return_value = copy.deepcopy(spec)
        with tempfile.TemporaryDirectory() as folder:
            response = launch.submit(s3, sm, spec, b'test-archive', b'test-bootstrap', {'offlineTest': True}, Path(folder))
            self.assertEqual(response['ProcessingJobArn'], 'mock-arn')
            self.assertTrue((Path(folder) / 'description.json').is_file())
        sm.create_processing_job.assert_called_once_with(**spec)

    def test_uncertain_submission_never_retried(self):
        s3, sm = Mock(), Mock()
        sm.create_processing_job.side_effect = TimeoutError('uncertain')
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(TimeoutError):
            launch.submit(s3, sm, launch.build_spec(self.job), b'test', b'test', {}, Path(folder))
        self.assertEqual(sm.create_processing_job.call_count, 1)
        sm.describe_processing_job.assert_not_called()

    def test_live_client_policy_keeps_submission_single_attempt(self):
        source = (ROOT / 'aws/launch_stage2h_v2_smoke.py').read_text()
        self.assertIn("'total_max_attempts': 6, 'mode': 'adaptive'", source)
        self.assertIn("submit_sm = session.client('sagemaker'", source)
        self.assertIn("retries={'total_max_attempts': 1}", source)
        self.assertIn("submit(client('s3'), submit_sm", source)

    def test_wrong_described_resource_is_detected_without_replacement(self):
        s3, sm = Mock(), Mock()
        spec = launch.build_spec(self.job)
        sm.create_processing_job.return_value = {'ProcessingJobArn': 'mock-arn'}
        description = copy.deepcopy(spec)
        description['ProcessingResources']['ClusterConfig']['InstanceCount'] = 2
        sm.describe_processing_job.return_value = description
        with tempfile.TemporaryDirectory() as folder, self.assertRaisesRegex(ValueError, 'specification mismatch'):
            launch.submit(s3, sm, spec, b'test', b'test', {}, Path(folder))
        self.assertEqual(sm.create_processing_job.call_count, 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
