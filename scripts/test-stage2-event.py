#!/usr/bin/env python3
import copy
import gzip
import json
import unittest
from pathlib import Path
from lib.si_event_integration_audit import audit


class EventAuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root=Path('research/evidence/si_event_development_2026-09-16')
        cls.records=[json.loads(gzip.decompress((root/f'case-{i}.json.gz').read_bytes())) for i in range(5)]

    def test_five_development_histories(self):
        for record in self.records:self.assertTrue(audit(record)['passed'])

    def test_blank_mesh_invariance(self):
        for r in self.records[1:4]:
            self.assertEqual(r['controls'],self.records[1]['controls']);self.assertEqual(r['segments'],self.records[1]['segments'])

    def corrupted(self,change,index=1):
        r=copy.deepcopy(self.records[index]);change(r)
        with self.assertRaises(AssertionError):audit(r)

    def test_motion_descriptor_tamper(self):
        self.corrupted(lambda r:r['segments'][2].__setitem__('moveSeconds',.01))

    def test_intermediate_path_tamper(self):
        self.corrupted(lambda r:r['trace'][5].__setitem__(1,r['trace'][5][1]+.001))

    def test_scan_validity_tamper(self):
        self.corrupted(lambda r:r['controls'][5]['measurement'].__setitem__('valid',True))

    def test_readout_tamper(self):
        self.corrupted(lambda r:r['trace'][64].__setitem__(20,r['trace'][64][20]+.01))

    def test_fake_nomination_tamper(self):
        self.corrupted(lambda r:r.__setitem__('nomination',dict(point={'x':.5,'y':.5},observationTime=0,concentration=1,supportTimes=[0,1,2])))

    def test_positive_bridge_and_no_physical_claim(self):
        r=self.records[0]
        self.assertTrue(all(a['decision']['status']=='supported' for a in r['verification']['arms']))
        self.assertFalse(r['summary']['physicalSourceConfirmed']);self.assertFalse(r['summary']['assertedNoLeak'])


if __name__=='__main__':unittest.main()
