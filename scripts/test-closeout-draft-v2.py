#!/usr/bin/env python3
"""Mutation tests for scientific boundaries in the revised idea draft."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('draftv2',ROOT/'scripts/check-closeout-draft-v2.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
TEXT=mod.DRAFT.read_text()
FACTS=json.loads((mod.BASE/'story_v1/claim_facts.json').read_text())['facts']


class RevisionChecks(unittest.TestCase):
    def rejects(self, old, new):
        self.assertIn(old,TEXT)
        with self.assertRaises((ValueError,AssertionError)):
            mod.check_text(TEXT.replace(old,new),FACTS)

    def test_baseline(self):
        self.assertLessEqual(mod.check_text(TEXT,FACTS)['abstractWords'],200)

    def test_abstract_raw_counts(self):
        self.rejects('approximately 16% to 88%','5/32 to 28/32')

    def test_nist_expansion(self):
        self.rejects('National Institute of Standards and Technology (NIST)','NIST')

    def test_methods_opening(self):
        self.rejects('PlumeNav represents the full inspection sequence:','A world is one draw:')

    def test_no_physical_validation_inflation(self):
        self.rejects('No physical calibration or validation was performed.','Physical validation was performed.')

    def test_no_release_relabel(self):
        self.rejects('All methods have zero supported release locations within 0.10 m.','Gated sampling successfully located all releases.')

    def test_gate_not_repeated(self):
        self.rejects('Once true, g remains true for the mission.','The gate resets after every scan.')

    def test_outdoor_not_algorithm_ranking(self):
        self.rejects('No closed-loop algorithm comparison was performed in the 100 m survey study.','All algorithms were compared outdoors.')


if __name__=='__main__':unittest.main()
