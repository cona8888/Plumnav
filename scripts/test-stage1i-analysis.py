#!/usr/bin/env python3
"""Small independent checks for the Stage 1i statistical reductions."""
import importlib.util
import copy
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("stage1i", Path(__file__).with_name("analyze-stage1i.py"))
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


class StatisticsTests(unittest.TestCase):
    def test_wilson_boundaries(self):
        self.assertAlmostEqual(analysis.wilson(0, 50)["wilson95"][1], 0.07134759913335872)
        self.assertAlmostEqual(analysis.wilson(50, 50)["wilson95"][0], 1-0.07134759913335872)
        self.assertEqual(analysis.wilson(0, 50)["count"], 0)

    def test_wilson_symmetry(self):
        left = analysis.wilson(10, 50)["wilson95"]
        right = analysis.wilson(40, 50)["wilson95"]
        self.assertAlmostEqual(left[0], 1-right[1])
        self.assertAlmostEqual(left[1], 1-right[0])

    def test_invalid_counts(self):
        for k, n in [(0, 0), (-1, 50), (51, 50)]:
            with self.assertRaises(ValueError):
                analysis.wilson(k, n)

    def test_exact_discordance(self):
        self.assertEqual(analysis.mcnemar_exact(0, 0), 1)
        self.assertEqual(analysis.mcnemar_exact(5, 5), 1)
        self.assertEqual(analysis.mcnemar_exact(6, 0), .03125)
        self.assertEqual(analysis.mcnemar_exact(0, 6), .03125)
        self.assertAlmostEqual(analysis.mcnemar_exact(50, 0), 2**-49)

    def test_holm_monotonic_and_original_order(self):
        actual = analysis.holm([.03, .001, .02, .7, .8, 1])
        expected = [.12, .006, .10, 1, 1, 1]
        for a, b in zip(actual, expected):
            self.assertAlmostEqual(a, b)

    def test_empty_supported_subset_is_not_zero_error(self):
        self.assertEqual(analysis.describe([]), {"n": 0, "min": None, "median": None, "max": None})


def synthetic_runs():
    """Synthetic reduction test data, never used as campaign evidence."""
    runs = {}

    def add(field, kind, rep, radius, structure, arm):
        i = len(runs)
        supported = field in analysis.POSITIVES and (kind == "baseline" or arm == "observed" or rep < 44)
        runs[i] = {
            "spec": {"index": i, "field": field, "kind": kind, "replicate": rep,
                     "uncertainty": {"positionRadiusMetres": radius, "positionErrorStructure": structure, "registration": arm}},
            "result": {"status": "supported" if supported else "abstained", "reason": "test-support" if supported else "test-abstention", "peak": {"x": 0, "y": 0}},
            "summary": {"completedAt": 250, "pathLengthMeters": 2, "maximumTargetOffsetMetres": radius,
                        "rmsTargetOffsetMetres": radius/2, "retainedSamples": 34, "clippedRetained": 0},
            "physicalSha256": f"test-only-{field}-{rep}-{radius}-{structure}"}

    for f in analysis.FIELDS:
        add(f, "baseline", None, 0, "independent", "observed")
    for rep in range(50):
        for radius in analysis.RADII:
            for structure in analysis.STRUCTURES:
                for f in analysis.FIELDS:
                    for arm in analysis.ARMS:
                        add(f, "position", rep, radius, structure, arm)
    return runs


class ReductionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runs = synthetic_runs()

    def test_full_factorial_reduction(self):
        baselines, strata = analysis.analyze(self.runs)
        self.assertEqual(len(baselines), 11)
        self.assertEqual(len(strata), 132)
        for r in strata:
            if r["field"] in analysis.POSITIVES:
                self.assertEqual(r["arms"]["observed"]["support"]["count"], 50)
                self.assertEqual(r["arms"]["commanded"]["lossOfBaselineSupport"]["count"], 6)
                self.assertEqual(r["paired"]["observedOnly"], 6)
                self.assertEqual(r["paired"]["commandedOnly"], 0)
                self.assertAlmostEqual(r["paired"]["supportRiskDifference"], .12)
                self.assertAlmostEqual(r["paired"]["holmWithinFieldStructureP"], .1875)
            else:
                self.assertEqual(r["arms"]["observed"]["falseSupport"]["count"], 0)
                self.assertEqual(r["paired"]["mcnemarExactTwoSidedP"], 1)

    def test_changed_physical_pair_rejected(self):
        runs = dict(self.runs)
        runs[11] = copy.deepcopy(runs[11])
        runs[11]["physicalSha256"] = "corrupted"
        with self.assertRaises(AssertionError):
            analysis.analyze(runs)

    def test_missing_arm_rejected(self):
        runs = dict(self.runs)
        del runs[11]
        with self.assertRaises(AssertionError):
            analysis.analyze(runs)

    def test_unexpected_baseline_rejected(self):
        runs = dict(self.runs)
        runs[0] = copy.deepcopy(runs[0])
        runs[0]["result"]["status"] = "abstained"
        with self.assertRaises(AssertionError):
            analysis.analyze(runs)


if __name__ == "__main__":
    unittest.main()
