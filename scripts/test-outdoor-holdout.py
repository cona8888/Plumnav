#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest
import numpy as np
from lib.outdoor_holdout_statistics import paired_summary, wilson, summarise

spec = importlib.util.spec_from_file_location('holdout_auditor', Path(__file__).with_name('audit-outdoor-holdout.py'))
auditor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auditor)


class Tests(unittest.TestCase):
    def test_design(self):
        self.assertEqual(len(auditor.specs('campaign')), 544)
        self.assertEqual(sum(s['resolution'] == 0 for s in auditor.specs('campaign')), 512)
        self.assertEqual(len(auditor.specs('smoke')), 4)
        self.assertEqual(auditor.HOLDOUT['bootstrap']['seed'], 2230922)

    def test_overlap_not_file_count(self):
        self.assertEqual(auditor.max_overlap([dict(startedMs=0, endedMs=10), dict(startedMs=10, endedMs=20)]), 1)
        self.assertEqual(auditor.max_overlap([dict(startedMs=i, endedMs=20+i) for i in range(4)]), 4)

    def test_pointwise_uncertainty(self):
        self.assertLess(wilson(0, 128)[1], .05)
        self.assertGreater(wilson(0, 4)[1], .4)
        self.assertLess(wilson(115, 128)[0], .9)
        with self.assertRaises(ValueError):
            wilson(129, 128)

    def test_paired_estimand_and_reproducibility(self):
        result = paired_summary([1, 1, 0, 0], [1, 0, 0, 0], [10, 20, 600, 600], [10, 600, 600, 600])
        self.assertEqual(result['alarmFractionDifference'], .25)
        self.assertEqual(result['restrictedMeanTimeDifferenceSeconds'], -145)
        self.assertEqual(result['fastOnly'], 1)
        self.assertEqual(result['slowOnly'], 0)
        self.assertEqual(result, paired_summary([1, 1, 0, 0], [1, 0, 0, 0], [10, 20, 600, 600], [10, 600, 600, 600]))
        reverse = paired_summary([1, 0, 0, 0], [1, 1, 0, 0], [10, 600, 600, 600], [10, 20, 600, 600])
        np.testing.assert_allclose(reverse['alarmFractionInterval975'], -np.array(result['alarmFractionInterval975'])[::-1])

    def test_bad_or_unpaired_inputs(self):
        with self.assertRaises(ValueError):
            paired_summary([1, 0], [1], [10, 600], [10, 600])
        with self.assertRaises(ValueError):
            paired_summary([1, 0], [1, 0], [10, float('nan')], [10, 600])
        with self.assertRaises(ValueError):
            summarise([])

    def test_refinement_gate(self):
        traces = []
        for world in auditor.WITNESSES:
            for wind in [.5, 2]:
                for speed in [.5, 1]:
                    for r in [0, 1, 2]:
                        traces.append(dict(spec=dict(world=world, wind=wind, speed=speed, resolution=r),
                            measurements=[dict(readings=[2., 3.], sensor=dict(noisePpm=.2),
                                               outcomes=[dict(alarmSeconds=None)])]))
        self.assertEqual(len(auditor.resolution_checks(traces)), 16)
        traces[0]['measurements'][0]['outcomes'][0]['alarmSeconds'] = 1
        with self.assertRaises(ValueError):
            auditor.resolution_checks(traces)


if __name__ == '__main__':
    unittest.main()
