"""Offline guards only: no AWS connection or scientific run."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock
sys.path.insert(0, str(Path('aws').resolve()))
import launch_stage2i_campaign as campaign


class CampaignGuards(unittest.TestCase):
    def closure(self):
        s = campaign.smoke
        return dict(schemaVersion='stage2i-cloud-smoke-closure-v1', accepted=True,
            downloadedAndIndependentlyAudited=True, cloudValidated=True, campaignLaunched=False,
            smokeJob=campaign.SMOKE_JOB, archiveSha256=s.ARCHIVE_SHA,
            bundleSha256=s.BUNDLE_SHA, deliverySha256=s.DELIVERY_SHA,
            imageUri=s.base.IMAGE, independentAuditSha256='b'*64,
            caseCount=12, rawHistoriesAudited=24, productionMaxRuntimeSeconds=43200,
            internalGuardSeconds=43080,
            planning=dict(workers=4, headroomRequired=1.25, totalProjectionSeconds=28000))

    def validate(self, data):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)/'closure.json'; p.write_text(json.dumps(data))
            with patch.object(campaign, 'CLOSURE_SHA', campaign.base.sha(p.read_bytes())), patch.object(campaign, 'AUDIT_SHA', 'b'*64):
                return campaign.validate_closure(p)

    def test_valid_fixture(self):
        self.assertTrue(self.validate(self.closure())['accepted'])

    def test_rejected_missing_gates(self):
        for key in ['accepted','downloadedAndIndependentlyAudited','cloudValidated']:
            c=self.closure();c[key]=False
            with self.subTest(key=key), self.assertRaises(ValueError):self.validate(c)

    def test_wrong_identities(self):
        for key in ['archiveSha256','bundleSha256','deliverySha256','imageUri','independentAuditSha256','smokeJob']:
            c=self.closure();c[key]='changed'
            with self.subTest(key=key), self.assertRaises(ValueError):self.validate(c)

    def test_wrong_count_or_previous_launch(self):
        for key,value in [('caseCount',11),('rawHistoriesAudited',12),('campaignLaunched',True),('productionMaxRuntimeSeconds',50400),('internalGuardSeconds',50000)]:
            c=self.closure();c[key]=value
            with self.subTest(key=key), self.assertRaises(ValueError):self.validate(c)

    def test_headroom_required(self):
        for key,value in [('workers',8),('headroomRequired',1.1),('totalProjectionSeconds',35000),('totalProjectionSeconds',float('nan'))]:
            c=self.closure();c['planning'][key]=value
            with self.subTest(key=key), self.assertRaises(ValueError):self.validate(c)

    def test_unpinned_disabled(self):
        with patch.object(campaign,'CLOSURE_SHA','PENDING'), self.assertRaises(ValueError):
            campaign.validate_closure(Path('/does-not-exist'))

    def test_exact_runtime_and_same_environment(self):
        smoke=campaign.smoke.build_spec('plumenav-stage2i-smoke-test')
        c=campaign.build_spec('plumenav-stage2i-campaign-test')
        for k in ['AppSpecification','ProcessingResources','RoleArn','ProcessingInputs']:
            self.assertEqual(smoke[k],c[k])
        self.assertEqual(c['StoppingCondition'],dict(MaxRuntimeInSeconds=43200))
        self.assertEqual(c['Environment']['STAGE2I_MODE'],'nominal-only')
        self.assertEqual(c['Environment']['STAGE2I_INTERNAL_GUARD'],'43080')
        self.assertEqual(c['ProcessingOutputConfig']['Outputs'][0]['S3Output']['S3UploadMode'],'Continuous')

    def test_name_restrictions(self):
        for n in ['plumenav-stage2i-smoke-test','plumenav-stage2i-campaign-../bad','x'*64]:
            with self.assertRaises(ValueError):campaign.build_spec(n)

    def test_cli_requires_explicit_approval(self):
        with self.assertRaises(ValueError):campaign.main(['--archive','missing','--closure','missing','--launch'])

    def test_cli_requires_unique_name(self):
        with self.assertRaises(ValueError):campaign.main(['--archive','missing','--closure','missing','--launch','--approve-one-campaign'])

    def check_fixture(self, status='Completed', existing=False, rate='0.23'):
        sm=MagicMock();sm.describe_processing_job.return_value=dict(ProcessingJobStatus=status)
        client=MagicMock(return_value=sm)
        with patch.object(campaign.smoke,'check_aws',return_value=dict(hourlyRateUSD=rate)), patch.object(campaign.base,'job_summaries',return_value=iter([{}] if existing else [])):
            return campaign.check_aws(client,'plumenav-stage2i-campaign-test')

    def test_aws_gate_terminal(self):
        for status in ['InProgress','Failed','Stopped']:
            with self.assertRaises(ValueError):self.check_fixture(status=status)

    def test_no_replacement(self):
        with self.assertRaises(ValueError):self.check_fixture(existing=True)

    def test_price_ceiling(self):
        with self.assertRaises(ValueError):self.check_fixture(rate='0.24')
        self.assertEqual(self.check_fixture()['computeExposureUSD'],'2.76')


if __name__=='__main__':unittest.main()
