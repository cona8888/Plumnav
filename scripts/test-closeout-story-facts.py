#!/usr/bin/env python3
"""Small extraction-contract checks; no simulations or statistical refitting."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'story_facts', Path(__file__).with_name('build-closeout-story-facts.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class StoryFactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((mod.BASE/'evidence/figure_data.json').read_text())
        cls.saved = json.loads((mod.BASE/'story_v1/claim_facts.json').read_text())

    def test_saved_facts_match_frozen_parent(self):
        self.assertEqual(mod.sha(mod.BASE/'evidence/figure_data.json'), mod.DATA_SHA)
        self.assertEqual(mod.derive(self.data), self.saved['facts'])
        self.assertFalse(self.saved['newSimulation'])
        self.assertTrue(self.saved['worldSetsMustRemainSeparate'])

    def test_world_denominators_rejected(self):
        for study, key in [('stage2i', 'independentPairedWorlds'),
                           ('screen', 'independentWorldsPerSetting'),
                           ('budget', 'independentWorldsPerSetting')]:
            with self.subTest(study=study):
                data = copy.deepcopy(self.data)
                data[study][key] += 1
                with self.assertRaises(AssertionError):
                    mod.derive(data)

    def test_support_cannot_be_relabeled_release_success(self):
        data = copy.deepcopy(self.data)
        row = data['stage2i']['rows'][3]
        row['binary']['supportedReleaseWithinPointOne'] = row['binary']['supportedExact']
        with self.assertRaises(AssertionError):
            mod.derive(data)

    def test_replay_cannot_create_independent_worlds(self):
        data = copy.deepcopy(self.data)
        data['mechanism']['newIndependentWorlds'] = 128
        with self.assertRaises(AssertionError):
            mod.derive(data)

    def test_late_event_or_blank_count_change_rejected(self):
        for i in [0, 1]:
            with self.subTest(primary=i):
                data = copy.deepcopy(self.data)
                data['budget']['primary'][i]['lateAlarms'] += 1
                with self.assertRaises(AssertionError):
                    mod.derive(data)


if __name__ == '__main__':
    unittest.main()
