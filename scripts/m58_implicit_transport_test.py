from dataclasses import replace
import unittest

from m54_soil_closure import SoilClosure, bulk_diffusivity_mq
from m56_soil_cross_section import CrossSectionConfig
from m56_soil_cross_section import advance, initial_state, solve_pressure
from m57_soil_convergence_audit import build
from m58_implicit_transport import advance_implicit


class ImplicitTests(unittest.TestCase):
    def test_diffusion_only_approaches_analytical_linear_steady_flux(self):
        nx, nz = 4, 12
        material = SoilClosure((1e-11, 1e-11, 1e-11), .4, .05, .02, 3, 2,
                               "Synthetic M58 analytical diffusion witness")
        config = CrossSectionConfig(1., 1., nx, nz, (material,)*(nx*nz), (.2,)*(nx*nz),
                                    tuple(range(nx)), 1e-5, 1e-6, 101325., 101325., 1., 0.)
        pressure, state = solve_pressure(config), initial_state(config)
        result = advance_implicit(config, pressure, state, 3e7, maximum_timestep_s=1e5)
        surface_rate = sum(result.surface_flux_kg_m2_s)/nx
        expected = bulk_diffusivity_mq(.4, .8, 1e-6)
        self.assertAlmostEqual(surface_rate, expected, delta=.01*expected)

    def test_blank_and_zero_duration(self):
        config = replace(build(16, 8), leak_concentration_kg_m3_gas=0.)
        pressure, state = solve_pressure(config), initial_state(config)
        zero = advance_implicit(config, pressure, state, 0)
        self.assertEqual(zero.state, state)
        result = advance_implicit(config, pressure, state, 1000)
        self.assertEqual(result.stored_mass_kg_m, 0)
        self.assertEqual(result.mass_balance_error_kg_m, 0)

    def test_large_step_is_positive_and_conservative(self):
        config = build(16, 8)
        result = advance_implicit(config, solve_pressure(config), initial_state(config), 5000)
        self.assertTrue(all(value >= 0 for value in result.state.concentration_kg_m3_gas))
        self.assertLess(abs(result.mass_balance_error_kg_m), 2e-10)
        self.assertEqual(result.time_steps, 1)

    def test_small_step_agrees_with_explicit_transport(self):
        config = build(16, 8)
        pressure, state = solve_pressure(config), initial_state(config)
        explicit = advance(config, pressure, state, 20, maximum_substep_s=.5)
        implicit = advance_implicit(config, pressure, state, 20, maximum_timestep_s=.5)
        scale = max(explicit.stored_mass_kg_m, implicit.stored_mass_kg_m, 1e-15)
        self.assertLess(abs(explicit.stored_mass_kg_m-implicit.stored_mass_kg_m)/scale, .01)
        self.assertLess(abs(explicit.state.cumulative_surface_output_kg_m-
                            implicit.state.cumulative_surface_output_kg_m), 1e-8)

    def test_backward_euler_timestep_refinement(self):
        config = build(16, 8)
        pressure, state = solve_pressure(config), initial_state(config)
        coarse = advance_implicit(config, pressure, state, 1000, maximum_timestep_s=100)
        fine = advance_implicit(config, pressure, state, 1000, maximum_timestep_s=50)
        scale = max(fine.stored_mass_kg_m, 1e-15)
        self.assertLess(abs(coarse.stored_mass_kg_m-fine.stored_mass_kg_m)/scale, .02)

    def test_strict_tolerance_reduces_mass_residual(self):
        config = build(12, 8)
        pressure, state = solve_pressure(config), initial_state(config)
        loose = advance_implicit(config, pressure, state, 100, linear_tolerance_kg_m3=1e-7)
        strict = advance_implicit(config, pressure, state, 100, linear_tolerance_kg_m3=1e-12)
        self.assertLessEqual(abs(strict.mass_balance_error_kg_m),
                             abs(loose.mass_balance_error_kg_m)+1e-16)

    def test_invalid_solver_inputs_fail_closed(self):
        config = build(12, 8)
        pressure, state = solve_pressure(config), initial_state(config)
        for kwargs in ({"duration_s": -1}, {"duration_s": 1, "maximum_timestep_s": 0},
                       {"duration_s": 1, "linear_tolerance_kg_m3": 0},
                       {"duration_s": 1, "maximum_linear_iterations": 1}):
            with self.assertRaises(ValueError):
                advance_implicit(config, pressure, state, **kwargs)


if __name__ == "__main__":
    unittest.main()
