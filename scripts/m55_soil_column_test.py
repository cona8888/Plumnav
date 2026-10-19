"""Verification tests for the controlled frozen-moisture soil column."""

from dataclasses import replace
import unittest

from m54_soil_closure import SoilClosure
from m55_soil_column import ColumnConfig, ColumnState, advance, gas_darcy_flux, initial_state, stored_mass


def soil(k=1e-11, phi=.4, sgr=.02):
    return SoilClosure((k, k, k), phi, .05, sgr, 3, 2,
                       "Synthetic M55 verification material; not a field soil")


def config(cells=10, sw=.2, k=1e-11, dp=100., diffusivity=1e-6):
    material = soil(k)
    return ColumnConfig(1., (material,)*cells, (sw,)*cells, 1e-5, diffusivity,
                        101325.+dp, 101325., 1., 0.)


class ColumnTests(unittest.TestCase):
    def test_homogeneous_darcy_flux_matches_series_resistance(self):
        case = config(cells=4, diffusivity=0)
        krg = case.soils[0].relative_permeability(.2)[1]
        expected = case.soils[0].intrinsic_k_m2[2]*krg*100/(case.gas_viscosity_pa_s*case.depth_m)
        self.assertAlmostEqual(gas_darcy_flux(case), expected, delta=abs(expected)*1e-14)

    def test_layer_resistance_and_order_independence(self):
        a, b = soil(1e-11), soil(1e-13)
        one = replace(config(cells=2), soils=(a, b))
        two = replace(one, soils=(b, a))
        self.assertEqual(gas_darcy_flux(one), gas_darcy_flux(two))
        self.assertLess(gas_darcy_flux(one), gas_darcy_flux(replace(one, soils=(a, a))))

    def test_wetter_soil_reduces_gas_flow_and_diffusive_arrival(self):
        dry, wet = config(sw=.2, dp=0), config(sw=.8, dp=0)
        self.assertLess(gas_darcy_flux(config(sw=.8)), gas_darcy_flux(config(sw=.2)))
        # Diffusive transit over one metre is slow; use a dimensionally relevant
        # O(L²/D) observation window, not the shorter advective test duration.
        dry_result = advance(dry, initial_state(dry), 1e5)
        wet_result = advance(wet, initial_state(wet), 1e5)
        self.assertGreater(dry_result.state.concentration_kg_m3_gas[-1],
                           wet_result.state.concentration_kg_m3_gas[-1])

    def test_blank_is_exactly_blank(self):
        case = replace(config(), bottom_concentration_kg_m3_gas=0.)
        result = advance(case, initial_state(case), 500)
        self.assertEqual(result.stored_mass_kg_m2, 0)
        self.assertEqual(result.state.cumulative_bottom_input_kg_m2, 0)
        self.assertEqual(result.state.cumulative_surface_output_kg_m2, 0)

    def test_mass_conservation_across_repeated_steps(self):
        case = config(cells=12)
        state = initial_state(case)
        for _ in range(20):
            result = advance(case, state, 10)
            state = result.state
            self.assertLess(abs(result.mass_balance_error_kg_m2), 2e-15)
        expected = state.cumulative_bottom_input_kg_m2-state.cumulative_surface_output_kg_m2
        self.assertAlmostEqual(stored_mass(case, state.concentration_kg_m3_gas), expected, delta=2e-14)
        self.assertGreaterEqual(result.surface_flux_kg_m2_s, 0)

    def test_pressure_and_concentration_forcing_are_not_double_counted(self):
        diffusive = config(dp=0, diffusivity=1e-6)
        result = advance(diffusive, initial_state(diffusive), 10)
        self.assertEqual(result.darcy_flux_m_s, 0)
        self.assertGreater(result.bottom_flux_kg_m2_s, 0)
        advective_blank = replace(config(diffusivity=0), bottom_concentration_kg_m3_gas=0.)
        blank = advance(advective_blank, initial_state(advective_blank), 10)
        self.assertGreater(blank.darcy_flux_m_s, 0)
        self.assertEqual(blank.bottom_flux_kg_m2_s, 0)

    def test_surface_transfer_is_signed_and_state_is_immutable(self):
        case = replace(config(dp=0), bottom_concentration_kg_m3_gas=1.,
                       ambient_concentration_kg_m3_gas=.5)
        values = [0.0]*10
        state = ColumnState(0, values)
        values[-1] = 100
        self.assertEqual(state.concentration_kg_m3_gas[-1], 0)
        first = advance(case, state, 1)
        self.assertLess(first.surface_flux_kg_m2_s, 0)
        self.assertLess(first.state.cumulative_surface_output_kg_m2, 0)
        second = advance(case, first.state, 1)
        self.assertLess(second.state.cumulative_surface_output_kg_m2, 0)

    def test_grid_refinement_agrees_for_smooth_column(self):
        coarse, fine = config(cells=20), config(cells=40)
        a = advance(coarse, initial_state(coarse), 500)
        b = advance(fine, initial_state(fine), 500)
        scale = max(a.stored_mass_kg_m2, b.stored_mass_kg_m2, 1e-15)
        self.assertLess(abs(a.stored_mass_kg_m2-b.stored_mass_kg_m2)/scale, .03)

    def test_diffusion_only_approaches_linear_steady_flux(self):
        case = config(cells=20, dp=0, diffusivity=1e-6)
        result = advance(case, initial_state(case), 3e6)
        effective_d = case.free_diffusivity_m2_s*case.soils[0].porosity**(4/3)*(.8)**(10/3)
        expected = effective_d/case.depth_m
        self.assertAlmostEqual(result.surface_flux_kg_m2_s, expected, delta=.015*expected)
        self.assertLess(abs(result.mass_balance_error_kg_m2), 2e-14)

    def test_disconnected_gas_advection_can_retain_diffusion_or_fail_at_zero_storage(self):
        impermeable = soil(k=0)
        case = replace(config(cells=2), soils=(impermeable, impermeable), water_saturation=(.95, .95))
        self.assertEqual(gas_darcy_flux(case), 0)
        self.assertGreater(advance(case, initial_state(case), 1).bottom_flux_kg_m2_s, 0)
        saturated = replace(case, water_saturation=(1., 1.))
        with self.assertRaises(ValueError):
            advance(saturated, initial_state(saturated), 1)

    def test_invalid_and_reverse_pressure_fail_closed(self):
        case = config()
        changes = ({"depth_m": 0}, {"water_saturation": (.2,)},
                   {"gas_viscosity_pa_s": 0}, {"water_saturation": (1.1,)*10})
        for change in changes:
            with self.assertRaises((ValueError, TypeError)):
                replace(case, **change)
        with self.assertRaises(ValueError):
            advance(replace(case, bottom_pressure_pa=1, surface_pressure_pa=2), initial_state(case), 1)


if __name__ == "__main__":
    unittest.main()
