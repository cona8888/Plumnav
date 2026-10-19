import copy
import gzip
import json
from pathlib import Path
import unittest
from lib.si_linear_audit import audit,compact,compare


class LinearIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        p=Path('research/evidence/si_linear_development_2026-09-17');assert json.loads((p/'complete.json').read_text())['complete']
        cls.records=[json.loads(gzip.decompress((p/f'case-{i}.json.gz').read_bytes())) for i in range(5)]

    def test_five_integrity_audits(self):
        for r in self.records:self.assertTrue(audit(r)['passed'])

    def corrupt(self,fn,index=0):
        r=copy.deepcopy(self.records[index]);fn(r)
        with self.assertRaises(AssertionError):audit(r)

    def test_response_version(self):self.corrupt(lambda r:r.__setitem__('responseVersion','held-input'))
    def test_response_value(self):self.corrupt(lambda r:r['trace'][2].__setitem__(16,.01))
    def test_readout(self):self.corrupt(lambda r:r['trace'][64].__setitem__(20,.1))
    def test_input(self):self.corrupt(lambda r:r['trace'][10].__setitem__(12,.05))
    def test_label(self):self.corrupt(lambda r:r['controls'][0]['measurement']['localInletReadings'][0].__setitem__('channel','aft'))
    def test_motion(self):self.corrupt(lambda r:r['segments'][0].__setitem__('moveSeconds',.01))

    def test_blank_triplet(self):
        group=[]
        for r in self.records[:3]:
            d=compact(r);d['schedule']=audit(r)['schedule'];group.append(d)
        self.assertTrue(compare(group)['passed'])


if __name__=='__main__':unittest.main()
