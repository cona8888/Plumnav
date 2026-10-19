#!/usr/bin/env python3
"""Negative document guards, not simulator or statistical tests."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('v3', ROOT/'scripts/check-closeout-draft-v3.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class DraftTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = (mod.DRAFT/'manuscript_v3.md').read_text()
        cls.appendix = (mod.DRAFT/'methods_appendix.md').read_text()
        cls.log = (mod.DRAFT/'revision_record.md').read_text()
        cls.summary, cls.predicate = mod.inputs()

    def run_check(self, text=None, appendix=None, log=None):
        return mod.check_text(self.text if text is None else text,
                             self.appendix if appendix is None else appendix,
                             self.log if log is None else log,
                             self.summary, self.predicate)

    def test_accepted(self):
        self.assertEqual(self.run_check()['reviewDispositions'], 24)

    def test_long_abstract(self):
        with self.assertRaises(ValueError):
            self.run_check(text=self.text.replace('## Abstract\n', '## Abstract\n'+'extra '*201))

    def test_outcome_corruption(self):
        row = mod.outcome_row(self.summary['rows'][0])
        with self.assertRaises(ValueError):
            self.run_check(text=self.text.replace(row, row.replace('| 24 |', '| 23 |', 1)))

    def test_resource_corruption(self):
        row = mod.resource_row(self.summary['rows'][0])
        with self.assertRaises(ValueError):
            self.run_check(appendix=self.appendix.replace(row, row.replace('875.4', '875.5')))

    def test_readout_contract_missing(self):
        with self.assertRaises(ValueError):
            self.run_check(text=self.text.replace('deliberately imposed motion–readout contract', 'scan'))

    def test_background_missing(self):
        with self.assertRaises(ValueError):
            self.run_check(text=self.text.replace('exactly zero background reference', 'reference'))

    def test_endpoint_hierarchy_missing(self):
        with self.assertRaises(ValueError):
            self.run_check(text=self.text.replace('prospectively primary scheduling outcomes', 'outcomes'))

    def test_old_fresh_boundary_missing(self):
        with self.assertRaises(ValueError):
            self.run_check(text=self.text.replace('not a new diagnostic of the 32 Stage 2i worlds', 'a new diagnostic'))

    def test_predicate_changed(self):
        with self.assertRaises(ValueError):
            self.run_check(appendix=self.appendix.replace('moved >= 0.024', 'moved >= 0.025'))

    def test_missing_disposition(self):
        with self.assertRaises(ValueError):
            self.run_check(log=self.log.replace('| P6 |', '| P7 |'))


if __name__ == '__main__':
    unittest.main()
