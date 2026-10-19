#!/usr/bin/env python3
import copy
import gzip
import json
import math
import unittest
from pathlib import Path
import numpy as np
from lib.si_turn_motion_audit import resolved_turn
from lib.si_turn_audit import audit,compact,compare


class TurnTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root=Path('research/evidence/si_turn_development_2026-09-17');assert json.loads((root/'complete.json').read_text())['complete']
        cls.records=[json.loads(gzip.decompress((root/f'case-{i}.json.gz').read_bytes())) for i in range(5)]
        cls.fixtures=json.loads((root/'turn-fixtures.json').read_text())

    def test_all_five_histories(self):
        for r in self.records:self.assertTrue(audit(r)['passed'])

    def test_cross_language_turn_fixtures(self):
        for f in self.fixtures['turnFixtures']:
            delta,tie,tolerance=resolved_turn(f['desired'],f['heading'])
            self.assertEqual(tie,f['antipodalTie']);self.assertAlmostEqual(delta,f['delta'],places=12);self.assertEqual(tolerance,f['tolerance'])

    def test_envelope(self):
        for h in [1025,-1025,float('nan')]:
            with self.assertRaises(AssertionError):resolved_turn(0,h)

    def corrupt(self,change,index=0):
        r=copy.deepcopy(self.records[index]);change(r)
        with self.assertRaises(AssertionError):audit(r)

    def test_wrong_turn_sign(self):
        self.corrupt(lambda r:next(s for s in r['segments'] if s['turnSeconds']>.01).__setitem__('angularVelocity',-.123))

    def test_wrong_resolved_antipode(self):
        def change(r):
            s=next(s for s in r['segments'] if s['antipodalTie']);s['angularVelocity']*=-1
        self.corrupt(change,3)

    def test_tie_flag(self):self.corrupt(lambda r:r['segments'][0].__setitem__('antipodalTie',not r['segments'][0]['antipodalTie']))
    def test_tolerance(self):self.corrupt(lambda r:r['segments'][0].__setitem__('angularTolerance',.001))
    def test_intermediate_heading(self):self.corrupt(lambda r:r['trace'][1].__setitem__(3,r['trace'][1][3]+.1))
    def test_inlet_swap(self):
        def change(r):r['trace'][1][4:8]=r['trace'][1][6:8]+r['trace'][1][4:6]
        self.corrupt(change)
    def test_channel_labels(self):self.corrupt(lambda r:r['controls'][0]['measurement']['localInletReadings'][0].__setitem__('channel','aft'))
    def test_filtered_value(self):self.corrupt(lambda r:r['trace'][1].__setitem__(16,.01))
    def test_readout_value(self):self.corrupt(lambda r:r['trace'][1].__setitem__(20,.01))
    def test_motion(self):self.corrupt(lambda r:r['segments'][0].__setitem__('moveSeconds',.01))

    def group(self):
        group=[]
        for r in self.records[:3]:
            d=compact(r);d['schedule']=audit(r)['schedule'];group.append(d)
        return group

    def test_blank_directional_invariance(self):
        group=self.group();result=compare(group);self.assertTrue(result['passed'])
        for r in group[1:]:np.testing.assert_array_equal(group[0]['directional'],r['directional'])

    def test_mean_cancellation_does_not_pass(self):
        group=self.group();group[2]['directional'][:,16]+=.01;group[2]['directional'][:,17]-=.01
        r=compare(group);self.assertTrue(r['gates']['scalarDifference']);self.assertFalse(r['gates']['all:readoutC0:0:absolute']);self.assertFalse(r['passed'])

    def test_heading_gate(self):
        g=self.group();g[2]['directional'][:,3]+=math.pi;r=compare(g);self.assertFalse(r['gates']['all:heading'])

    def test_inlet_offset_gate(self):
        g=self.group();g[2]['directional'][:,4]+=.002/g[2]['domainMetres'];self.assertFalse(compare(g)['gates']['all:inletOffset'])

    def test_filtered_gate(self):
        g=self.group();g[2]['directional'][:,12]+=.004;self.assertFalse(compare(g)['gates']['all:filteredC0:0:absolute'])

    def test_phase_cannot_disappear(self):
        g=self.group();g[2]['phaseLabels'][10:20]='retained';self.assertFalse(compare(g)['gates']['retained:presence'])


if __name__=='__main__':unittest.main()
