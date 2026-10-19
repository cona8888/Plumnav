"""Saved-input contract and command fixtures only; no numerical audits/simulation."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE=Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('saved_audit_driver',HERE/'audit-mechanism-campaign-saved-v1.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ROOT=HERE.parent


class AuditContractFixtures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        manifest=ROOT/'research/results/si_mechanism_portable_metadata_attempt01_2026-09-29/prospective_manifest_portable_v1.json'
        cls.document=json.loads(manifest.read_text());cls.ids=[c['id'] for c in cls.document['cases']]

    def setUp(self):
        self.release='a'*64
        self.done=dict(completed=True,histories=2400,worlds=128,allProducerFullAuditsPassed=True,
            refinementTripletsAudited=False,scientificallyAccepted=False,independentDownloadedAuditRequired=True,
            manifestSha256=m.MANIFEST_SHA,releaseSha256=self.release)

    def test_complete_actual_all_case_membership(self):
        names=m.payloads(self.ids)
        self.assertEqual(len(names),14406)
        for cid in self.ids:
            for suffix in ('.json','-diagnostics.json','-arrays.npz'):
                self.assertIn('audits/'+cid+suffix,names)
            self.assertIn('logs/'+cid+'.log',names)
            self.assertIn('resources/'+cid+'.json',names)
            self.assertIn('terminals/'+cid+'.json',names)

    def test_missing_case_rejected(self):
        with self.assertRaisesRegex(ValueError,'2400'):m.payloads(self.ids[:-1])

    def test_duplicate_case_rejected(self):
        with self.assertRaisesRegex(ValueError,'2400'):m.payloads(self.ids[:-1]+self.ids[:1])

    def test_extra_case_rejected(self):
        with self.assertRaisesRegex(ValueError,'2400'):m.payloads(self.ids+['extra'])

    def test_case_path_injection_rejected(self):
        ids=self.ids.copy();ids[0]='../escape'
        with self.assertRaisesRegex(ValueError,'Unsafe'):m.payloads(ids)

    def test_audit_command_cannot_generate_a_mission(self):
        command=m.audit_command(Path('/fixture/project'),Path('/fixture/producer'),Path('/fixture/audit'),self.ids[0],self.release)
        self.assertTrue(command[2].endswith('/audit.py'))
        self.assertNotIn('node',command)
        self.assertNotIn('--execute-approved-campaign',command)
        self.assertEqual(command[command.index('--run')+1],'/fixture/producer/run')
        self.assertEqual(command[command.index('--audit-output')+1],'/fixture/audit/audits')
        self.assertEqual(command[command.index('--case')+1],self.ids[0])

    def test_audit_command_case_injection_rejected(self):
        with self.assertRaises(ValueError):
            m.audit_command(Path('/p'),Path('/i'),Path('/o'),'../escape',self.release)

    def test_saved_numerical_completion_only(self):m.check_completion(self.done,self.release)

    def test_scientifically_accepted_producer_claim_rejected(self):
        self.done['scientificallyAccepted']=True
        with self.assertRaises(ValueError):m.check_completion(self.done,self.release)

    def test_not_completed_rejected(self):
        self.done['completed']=False
        with self.assertRaises(ValueError):m.check_completion(self.done,self.release)

    def test_partial_2400_history_campaign_rejected(self):
        self.done['histories']=2399
        with self.assertRaises(ValueError):m.check_completion(self.done,self.release)

    def test_partial_worlds_rejected(self):
        self.done['worlds']=127
        with self.assertRaises(ValueError):m.check_completion(self.done,self.release)

    def test_producer_audit_failure_rejected(self):
        self.done['allProducerFullAuditsPassed']=False
        with self.assertRaises(ValueError):m.check_completion(self.done,self.release)

    def test_refinement_claim_not_from_this_producer_contract(self):
        self.done['refinementTripletsAudited']=True
        with self.assertRaises(ValueError):m.check_completion(self.done,self.release)

    def test_wrong_release_rejected(self):
        with self.assertRaises(ValueError):m.check_completion(self.done,'b'*64)

    def test_wrong_manifest_rejected(self):
        self.done['manifestSha256']='b'*64
        with self.assertRaises(ValueError):m.check_completion(self.done,self.release)

    def test_source_pins_match_virtual_deployment(self):
        for name,h in m.SOURCE_PINS.items():
            source=ROOT/name
            if name.endswith('/check_release.py'):
                source=ROOT/'aws/mechanism-campaign-admission-v2/check_release.py'
            elif name.endswith('/verification_manifest_v2.py'):
                source=ROOT/'scripts/verification_manifest_v2.py'
            self.assertEqual(m.sha(source),h)


if __name__=='__main__':unittest.main()
