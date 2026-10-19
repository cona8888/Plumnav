"""Small witness collector fixtures; no AWS calls, launches or simulations."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('collector',Path(__file__).with_name('collect-mechanism-wrapper-witness-v1.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
INDEX=ROOT/'research/results/si_mechanism_campaign_audit_index_v1_attempt01_2026-09-30/audit-index.json'


class Fixtures(unittest.TestCase):
    def setUp(self):
        self.index=m.strict_json(INDEX.read_bytes())
        self.name='plumenav-mech-wrapper-witness-v2-20261001-123456'
        self.prefix='plumenav/mechanism/20261001-wrapper-fixture/jobs/'+self.name+'/output/'
        spec=dict(ProcessingJobName=self.name,RoleArn=m.ROLE,AppSpecification=dict(ImageUri=m.IMAGE),
            ProcessingResources=dict(ClusterConfig=dict(InstanceCount=1,InstanceType='ml.m5.12xlarge',VolumeSizeInGB=300)),
            StoppingCondition=dict(MaxRuntimeInSeconds=7200),
            Environment=dict(OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1',MKL_NUM_THREADS='1',MECHANISM_DEVELOPMENT_APPROVED='YES'),
            ProcessingInputs=[dict(InputName='input',S3Input=dict(S3Uri='s3://'+m.BUCKET+'/plumenav/mechanism/20261001-wrapper-fixture/input/'))],
            ProcessingOutputConfig=dict(Outputs=[dict(OutputName='wrapper-witness',S3Output=dict(LocalPath='/opt/ml/processing/output',
                S3Uri='s3://'+m.BUCKET+'/'+self.prefix,S3UploadMode='Continuous'))]))
        self.intent=dict(version='mechanism-campaign-launch-intent-v1',kind='wrapper-witness',releaseSha256='a'*64,
            manifestSha256=m.MANIFEST_SHA,auditIndexSha256=m.INDEX_SHA,histories=3,developmentManifestSha256=m.DEV_SHA,
            developmentCases=list(m.CASES),reservedWorldsExecuted=0,scientificallyAccepted=False,
            inputHashes={'campaign.tar.gz':'b'*64},spec=spec)
        self.actual=copy.deepcopy(spec)
        self.actual.update(ProcessingJobArn='arn:aws:sagemaker:'+m.REGION+':'+m.ACCOUNT+':processing-job/'+self.name,
            ProcessingJobStatus='Completed',ProcessingStartTime='fixture-start',ProcessingEndTime='fixture-end',FailureReason=None)

    def validate(self):return m.validate_launch(self.intent,self.actual,self.name,'wrapper-witness','a'*64)

    def test_actual_pinned_prospective_index(self):self.assertEqual(m.sha(INDEX),m.INDEX_SHA)

    def test_membership_matches_new_shared_runner(self):
        source=(ROOT/'aws/mechanism-campaign-wrapper-v2/run.py').read_text()
        start=source.index('def required_payloads(');end=source.index('\ndef execute_cases(',start)
        ns={'need':m.need};exec(source[start:end],ns)
        r=types.SimpleNamespace(executionCaseIds=m.CASES)
        self.assertEqual(m.expected_payloads(self.index,'wrapper-witness'),ns['required_payloads'](r))
        self.assertEqual(len(m.expected_payloads(self.index,'wrapper-witness'))+1,44)

    def test_only_fixed_development_raw_histories(self):
        names=m.expected_payloads(self.index,'wrapper-witness')
        self.assertEqual(sum(x.endswith('mission.json.gz') for x in names),3)
        self.assertFalse(any('mechanism-fresh-' in n for n in names))

    def test_fixture_launch_scope(self):self.assertEqual(self.validate(),self.prefix)

    def test_full_campaign_job_not_accepted(self):
        self.name=self.name.replace('wrapper-witness','campaign')
        with self.assertRaises(ValueError):self.validate()

    def test_running_failed_stopped_rejected(self):
        for status in ('InProgress','Failed','Stopped'):
            self.actual['ProcessingJobStatus']=status
            with self.assertRaises(ValueError):self.validate()

    def test_not_development_only_rejected(self):
        self.intent['spec']['Environment']['MECHANISM_CAMPAIGN_APPROVED']='YES'
        with self.assertRaisesRegex(ValueError,'Development-only'):self.validate()

    def test_wrong_input_scope_or_case_set(self):
        for key,value in (('histories',2400),('reservedWorldsExecuted',1),('developmentManifestSha256','f'*64),('developmentCases',list(m.CASES[:-1]))):
            old=self.intent[key];self.intent[key]=value
            with self.assertRaises(ValueError):self.validate()
            self.intent[key]=old

    def test_guard_cannot_be_full_campaign(self):
        self.intent['spec']['StoppingCondition']['MaxRuntimeInSeconds']=86400
        with self.assertRaises(ValueError):self.validate()

    def test_actual_configuration_differs_rejected(self):
        self.actual['ProcessingResources']['ClusterConfig']['InstanceCount']=2
        with self.assertRaisesRegex(ValueError,'differs'):self.validate()

    def test_altered_image_even_both_rejected(self):
        self.intent['spec']['AppSpecification']['ImageUri']='other';self.actual['AppSpecification']['ImageUri']='other'
        with self.assertRaises(ValueError):self.validate()

    def test_missing_extra_duplicate_inventory(self):
        rows=[dict(Key='prefix/a',Size=1),dict(Key='prefix/b',Size=2)]
        m.verify_inventory(rows,'prefix/',{'a','b'})
        for bad in (rows[:-1],rows+[rows[0]],rows+[dict(Key='prefix/c',Size=3)]):
            with self.assertRaises(ValueError):m.verify_inventory(bad,'prefix/',{'a','b'})

    def test_tmp_space_requires_bodies_plus_tar_reserve(self):
        with tempfile.TemporaryDirectory(dir=str(Path('/tmp').resolve())) as tmp:
            path=Path(tmp)/'fresh'
            with patch.object(m.shutil,'disk_usage',return_value=types.SimpleNamespace(free=2*1024**3)):
                m.destination(path,100*1024**2)
                with self.assertRaises(ValueError):m.destination(path,600*1024**2)
            path.mkdir()
            with self.assertRaises(ValueError):m.destination(path,1)

    def test_no_cloudshell_home(self):
        with self.assertRaises(ValueError):m.destination(Path.home()/'not-created-witness',1)

    def test_malformed_json_rejected(self):
        for raw in ('{"a":1,"a":2}','{"a":Infinity}'):
            with self.assertRaises(ValueError):m.strict_json(raw)

    def test_private_path_scope(self):
        for uri in ('s3://other/x','s3://'+m.BUCKET+'/other/x','s3://'+m.BUCKET+'/plumenav/mechanism/../escape'):
            with self.assertRaises(ValueError):m.private_key(uri)

    def test_no_paid_or_mutating_calls(self):
        source=Path(m.__file__).read_text()
        for forbidden in ('create_processing_job(', 'put_object(', 'upload_file(', 'delete_object(', 'subprocess.', 'full_audit('):
            self.assertNotIn(forbidden,source)


if __name__=='__main__':unittest.main()
