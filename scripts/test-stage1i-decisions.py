#!/usr/bin/env python3
import importlib.util
import math
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("decision_audit", Path(__file__).with_name("audit-stage1i-decisions.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def fixture(function, moved_center=False):
    points = [(0.,0.)]
    for i in range(8):
        points += [(math.cos(i*math.pi/4), math.sin(i*math.pi/4)), (0.,0.)]
    if moved_center:
        points[2] = (.9,0.)
    return [{"closedAt": 10+i, "samples": [{"x": x, "y": y, "value": function(x,y),
             "hit": function(x,y) >= .115, "clipped": False, "telemetryComplete": True} for _ in range(5)]}
            for i,(x,y) in enumerate(points)]


class DecisionAuditTests(unittest.TestCase):
    def test_exact_quadratic_peak(self):
        r = audit.recompute(fixture(lambda x,y: 1-.1*x*x-.2*y*y))
        self.assertEqual(r["reason"], "local-quadratic-supported")
        self.assertLess(r["rmse"], 1e-12)
        self.assertAlmostEqual(r["eigenMax"], -.2)

    def test_ridge_and_saddle_rejected(self):
        for f in [lambda x,y: 1-.1*x*x, lambda x,y: 1-.1*x*x+.1*y*y]:
            self.assertEqual(audit.recompute(fixture(f))["reason"], "not-negative-definite")

    def test_no_signal(self):
        self.assertEqual(audit.recompute(fixture(lambda x,y: 0))["reason"], "insufficient-signal")

    def test_clipping_precedes_support(self):
        visits = fixture(lambda x,y: 1-.1*x*x-.2*y*y)
        visits[0]["samples"][0]["clipped"] = True
        self.assertEqual(audit.recompute(visits)["reason"], "clipped-required-measurement")

    def test_spatial_revisit_shift_triggers_temporal_gate_in_static_field(self):
        r = audit.recompute(fixture(lambda x,y: 1-.1*x*x-.2*y*y, moved_center=True))
        self.assertEqual(r["reason"], "temporal-inconsistency")
        self.assertLess(r["rmse"], 1e-12)


if __name__ == "__main__":
    unittest.main()
