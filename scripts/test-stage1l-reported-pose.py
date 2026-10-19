#!/usr/bin/env python3
import copy
import math
import unittest
from lib.si_reported_pose import transform, alternatives, unit_errors
from lib.si_stationary_dwell import dwell_check


def fixture():
    return [{'target':{'x':.5,'y':.5},'closedAt':i*20+4,'arrivedAt':i*20,
             'samples':[dict(time=i*20+j,x=i/17,y=i/34,value=1.,hit=True,clipped=False,telemetryComplete=True) for j in range(5)]} for i in range(17)]


class ReportingTests(unittest.TestCase):
    def test_design_cardinality(self):
        self.assertEqual(len(alternatives()),31)
        self.assertEqual(len({(a['model'],a['amplitudeMetres']) for a in alternatives()}),31)

    def test_exact_and_nonmutation(self):
        v=fixture();before=copy.deepcopy(v)
        self.assertEqual(transform(v,alternatives()[0],0)['visits'],v)
        for a in alternatives():
            transform(v,a,0)
        self.assertEqual(v,before)

    def test_deterministic_vectors(self):
        self.assertEqual(unit_errors(2),unit_errors(2))
        self.assertNotEqual(unit_errors(1),unit_errors(2))
        u=unit_errors(0);self.assertAlmostEqual(math.hypot(*u['direction']),1.)
        self.assertTrue(all(math.hypot(*v)<=1 for v in u['visits']))

    def test_frame_translation(self):
        v=fixture();r=transform(v,dict(model='frame-translation',amplitudeMetres=.01),0)
        for old,new in zip(v,r['visits']):
            self.assertEqual(old['samples'],new['samples'])
            for k,axis in enumerate(('x','y')):
                self.assertAlmostEqual(new['target'][axis]-old['target'][axis],r['anchorErrorMetres'][k]/100)

    def test_relative_bias(self):
        v=fixture();r=transform(v,dict(model='relative-bias',amplitudeMetres=.01),0)
        for old,new in zip(v,r['visits']):
            for s,t in zip(old['samples'],new['samples']):
                self.assertAlmostEqual(math.hypot(t['x']-s['x'],t['y']-s['y']),.1)
        self.assertEqual(dwell_check(r['visits'])['state'],'pass')

    def test_only_coordinates_and_targets_change(self):
        v=fixture()
        for a in alternatives():
            r=transform(v,a,1)
            for old,new,errors in zip(v,r['visits'],r['worldErrorsMetres']):
                self.assertEqual(old['arrivedAt'],new['arrivedAt']);self.assertEqual(old['closedAt'],new['closedAt'])
                for s,t,e in zip(old['samples'],new['samples'],errors):
                    self.assertLessEqual(math.hypot(*e),a['amplitudeMetres']+1e-14)
                    self.assertEqual({k:x for k,x in s.items() if k not in ('x','y')},{k:x for k,x in t.items() if k not in ('x','y')})

    def test_between_visit_versus_continuous_drift(self):
        a=dict(model='visit-drift',amplitudeMetres=.0001)
        self.assertEqual(dwell_check(transform(fixture(),a,0)['visits'])['state'],'pass')
        a['model']='continuous-drift'
        self.assertEqual(dwell_check(transform(fixture(),a,0)['visits'])['state'],'indeterminate')

    def test_jitter_exposes_numerical_stationarity(self):
        a=dict(model='readout-jitter',amplitudeMetres=.0001)
        self.assertEqual(dwell_check(transform(fixture(),a,0)['visits'])['state'],'indeterminate')


if __name__=='__main__':
    unittest.main()
