from dataclasses import replace
from math import pi, sin
import unittest

from m54_soil_closure import SoilClosure
from m56_soil_cross_section import CrossSectionConfig, CrossSectionState, initial_state, solve_pressure
from m57_soil_convergence_audit import build
from m59_muscl_transport import advance_muscl
from m59_muscl_wet_cap_audit import breakthrough


def advection_case(nz):
    nx = 2
    soil = SoilClosure((1e-11, 1e-11, 1e-11), .4, .05, .02, 3, 2,
                       "Synthetic M59 exact advection witness")
    return CrossSectionConfig(1., 1., nx, nz, (soil,)*(nx*nz), (.2,)*(nx*nz),
                              tuple(range(nx)), 1e-5, 0., 101425., 101325., 0., 0.)


class MusclTests(unittest.TestCase):
    def test_blank_and_zero_duration(self):
        config = replace(build(16, 8), leak_concentration_kg_m3_gas=0.)
        pressure, state = solve_pressure(config), initial_state(config)
        self.assertEqual(advance_muscl(config, pressure, state, 0).state, state)
        result = advance_muscl(config, pressure, state, 100)
        self.assertEqual(result.stored_mass_kg_m, 0)

    def test_discontinuous_initial_field_remains_bounded(self):
        config = advection_case(40)
        values = tuple(1. if iz < 12 else 0. for iz in range(40) for _ in range(2))
        state = CrossSectionState(0., values)
        result = advance_muscl(config, solve_pressure(config), state, 500)
        self.assertGreaterEqual(result.minimum_concentration_kg_m3, 0)
        self.assertLessEqual(result.maximum_concentration_kg_m3, 1+1e-7)

    def test_mass_conservation(self):
        config = build(16, 8)
        result = advance_muscl(config, solve_pressure(config), initial_state(config), 1000)
        self.assertLess(abs(result.mass_balance_error_kg_m), 2e-13)

    def test_smooth_advection_converges_faster_than_first_order(self):
        errors = []
        for nz in (40, 80, 160):
            config = advection_case(nz)
            pressure = solve_pressure(config)
            q = pressure.qz_m_s[config.nx*config.nz]
            theta = .4*.8
            duration = .08*theta/q
            initial = tuple(sin(pi*(iz+.5)/nz)**2 for iz in range(nz) for _ in range(2))
            result = advance_muscl(config, pressure, CrossSectionState(0., initial), duration)
            error = 0.
            for iz in range(nz):
                z = (iz+.5)/nz
                exact = sin(pi*(z-.08))**2 if z >= .08 else 0.
                error += abs(result.state.concentration_kg_m3_gas[iz*2]-exact)/nz
            errors.append(error)
        order1 = __import__("math").log(errors[0]/errors[1], 2)
        order2 = __import__("math").log(errors[1]/errors[2], 2)
        self.assertGreater(order1, 1.5, errors)
        self.assertGreater(order2, 1.5, errors)

    def test_invalid_inputs_fail_closed(self):
        config = build(16, 8)
        pressure, state = solve_pressure(config), initial_state(config)
        for duration, step in ((-1, None), (1, 0)):
            with self.assertRaises(ValueError):
                advance_muscl(config, pressure, state, duration, step)
        with self.assertRaises(ValueError):
            advance_muscl(config, pressure, state, 1, bound_tolerance_kg_m3=0)

    def test_breakthrough_metric_is_explicit_and_reproducible(self):
        result = breakthrough(16, 8, sample_interval_s=100)
        self.assertEqual(result["threshold_fraction_of_q_surface_times_C_leak"], .1)
        self.assertGreater(result["crossing_time_s"], 0)
        self.assertLess(abs(result["mass_balance_error_kg_m"]), 1e-11)


if __name__ == "__main__":
    unittest.main()
