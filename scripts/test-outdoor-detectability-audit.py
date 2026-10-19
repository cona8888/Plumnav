#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location('auditor', Path(__file__).with_name('audit-outdoor-detectability.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class AuditTests(unittest.TestCase):
    def test_wilson_zero_not_zero_uncertainty(self):
        low, high = audit.wilson(0, 128)
        self.assertAlmostEqual(low, 0)
        self.assertGreater(high, .02)
        self.assertLess(high, .05)
        self.assertGreater(audit.wilson(0, 4)[1], .4)
        with self.assertRaises(ValueError):
            audit.wilson(0, 0)

    def test_alarm_end_of_streak_and_strict_threshold(self):
        self.assertEqual(audit.alarm([3, 4, 4, 4], 3), 4)
        self.assertIsNone(audit.alarm([4, 4, 2, 4, 4], 3))
        self.assertIsNone(audit.alarm([4, 4], 3))

    def test_route_turn_and_endpoint(self):
        pose, distance = audit.route_at(np.array([0., 91., 93., 10000.]), 1)
        np.testing.assert_array_equal(pose, [[5, 5, .05], [95, 5, .05], [95, 6, .05], [5, 95, .05]])
        np.testing.assert_array_equal(distance, [0, 90, 91, 990])

    def test_sensor_delay_analytic_step(self):
        sensor = {**audit.models()[0], 'noisePpm': 0, 'riseSeconds': 2, 'recoverySeconds': 4}
        y = audit.replay(np.full(16, 12.), .25, sensor, np.zeros(4))
        self.assertEqual(y[0], 2)
        self.assertAlmostEqual(y[-1], 12-10*np.exp(-1.5))

    def test_source_absent_quadrature(self):
        field = dict(source=dict(x=30., y=40., z=.025), wind=dict(x=1., y=0.), diffusivity=.2, sigma=.25, rateKgPerSecond=0.)
        self.assertEqual(audit.independent_concentration(dict(x=40., y=41., z=.05), field, 700.), 0.)

    def test_counts_and_reserved_split(self):
        self.assertEqual(len(audit.expected_specs()), 24)
        self.assertEqual(sum(s['resolution'] == 0 for s in audit.expected_specs()), 16)
        self.assertEqual(len(audit.models()), 6)
        self.assertEqual(audit.EXPECTED_DESIGN['reservedTestWorldRange'], [1000, 1127])


if __name__ == '__main__':
    unittest.main()
