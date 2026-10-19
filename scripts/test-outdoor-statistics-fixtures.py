#!/usr/bin/env python3
"""Synthetic end-to-end reporting checks, not additional field experiments."""
import unittest
from lib.outdoor_holdout_statistics import summarise


def fixture():
    traces = []
    for world in range(1000, 1128):
        for wind in [.5, 2]:
            for speed in [.5, 1]:
                measurements = []
                for rate in [0, 1e-5, 1e-4, 1e-3]:
                    for noise in [.02, .2, 2]:
                        for tau in [.5, 5]:
                            hit = rate > 0 and world % 4 >= (1 if tau == .5 else 2)
                            at = (100 if tau == .5 else 200) if hit else None
                            measurements.append(dict(sensor=dict(id=f'generic-sigma{noise:g}-tau{tau:g}'),
                                rateKgPerSecond=rate, outcomes=[dict(k=k, alarmSeconds=at,
                                    restrictedTimeSeconds=600 if at is None else at) for k in [3, 5, 7]]))
                traces.append(dict(spec=dict(world=world, wind=wind, speed=speed, resolution=0), measurements=measurements))
    return traces


class Tests(unittest.TestCase):
    def test_full_report_pairing_and_censoring(self):
        result = summarise(fixture())
        self.assertEqual(len(result['groups']), 288)
        self.assertEqual(len(result['envelopes']), 72)
        self.assertTrue(all(r['n'] == 128 for r in result['groups']))
        primary = result['primaryContrast']
        self.assertEqual(primary['alarmFractionDifference'], .25)
        self.assertEqual(primary['restrictedMeanTimeDifferenceSeconds'], -175)
        self.assertEqual(primary['fastOnly'], 32)
        self.assertEqual(primary['slowOnly'], 0)
        self.assertEqual(primary['both'], 64)
        self.assertEqual(primary['neither'], 32)
        blanks = [r for r in result['groups'] if r['rateKgPerSecond'] == 0]
        self.assertTrue(all(r['alarms'] == 0 and r['n'] == 128 for r in blanks))
        self.assertTrue(all(r['wilson95'][1] > 0 for r in blanks))
        self.assertTrue(all(not q['pointEstimateCriteriaMet'] and not q['pointwiseIntervalCriteriaMet']
                            for e in result['envelopes'] for q in e['testedRates']))

    def test_duplicate_world_never_inflates_n(self):
        rows = fixture()
        with self.assertRaises(ValueError):
            summarise(rows+[rows[0]])

    def test_missing_condition_is_rejected(self):
        with self.assertRaises(ValueError):
            summarise(fixture()[1:])


if __name__ == '__main__':
    unittest.main()
