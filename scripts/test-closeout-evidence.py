#!/usr/bin/env python3
"""Checks for the derived evidence assembler; no simulation or source edits."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('closeout', Path(__file__).with_name('build-closeout-evidence.py'))
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)


class EvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index, cls.data = mod.build()
        cls.stage_audit = mod.read(mod.ROOT/'research/results/si_stage2i_campaign_audit_2026-09-22/analysis.json')

    def test_studies_remain_separate(self):
        studies = {s['id']: s for s in self.index['studies']}
        self.assertEqual([studies[k]['independentWorlds'] for k in ['stage2i', 'screen', 'budget']], [32, 128, 128])
        self.assertEqual(studies['mechanism']['newIndependentWorlds'], 0)
        self.assertEqual(studies['mechanism']['worldIds'], studies['screen']['worldIds'])
        self.assertFalse(set(studies['screen']['worldIds']) & set(studies['budget']['worldIds']))
        self.assertFalse(self.index['poolingPermitted'])

    def test_stage_count_rejected(self):
        x = copy.deepcopy(self.data['stage2i']); x['rows'][0]['binary']['encounter']['successes'] += 1
        with self.assertRaises(ValueError): mod.check_stage2i(x, self.stage_audit)

    def test_source_accuracy_cannot_be_maximum_support(self):
        x = copy.deepcopy(self.data['stage2i'])
        x['rows'][3]['binary']['supportedReleaseWithinPointOne'] = x['rows'][3]['binary']['supportedExact']
        with self.assertRaises(ValueError): mod.check_stage2i(x, self.stage_audit)

    def test_stage_error_median_rejected(self):
        x = copy.deepcopy(self.data['stage2i']); x['rows'][3]['conditionalReleaseErrorMedianMetres'] = .01
        with self.assertRaises(ValueError): mod.check_stage2i(x, self.stage_audit)

    def test_screen_worlds_rejected(self):
        x = copy.deepcopy(self.data['screen']); x['groups'][0]['pairedWorlds'][0] = 2000
        with self.assertRaises(ValueError): mod.check_screen(x)

    def test_screen_interval_rejected(self):
        x = copy.deepcopy(self.data['screen']); x['groups'][0]['wilson95'][0] = 0
        with self.assertRaises(ValueError): mod.check_screen(x)

    def test_duplicate_setting_rejected(self):
        x = copy.deepcopy(self.data['screen']); x['groups'][1] = x['groups'][0]
        with self.assertRaises(ValueError): mod.check_screen(x)

    def test_budget_partition_rejected(self):
        x = copy.deepcopy(self.data['budget']); x['groups'][0]['neitherWorlds'][0] = 2128
        with self.assertRaises(ValueError): mod.check_budget(x)

    def test_budget_cap_rejected(self):
        x = copy.deepcopy(self.data['budget']); x['groups'][0]['budgets'][1]['budgetSeconds'] = 600
        with self.assertRaises(ValueError): mod.check_budget(x)

    def test_budget_pair_difference_rejected(self):
        x = copy.deepcopy(self.data['budget']); x['groups'][1]['fullMinusShortAlarmProbability'] = 0
        with self.assertRaises(ValueError): mod.check_budget(x)

    def test_hash_mismatch_rejected(self):
        with tempfile.TemporaryDirectory(prefix='plumenav-evidence-test-') as temp:
            p = Path(temp)/'example.json'; p.write_text(json.dumps({'test': True}))
            registry = mod.Sources(temp)
            with self.assertRaises(ValueError): registry.add('example.json', '0'*64)
            self.assertTrue(registry.add('example.json', mod.sha(p))['test'])

    def test_wilson_boundaries(self):
        self.assertEqual(mod.wilson(0, 128)[0], 0)
        self.assertAlmostEqual(mod.wilson(128, 128)[1], 1)
        self.assertGreater(mod.wilson(0, 128)[1], 0)


if __name__ == '__main__': unittest.main()
