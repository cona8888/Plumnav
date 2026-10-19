#!/usr/bin/env python3
import copy
import math
import unittest
from lib.si_stationary_dwell import dwell_check


def visits(values=None):
    values=values or [1.]*5
    return [{'closedAt':float(i*20+4),'samples':[{'time':float(i*20+j),'x':0.,'y':0.,'value':v} for j,v in enumerate(values)]} for i in range(17)]


class DwellTests(unittest.TestCase):
    def test_constant(self):
        self.assertEqual(dwell_check(visits())['state'],'pass')

    def test_changed_reading(self):
        result=dwell_check(visits([1.,1.1,1.2,1.1,1.]))
        self.assertEqual(result['state'],'reject')
        self.assertEqual(result['windows'][0]['reason'],'measurement-window-variation')

    def test_relaxation_not_unique_plume_diagnosis(self):
        result=dwell_check(visits([1-.4*math.exp(-j/2) for j in range(5)]))
        self.assertEqual(result['state'],'reject')
        self.assertNotIn('source',result['windows'][0]['reason'])

    def test_small_and_large_alternating_noise(self):
        self.assertEqual(dwell_check(visits([1,1.001,.999,1.001,.999]))['state'],'pass')
        self.assertEqual(dwell_check(visits([1,1.05,.95,1.05,.95]))['state'],'reject')

    def test_movement_is_indeterminate(self):
        v=visits();v[0]['samples'][2]['x']=.01
        self.assertEqual(dwell_check(v)['state'],'indeterminate')

    def test_invalid_data(self):
        v=visits();v[0]['samples'][2]['value']=float('nan')
        self.assertEqual(dwell_check(v)['state'],'indeterminate')
        v=visits();v[0]['samples'].pop()
        self.assertEqual(dwell_check(v)['state'],'indeterminate')
        self.assertEqual(dwell_check(visits()[:-1])['state'],'indeterminate')

    def test_wrong_clock(self):
        v=visits();v[0]['samples'][2]['time']+=.2
        self.assertEqual(dwell_check(v)['state'],'indeterminate')

    def test_inputs_unchanged(self):
        v=visits();before=copy.deepcopy(v);dwell_check(v)
        self.assertEqual(v,before)


if __name__=='__main__':
    unittest.main()
