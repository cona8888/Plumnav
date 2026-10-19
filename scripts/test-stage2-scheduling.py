#!/usr/bin/env python3
import copy
import gzip
import json
import unittest
from pathlib import Path
from lib.si_scheduling_audit import audit,scheduling_checks,metrics,eligible
from lib.si_scheduling_statistics import ARMS,BINARY,CONTINUOUS,summarize,wilson


class SchedulingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root=Path('research/evidence/si_scheduling_development_v2_2026-09-17');done=json.loads((root/'complete.json').read_text());assert done['complete']
        cls.records={item['file']:json.loads(gzip.decompress((root/item['file']).read_bytes())) for item in done['inventory']}
        cls.blank=cls.records['development-0.json.gz'];cls.positive=cls.records['development-3.json.gz']

    def test_all_eight_histories(self):
        for r in self.records.values():self.assertTrue(audit(r)['passed'])

    def tamper(self,change):
        r=copy.deepcopy(self.blank);change(r)
        with self.assertRaises(AssertionError):scheduling_checks(r)

    def test_fake_latch(self):self.tamper(lambda r:r['schedulingTrace'][0].__setitem__('latched',True))
    def test_fake_eligibility(self):self.tamper(lambda r:r['schedulingTrace'][0].__setitem__('eligible',True))
    def test_fake_first_time(self):self.tamper(lambda r:r['schedulingTrace'][1].__setitem__('firstEligibleTime',0))
    def test_missing_trace(self):self.tamper(lambda r:r['schedulingTrace'].pop())
    def test_premature_request(self):
        def change(r):r['controls'][0]['decision']['quadSniff']={'scanId':1};r['schedulingTrace'][0]['requestedScanId']=1
        self.tamper(change)
    def test_premature_hold(self):self.tamper(lambda r:r['segments'][0].__setitem__('held',True))
    def test_fabricated_permission(self):
        self.tamper(lambda r:r['schedulingTrace'][0].__setitem__('queries',[{'allowed':True,'originalResult':True}]))
    def test_motion_tamper(self):
        r=copy.deepcopy(self.blank);r['segments'][0]['moveSeconds']+=.01
        with self.assertRaises(AssertionError):audit(r)
    def test_readout_tamper(self):
        r=copy.deepcopy(self.blank);r['trace'][64][20]+=.01
        with self.assertRaises(AssertionError):audit(r)
    def test_clipped_not_eligible(self):
        m=copy.deepcopy(next(row['measurement'] for row in self.positive['controls'] if eligible(row['measurement'])));m['localInletReadings'][0]['saturated']=True
        self.assertFalse(eligible(m))
    def test_censoring_and_displaced_peak(self):
        m=metrics(self.blank);self.assertFalse(m['encounter']);self.assertEqual(m['restrictedEncounterSeconds'],16);self.assertEqual(m['scanHeldSeconds'],0)
        p=metrics(self.positive);self.assertTrue(p['encounter']);self.assertTrue(p['inspectionCompleted']);self.assertFalse(p['supportedExact']);self.assertFalse(p['supportedJitter'])
        self.assertGreater(self.positive['summary']['nominationSourceErrorMetres'],.1)
        self.assertTrue(all(a['decision']['reason']=='coordinate-peak-indeterminate' for a in self.positive['verification']['arms']))
    def test_supported_metrics_regression_fixture(self):
        path=Path('research/evidence/si_event_development_2026-09-16/case-0.json.gz')
        r=json.loads(gzip.decompress(path.read_bytes()));p=metrics(r)
        self.assertTrue(p['supportedExact']);self.assertTrue(p['supportedJitter'])
    def test_wilson_zero_is_not_certainty(self):
        self.assertGreater(wilson(0,16)[1],.19);self.assertLess(wilson(16,16)[0],.81)
    def test_world_bootstrap_pairing(self):
        rows=[]
        for w in range(16):
            for field in ['si-continuous','si-pulse','blank']:
                for method,policy in ARMS:
                    metric={k:False for k in BINARY};metric.update({k:float(w) for k in CONTINUOUS})
                    metric['restrictedEncounterSeconds']=600-(10 if policy=='encounter-gated' else 0)
                    rows.append(dict(spec=dict(worldIndex=w,navDt=1/16,field=field,method=method,policy=policy),metrics=metric))
        a=summarize(rows);self.assertEqual(a,summarize(rows));self.assertEqual(len(a['arms']),12)
        for p in a['pairedContrasts']:
            self.assertEqual(p['metrics']['restrictedEncounterSeconds']['bootstrapPercentile95'],[-10.,-10.]);self.assertEqual(p['metrics']['restrictedEncounterSeconds']['negativeWorlds'],16)
        with self.assertRaises(AssertionError):summarize(rows[:-1])


if __name__=='__main__':unittest.main()
