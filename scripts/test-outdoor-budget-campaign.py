#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('campaign',Path(__file__).with_name('audit-outdoor-budget-campaign.py'))
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)


class CampaignTest(unittest.TestCase):
    def test_case_inventory(self):
        rows=c.expected_specs('campaign');self.assertEqual(len(rows),544)
        self.assertEqual(sum(r['resolution']==0 for r in rows),512)
        self.assertEqual({r['world'] for r in rows},set(range(2000,2128)))
        self.assertEqual({r['world'] for r in rows if r['resolution']>0},{2000,2042,2085,2127})
        self.assertEqual(len(c.expected_specs('smoke')),4)
        with self.assertRaises(ValueError):c.expected_specs('bad')

    def test_blank_digest_catches_timing_and_reading_changes(self):
        a=[dict(readings=[2,2,3],outcomes=[dict(alarmSeconds=3)])]
        self.assertNotEqual(c.digest(a),c.digest([dict(readings=[2,3,3],outcomes=[dict(alarmSeconds=3)])]))
        self.assertNotEqual(c.digest(a),c.digest([dict(readings=[2,2,3],outcomes=[dict(alarmSeconds=None)])]))

    def test_full_design_matches_reserved_development_contract(self):
        self.assertEqual(c.CAMPAIGN['worlds'],c.development.BUDGET['reservedWorldRange'])
        self.assertEqual(c.CAMPAIGN['witnessWorlds'],c.development.BUDGET['reservedWitnessWorlds'])
        self.assertEqual(c.CAMPAIGN['primary']['endpoints'],['additional-detection','additional-blank-alarm'])


if __name__=='__main__':unittest.main()
