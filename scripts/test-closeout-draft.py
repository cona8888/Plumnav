#!/usr/bin/env python3
"""Regression checks for the selected-claim/structure draft guard."""
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('draft_check', Path(__file__).with_name('check-closeout-draft.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class DraftChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = mod.DRAFT.read_text()
        cls.facts = json.loads((mod.BASE/'story_v1/claim_facts.json').read_text())['facts']

    def rejected(self, text):
        self.assertNotEqual(text, self.text)
        with self.assertRaises(ValueError):
            mod.check_text(text, self.facts)

    def test_current_draft(self):
        result = mod.check_text(self.text, self.facts)
        self.assertEqual(result['abstractWordsWhitespaceCount'], 183)
        self.assertEqual(result['referenceNumbersCited'], list(range(1, 8)))

    def test_oversized_abstract(self):
        self.rejected(self.text.replace('## Abstract\n', '## Abstract\n'+'extra '*201, 1))

    def test_release_success_relabeling(self):
        self.rejected(self.text.replace('All four methods have zero supported release locations',
                                        'All four methods have many successful release locations'))

    def test_inflated_world_denominator(self):
        self.rejected(self.text.replace('all 32 missions per method as the denominator',
                                        'all 128 missions per method as the denominator'))

    def test_changed_budget_count(self):
        self.rejected(self.text.replace('alarms increase from 84/128 at 600 s',
                                        'alarms increase from 81/128 at 600 s'))

    def test_missing_review_gate(self):
        self.rejected(self.text.replace('AUTHOR GATE 2:', 'AUTHOR GATE 3:'))


if __name__ == '__main__':
    unittest.main()
