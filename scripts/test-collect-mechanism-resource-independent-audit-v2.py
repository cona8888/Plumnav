"""Collector fixtures; imports never contact AWS or execute numerical work."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('collector',Path(__file__).with_name('collect-mechanism-resource-independent-audit-v2.py'))
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)


class CollectorFixtures(unittest.TestCase):
    def setUp(self):
        folder=ROOT/'aws/build/PlumeNav_mechanism_resource_independent_audit_20260930_v2_attempt01'
        self.package=json.loads((folder/'PACKAGE.json').read_text())
        self.job='plumenav-mech-resource-audit-v2-20260930-123456'
        spec=json.loads((folder/'OFFLINE_SPEC.json').read_text())['spec']
        spec['ProcessingJobName']=self.job
        spec['Environment']['MECHANISM_INDEPENDENT_AUDIT_APPROVED']='YES'
        spec['ProcessingOutputConfig']['Outputs'][0]['S3Output']['S3Uri']='s3://'+c.BUCKET+'/'+c.BASE+'jobs/'+self.job+'/output/'
        self.intent=dict(spec=spec,inputHashes=self.package['inputFiles'],newMissions=0,productionAdmitted=False,
            zipSha256='0c99fa9160c49e5188ea8d350fe00d3a19b3f7d6c6931ed186b2e5893e391bf2',
            packageSha256='38128ac105bfe8c56c3621a1327f1ea1dd059100af29a2fded4e76239ccfca9c',
            archiveSha256='e5700b6a9e4f2ee5aa0a21d27a2c3d158ecf95f1d35f5689f573d5ff6aba90a7',archiveBytes=1897267200)
        self.actual=copy.deepcopy(spec)
        self.actual.update(ProcessingJobArn='arn:aws:sagemaker:us-east-1:380061838272:processing-job/'+self.job,
            ProcessingJobStatus='Completed',ProcessingStartTime='fixture-start',ProcessingEndTime='fixture-end',FailureReason=None)

    def validate(self):
        c.validate_launch(self.intent,self.actual,self.job)

    def test_fixed_membership_matches_bootstrap(self):
        s=importlib.util.spec_from_file_location('bootstrap',ROOT/'aws/mechanism-resource-audit-v2/bootstrap.py')
        b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
        self.assertEqual(c.expected_payloads(),b.expected_payloads())
        self.assertEqual(len(c.expected_payloads()),485)
        self.assertEqual(sum(x.endswith('-arrays.npz') for x in c.expected_payloads()),120)

    def test_valid_terminal_scope(self):
        self.validate()

    def test_prior_job_or_guessed_preview_rejected(self):
        for name in ('plumenav-mech-resource-v2-20260930-050952','plumenav-mech-resource-audit-v2-offline-preview'):
            with self.assertRaises(ValueError):c.validate_job_name(name)

    def test_running_or_failed_rejected(self):
        for status in ('InProgress','Failed','Stopped'):
            self.actual['ProcessingJobStatus']=status
            with self.assertRaises(ValueError):self.validate()

    def test_actual_configuration_difference_rejected(self):
        self.actual['ProcessingResources']['ClusterConfig']['InstanceCount']=2
        with self.assertRaisesRegex(ValueError,'differs'):self.validate()

    def test_changed_image_in_both_intent_and_job_rejected(self):
        self.intent['spec']['AppSpecification']['ImageUri']='untrusted'
        self.actual['AppSpecification']['ImageUri']='untrusted'
        with self.assertRaisesRegex(ValueError,'runtime/resource'):self.validate()

    def test_changed_evidence_and_output_rejected(self):
        for location in ('input','output'):
            saved=copy.deepcopy(self.intent)
            if location=='input':self.intent['spec']['ProcessingInputs'][0]['S3Input']['S3Uri']='s3://elsewhere/'
            else:self.intent['spec']['ProcessingOutputConfig']['Outputs'][0]['S3Output']['S3Uri']='s3://elsewhere/'
            with self.assertRaises(ValueError):self.validate()
            self.intent=saved

    def test_changed_source_and_threads_rejected(self):
        self.intent['spec']['Environment']['OPENBLAS_NUM_THREADS']='2'
        with self.assertRaisesRegex(ValueError,'source/thread'):self.validate()

    def test_hashing_reader(self):
        reader=c.HashingReader(io.BytesIO(b'known bytes'))
        self.assertEqual(reader.read(5),b'known')
        self.assertEqual(reader.read(),b' bytes')
        self.assertEqual(reader.count,11)
        self.assertEqual(reader.hash.hexdigest(),hashlib.sha256(b'known bytes').hexdigest())


if __name__=='__main__':unittest.main()
