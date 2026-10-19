#!/usr/bin/env python3
import copy
import importlib.util
import unittest
from pathlib import Path
import numpy as np

spec=importlib.util.spec_from_file_location('budget',Path(__file__).with_name('audit-outdoor-budget.py'))
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)


class BudgetTest(unittest.TestCase):
    def test_design_and_seed_separation(self):
        cases=b.expected_specs();self.assertEqual(len(cases),24)
        self.assertEqual(sum(s['resolution']==0 for s in cases),16)
        worlds=list(range(4))+list(range(1000,1128))+list(range(200,204))+list(range(2000,2128))
        seeds=[base+17*w for w in worlds for base in [927001,1927001]]
        self.assertEqual(len(seeds),len(set(seeds)))

    def test_route(self):
        for speed,end in [(.5,2016),(1,1026)]:
            p,d=b.pilot.route_at(np.array([0,600,end-1,end,end+1]),speed)
            self.assertEqual(b.duration(speed),end);np.testing.assert_array_equal(p[-2:],[p[-1],p[-1]])
            np.testing.assert_array_equal(p[-1],[5,95,.05]);self.assertEqual(d[-1],990)
            self.assertEqual(d[2],990-speed)

    def test_late_alarm_prefix_and_corruption(self):
        y=np.full(1026,2.);y[600:603]=4
        m=dict(outcomes=[dict(budgetSeconds=600,alarmSeconds=None,restrictedTimeSeconds=600,distanceMetres=580),
            dict(budgetSeconds=1026,alarmSeconds=603,restrictedTimeSeconds=603,distanceMetres=990)])
        b.check_outcomes(m,y,1)
        for field,value in [('alarmSeconds',600),('distanceMetres',980),('budgetSeconds',1025)]:
            altered=copy.deepcopy(m);altered['outcomes'][1][field]=value
            with self.assertRaises(ValueError):b.check_outcomes(altered,y,1)

    def test_clock_and_memory_prefix(self):
        s=next(s for s in b.pilot.models() if s['noisePpm']==.2 and s['riseSeconds']==5)
        y=np.full(2016*4,2.);y[2390:2450]=5;n=b.pilot.expected_noise(200,2016)
        full=b.pilot.replay(y,.25,s,n)
        np.testing.assert_array_equal(full[:600],b.pilot.replay(y[:2400],.25,s,n[:600]))
        self.assertNotEqual(full[600],b.pilot.replay(y[2400:],.25,s,n[600:])[0])

    def test_unscaled_drift_bound(self):
        self.assertAlmostEqual(.05+.05*1026/600,.1355)
        self.assertAlmostEqual(.05+.05*2016/600,.218)
        for w in range(200,204):
            world=b.pilot.expected_world(w)
            self.assertTrue(1.782<=2+world['backgroundOffsetPpm']+world['backgroundDriftPpm']*2016/600<=2.218)


if __name__=='__main__':unittest.main()
