#!/usr/bin/env python3
import copy
import math
import unittest
from lib.si_pose_temporal import temporal_check, evaluate


def fixture(displaced=False):
    points = [(0.,0.)]
    for i in range(8):
        points += [(math.cos(i*math.pi/4),math.sin(i*math.pi/4)), (0.,0.)]
    if displaced:
        for i in range(0,17,2):
            points[i] = (.45*math.cos(i),.45*math.sin(i))
    return [{'closedAt': 10+i, 'samples': [{'x': x,'y': y,'value':1+.2*x-.12*x*x-.2*y*y,
               'hit': True,'clipped':False,'telemetryComplete':True} for _ in range(5)]} for i,(x,y) in enumerate(points)]


class TemporalTests(unittest.TestCase):
    def test_static_same_place(self):
        result = temporal_check(fixture())
        self.assertEqual(result['state'],'pass')
        for pair in result['pairs']:
            self.assertEqual(pair['spatialCorrectionC0'],0)
            self.assertEqual(pair['correctionAllowanceC0'],0)

    def test_displaced_static_quadratic(self):
        result = temporal_check(fixture(True))
        self.assertEqual(result['state'],'pass')
        self.assertTrue(any(abs(p['rawDifferenceC0']) > p['toleranceC0'] for p in result['pairs']))
        self.assertLess(max(p['correctedAbsoluteDifferenceC0'] for p in result['pairs']),1e-12)

    def test_heldout_change_rejected(self):
        visits = fixture(True)
        for sample in visits[0]['samples']:
            sample['value'] += .2
        result = temporal_check(visits)
        self.assertEqual(result['state'],'reject')
        self.assertEqual(result['pairs'][0]['state'],'reject')

    def test_no_heldout_concentration_leakage(self):
        visits = fixture(True)
        before = temporal_check(visits)['pairs'][0]
        for i, delta in [(0,.2),(2,-.1)]:
            for s in visits[i]['samples']:
                s['value'] += delta
        after = temporal_check(visits)['pairs'][0]
        self.assertEqual(before['spatialCorrectionC0'],after['spatialCorrectionC0'])
        self.assertEqual(before['correctionAllowanceC0'],after['correctionAllowanceC0'])
        self.assertNotIn(0,after['trainingVisits'])
        self.assertNotIn(2,after['trainingVisits'])

    def test_incomplete_and_nonfinite_fail_closed(self):
        visits = fixture()
        visits[0]['closedAt'] = None
        self.assertEqual(temporal_check(visits)['state'],'indeterminate')
        visits = fixture()
        visits[0]['samples'][0]['value'] = float('nan')
        self.assertEqual(temporal_check(visits)['state'],'indeterminate')

    def test_rank_deficient_fail_closed(self):
        visits = fixture()
        for v in visits:
            for s in v['samples']:
                s['y'] = 0
        self.assertEqual(temporal_check(visits)['state'],'indeterminate')

    def test_preserves_clipping_and_curvature(self):
        old = {'gates': {'telemetry':True,'clipped':False,'complete':True,'core':True},
               'rmse':0.,'eigenMax':0.,'peak':{'x':0.,'y':0.}}
        self.assertEqual(evaluate(fixture(),old)['reason'],'not-negative-definite')
        old['gates']['clipped'] = True
        self.assertEqual(evaluate(fixture(),old)['reason'],'clipped-required-measurement')

    def test_inputs_unchanged(self):
        visits = fixture(True)
        original = copy.deepcopy(visits)
        temporal_check(visits)
        self.assertEqual(visits,original)


if __name__ == '__main__':
    unittest.main()
