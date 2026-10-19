"""Zero-AWS, zero-mission collector contract tests; no campaign admission."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
c = load_module('campaign_collector', Path(__file__).with_name('collect-mechanism-campaign-v1.py'))
INDEX = ROOT/'research/results/si_mechanism_campaign_audit_index_v1_attempt01_2026-09-30/audit-index.json'


class Fixtures(unittest.TestCase):
    def setUp(self):
        self.index = c.strict_json(INDEX.read_bytes())
        self.name = 'plumenav-mech-campaign-v1-20261001-123456'
        self.prefix = 'plumenav/mechanism/20261001-campaign-fixture/jobs/' + self.name + '/output/'
        spec = dict(ProcessingJobName=self.name, RoleArn=c.ROLE,
            AppSpecification=dict(ImageUri=c.IMAGE),
            ProcessingResources=dict(ClusterConfig=dict(InstanceCount=1, InstanceType='ml.m5.12xlarge', VolumeSizeInGB=300)),
            StoppingCondition=dict(MaxRuntimeInSeconds=86400),
            Environment=dict(OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1', MKL_NUM_THREADS='1'),
            ProcessingInputs=[dict(InputName='input', S3Input=dict(S3Uri='s3://'+c.BUCKET+'/plumenav/mechanism/20261001-campaign-fixture/input/'))],
            ProcessingOutputConfig=dict(Outputs=[dict(OutputName='campaign', S3Output=dict(LocalPath='/opt/ml/processing/output',
                S3Uri='s3://'+c.BUCKET+'/'+self.prefix, S3UploadMode='Continuous'))]))
        self.intent = dict(version='mechanism-campaign-launch-intent-v1', kind='producer', releaseSha256='a'*64,
            manifestSha256=c.MANIFEST_SHA, auditIndexSha256=c.INDEX_SHA, histories=2400, scientificallyAccepted=False,
            inputHashes={'campaign.tar.gz':'b'*64}, spec=spec)
        self.actual = copy.deepcopy(spec)
        self.actual.update(ProcessingJobArn='arn:aws:sagemaker:'+c.REGION+':'+c.ACCOUNT+':processing-job/'+self.name,
            ProcessingJobStatus='Completed', ProcessingStartTime='fixture-start', ProcessingEndTime='fixture-end', FailureReason=None)

    def validate(self):
        return c.validate_launch(self.intent, self.actual, self.name, 'producer', 'a'*64)

    def test_prospective_index_hash(self):
        self.assertEqual(c.sha(INDEX), c.INDEX_SHA)

    def test_producer_exact_existing_runner_membership(self):
        # Import the runner without importing a registry bound to the wrong ROOT.
        source=(ROOT/'aws/mechanism-campaign-v1/run.py').read_text()
        start=source.index('def required_payloads('); end=source.index('\ndef execute_cases(', start)
        ns={'need':c.need}; exec(source[start:end], ns)
        registry=type('RegistryFixture', (), {'cases':dict.fromkeys(self.index['historyIds'])})()
        self.assertEqual(c.expected_payloads(self.index, 'producer'), ns['required_payloads'](registry))
        self.assertEqual(len(c.expected_payloads(self.index, 'producer'))+1, 28808)

    def test_independent_exact_saved_driver_membership(self):
        source=(ROOT/'scripts/audit-mechanism-campaign-saved-v1.py').read_text()
        start=source.index('def payloads('); end=source.index('\ndef audit_command(', start)
        ns={'need':c.need}; exec(source[start:end], ns)
        self.assertEqual(c.expected_payloads(self.index, 'independent-audit'), ns['payloads'](self.index['historyIds']))
        self.assertEqual(len(c.expected_payloads(self.index, 'independent-audit'))+1, 14407)

    def test_launch_fixture(self): self.assertEqual(self.validate(), self.prefix)

    def test_inprogress_failure_or_stopped_rejected(self):
        for status in ('InProgress','Failed','Stopped'):
            self.actual['ProcessingJobStatus']=status
            with self.assertRaises(ValueError): self.validate()

    def test_no_timestamps_rejected(self):
        self.actual['ProcessingEndTime']=None
        with self.assertRaises(ValueError): self.validate()

    def test_altered_actual_resources(self):
        self.actual['ProcessingResources']['ClusterConfig']['VolumeSizeInGB']=100
        with self.assertRaisesRegex(ValueError,'differs'): self.validate()

    def test_altered_image_even_both(self):
        self.intent['spec']['AppSpecification']['ImageUri']='other'
        self.actual['AppSpecification']['ImageUri']='other'
        with self.assertRaises(ValueError): self.validate()

    def test_wrong_hash_or_scope(self):
        for k,v in [('releaseSha256','c'*64),('histories',120),('kind','independent-audit'),('scientificallyAccepted',True)]:
            old=self.intent[k]; self.intent[k]=v
            with self.assertRaises(ValueError): self.validate()
            self.intent[k]=old

    def test_private_scope(self):
        for uri in ('s3://other/private','s3://'+c.BUCKET+'/unrelated/a','s3://'+c.BUCKET+'/plumenav/mechanism/../x'):
            with self.assertRaises(ValueError): c.private_key(uri)

    def test_extra_missing_duplicate_membership(self):
        rows=[dict(Key='prefix/a',Size=1),dict(Key='prefix/b',Size=2)]
        c.verify_inventory(rows,'prefix/',{'a','b'})
        for bad in (rows[:-1],rows+[rows[0]],rows+[dict(Key='prefix/c',Size=3)]):
            with self.assertRaises(ValueError): c.verify_inventory(bad,'prefix/',{'a','b'})

    def test_unsafe_or_duplicate_index(self):
        self.index['historyIds'][0]='../escape'
        with self.assertRaises(ValueError): c.expected_payloads(self.index,'producer')
        self.index['historyIds'][0]=self.index['historyIds'][1]
        with self.assertRaises(ValueError): c.expected_payloads(self.index,'producer')

    def test_strict_json(self):
        for raw in ('{"a":1,"a":2}','{"a":NaN}'):
            with self.assertRaises(ValueError): c.strict_json(raw)

    def test_fresh_destination_and_capacity(self):
        with tempfile.TemporaryDirectory(dir=str(Path('/tmp').resolve())) as tmp:
            target=Path(tmp)/'new'
            with patch.object(c.shutil,'disk_usage',return_value=type('Disk',(),{'free':11*1024**3})()):
                self.assertEqual(c.destination(target,1),target)
                with self.assertRaises(ValueError): c.destination(target,20*1024**3)
            target.mkdir()
            with self.assertRaises(ValueError): c.destination(target,1)

    def test_home_destination_not_allowed(self):
        with self.assertRaises(ValueError): c.destination(Path.home()/'uncreated-campaign-download',1)

    def test_no_s3_writes_or_numerical_execution(self):
        source=Path(c.__file__).read_text()
        for forbidden in ('put_object(', 'upload_file(', 'delete_object(', 'create_processing_job(', 'subprocess.', 'full_audit('):
            self.assertNotIn(forbidden,source)


if __name__=='__main__': unittest.main()
