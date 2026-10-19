import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock

sys.path.insert(0,str(Path('aws').resolve()))
import launch_stage2i_smoke as launch
spec=importlib.util.spec_from_file_location('cloud_run','aws/stage2i/run.py')
cloud=importlib.util.module_from_spec(spec);spec.loader.exec_module(cloud)


class CloudTests(unittest.TestCase):
    def test_smoke_resources(self):
        x=launch.build_spec('plumenav-stage2i-smoke-test')
        self.assertEqual(x['StoppingCondition']['MaxRuntimeInSeconds'],3600)
        self.assertEqual(x['Environment']['STAGE2I_MODE'],'nominal-preflight')
        self.assertEqual(x['ProcessingResources']['ClusterConfig'],dict(InstanceCount=1,InstanceType='ml.m5.xlarge',VolumeSizeInGB=80))
        self.assertIn(launch.ARCHIVE_SHA[:12],x['ProcessingInputs'][0]['S3Input']['S3Uri'])
        self.assertEqual(x['ProcessingOutputConfig']['Outputs'][0]['S3Output']['S3UploadMode'],'Continuous')
    def test_campaign_or_unsafe_name_rejected(self):
        for x in ['plumenav-stage2i-campaign-test','plumenav-stage2i-smoke-../bad','x'*80]:
            with self.assertRaises(ValueError):launch.build_spec(x)
    def test_wrong_archive_rejected_before_open(self):
        with self.assertRaises(ValueError):launch.validate_archive(b'changed')
    def test_single_submission(self):
        s3,sm=MagicMock(),MagicMock();spec=launch.build_spec('plumenav-stage2i-smoke-test')
        sm.create_processing_job.return_value={'ProcessingJobArn':'test'}
        sm.describe_processing_job.return_value=copy.deepcopy(spec)
        with tempfile.TemporaryDirectory() as folder:
            launch.submit(s3,sm,spec,b'test',b'script',{},Path(folder))
        sm.create_processing_job.assert_called_once_with(**spec)
        self.assertEqual(s3.put_object.call_count,4)
        for call in s3.put_object.call_args_list:self.assertEqual(call.kwargs['IfNoneMatch'],'*')
    def test_uncertain_submission_never_retried(self):
        sm=MagicMock();sm.create_processing_job.side_effect=TimeoutError('uncertain')
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(TimeoutError):launch.submit(MagicMock(),sm,launch.build_spec('plumenav-stage2i-smoke-test'),b'test',b'script',{},Path(folder))
        self.assertEqual(sm.create_processing_job.call_count,1);sm.describe_processing_job.assert_not_called()
    def test_path_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'SHA256SUMS').write_text('a'*64+'  ../outside\n')
            with self.assertRaises(AssertionError):cloud.verify(root)
    def test_bad_hash_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'payload').write_bytes(b'x');(root/'SHA256SUMS').write_text('a'*64+'  payload\n')
            with self.assertRaises(AssertionError):cloud.verify(root)
    def test_real_local_gate(self):
        root=Path('research/results/si_stage2i_nominal_preflight_2026-09-21')
        cloud.accepted_local(root,launch.BUNDLE_SHA)
        with self.assertRaises(AssertionError):cloud.accepted_local(root,'wrong')


if __name__=='__main__':unittest.main()
