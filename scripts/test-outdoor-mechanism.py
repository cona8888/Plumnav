#!/usr/bin/env python3
import math
import unittest
import numpy as np
from lib.outdoor_mechanism import alarm, filtered, ideal, paired, clock


def sensor(**changes):
    return dict(dict(noisePpm=.2, riseSeconds=.5, recoverySeconds=1,
                     delaySeconds=1, sampleSeconds=1, saturationPpm=10000), **changes)


class MechanismTest(unittest.TestCase):
    def test_analytic_step_and_delay(self):
        values = filtered(np.full(40, 4.), .25, sensor())
        expected = [2.] + [4-2*math.exp(-t/.5) for t in range(1, 10)]
        np.testing.assert_allclose(values, expected, atol=1e-14)

    def test_recovery_and_continuous_memory(self):
        values = filtered(np.r_[np.full(16, 4.), np.full(24, 2.)], .25, sensor(delaySeconds=0))
        state4 = 4-2*math.exp(-4/.5)
        self.assertAlmostEqual(values[4], 2+(state4-2)*math.exp(-1), places=14)

    def test_held_interval_and_end_budget(self):
        x = np.full(20, 2.); x[-9:] = 4.
        s = sensor()
        np.testing.assert_array_equal(ideal(x, .25, s, False), [2, 2, 4, 4, 4])
        np.testing.assert_array_equal(ideal(x, .25, s, True), [2, 2, 2, 4, 4])
        self.assertEqual(alarm(ideal(x, .25, s, False), 3), 5)
        self.assertIsNone(alarm(ideal(x, .25, s, True), 3))

    def test_strict_and_persistence(self):
        self.assertIsNone(alarm([3, 3, 3, 3], 3))
        self.assertIsNone(alarm([4, 4, 2, 4, 4], 3))
        self.assertEqual(alarm([2, 4, 4, 4], 3), 4)
        self.assertIsNone(alarm([4, 4], 3))

    def test_noise_before_clip(self):
        s = sensor(delaySeconds=0, saturationPpm=3, noisePpm=1)
        got = filtered(np.full(16, 10.), .25, s, [-5]*4)
        self.assertTrue(np.all(got == 3.))
        self.assertTrue(np.all(filtered(np.full(16, 2.), .25, s, [-10]*4) == 0))

    def test_filter_can_add_three_sample_event(self):
        s = sensor(delaySeconds=0, riseSeconds=.01, recoverySeconds=10)
        x = np.r_[np.full(4, 5.), np.full(36, 2.)]
        self.assertIsNone(alarm(ideal(x, .25, s, False), 3))
        self.assertEqual(alarm(filtered(x, .25, s), 3), 3)

    def test_filter_can_remove_three_sample_event(self):
        s = sensor(delaySeconds=0, riseSeconds=10, recoverySeconds=20)
        x = np.r_[np.full(12, 3.1), np.full(28, 2.)]
        self.assertEqual(alarm(ideal(x, .25, s, False), 3), 3)
        self.assertIsNone(alarm(filtered(x, .25, s), 3))

    def test_non_nested_paired_counts(self):
        p = paired([True, True, False, False], [True, False, True, False], [1, 2, 3, 4])
        self.assertEqual([p[s]['count'] for s in ['both', 'leftOnly', 'rightOnly', 'neither']], [1]*4)
        self.assertEqual(p['rightOnly']['worlds'], [3])

    def test_invalid_clock_and_values(self):
        for args in [(0, 1, 1, 4), (.3, 1, 1, 10), (.25, 1, 1, 3)]:
            with self.assertRaises(ValueError):
                clock(*args)
        with self.assertRaises(ValueError):
            filtered([2, 2, float('nan'), 2], .25, sensor())
        with self.assertRaises(ValueError):
            filtered([2]*4, .25, sensor(), [])


if __name__ == '__main__':
    unittest.main()
