"""Numerical verification tests for the 2-D frozen-moisture cross-section."""

from dataclasses import replace
import unittest

from m54_soil_closure import SoilClosure
from m56_soil_cross_section import (CrossSectionConfig, PressureField, advance, initial_state,
                                    solve_pressure, stored_mass, surface_flux_summary)


def soil(k=1e-11, phi=.4, kx=None, kz=None):
    kx = k if kx is None else kx
    kz = k if kz is None else kz
    return SoilClosure((kx, k, kz), phi, .05, .02, 3, 2,
                       "Synthetic M56 verification material; not a field soil")


def case(nx=12, nz=8, leak=None, dp=100., concentration=1., diffusivity=1e-6):
    material = soil()
    leak = tuple(range(nx)) if leak is None else tuple(leak)
    return CrossSectionConfig(1., 1., nx, nz, (material,)*(nx*nz), (.2,)*(nx*nz),
                              leak, 1e-5, diffusivity, 101325.+dp, 101325.,
                              concentration, 0.)


class CrossSectionTests(unittest.TestCase):
    def test_full_width_homogeneous_reduces_to_one_dimensional_darcy_flow(self):
        config = case()
        pressure = solve_pressure(config)
        krg = config.soils[0].relative_permeability(.2)[1]
        expected = config.soils[0].intrinsic_k_m2[2]*krg*100/(config.gas_viscosity_pa_s*config.depth_m)
        integrated, centroid = surface_flux_summary(config, pressure)
        self.assertAlmostEqual(integrated/config.width_m, expected, delta=expected*2e-9)
        self.assertAlmostEqual(centroid, .5, delta=1e-12)

    def test_pressure_flow_is_conservative_and_local_patch_is_symmetric(self):
        config = case(nx=15, leak=(7,))
        pressure = solve_pressure(config)
        dx = config.width_m/config.nx
        bottom = sum(pressure.qz_m_s[:config.nx])*dx
        top, centroid = surface_flux_summary(config, pressure)
        self.assertAlmostEqual(bottom, top, delta=abs(top)*2e-8)
        self.assertAlmostEqual(centroid, .5, delta=2e-8)
        surface = pressure.qz_m_s[config.nz*config.nx:]
        for i in range(config.nx):
            self.assertAlmostEqual(surface[i], surface[-1-i], delta=max(surface)*2e-8)

    def test_wet_low_mobility_cap_displaces_surface_flow(self):
        config = case(nx=16, nz=10, leak=(7, 8))
        soils = list(config.soils)
        saturation = list(config.water_saturation)
        for iz in (8, 9):
            for ix in range(0, 10):
                index = iz*config.nx+ix
                soils[index] = soil(1e-13)
                saturation[index] = .85
        heterogeneous = replace(config, soils=tuple(soils), water_saturation=tuple(saturation))
        _, homogeneous_centroid = surface_flux_summary(config, solve_pressure(config))
        flow, displaced_centroid = surface_flux_summary(heterogeneous, solve_pressure(heterogeneous))
        self.assertGreater(flow, 0)
        self.assertGreater(displaced_centroid, homogeneous_centroid+.08)

    def test_blank_transport_remains_zero(self):
        config = case(concentration=0.)
        result = advance(config, solve_pressure(config), initial_state(config), 100)
        self.assertEqual(result.stored_mass_kg_m, 0)
        self.assertEqual(result.state.cumulative_leak_input_kg_m, 0)
        self.assertEqual(result.state.cumulative_surface_output_kg_m, 0)

    def test_transport_mass_is_conserved_over_repeated_steps(self):
        config = case(nx=10, nz=8, leak=(4, 5))
        pressure = solve_pressure(config)
        state = initial_state(config)
        for _ in range(10):
            result = advance(config, pressure, state, 25)
            state = result.state
            self.assertLess(abs(result.mass_balance_error_kg_m), 2e-14)
        expected = state.cumulative_leak_input_kg_m-state.cumulative_surface_output_kg_m
        self.assertAlmostEqual(stored_mass(config, state.concentration_kg_m3_gas), expected,
                               delta=3e-13)

    def test_transport_and_pressure_symmetry(self):
        config = case(nx=11, nz=7, leak=(5,))
        result = advance(config, solve_pressure(config), initial_state(config), 500)
        for iz in range(config.nz):
            row = result.state.concentration_kg_m3_gas[iz*config.nx:(iz+1)*config.nx]
            for ix in range(config.nx):
                self.assertAlmostEqual(row[ix], row[-1-ix], delta=1e-11)

    def test_full_width_pressure_grid_refinement_is_invariant(self):
        values = []
        for nx, nz in ((8, 6), (16, 12), (32, 24)):
            config = case(nx=nx, nz=nz)
            values.append(surface_flux_summary(config, solve_pressure(config))[0])
        self.assertLess(max(values)-min(values), max(values)*3e-9)

    def test_directional_permeability_changes_lateral_spread_not_1d_vertical_limit(self):
        config = case(nx=21, nz=12, leak=(10,))
        low_x = replace(config, soils=(soil(kx=1e-13, kz=1e-11),)*(config.nx*config.nz))
        high_x = replace(config, soils=(soil(kx=1e-9, kz=1e-11),)*(config.nx*config.nz))
        p_low, p_high = solve_pressure(low_x), solve_pressure(high_x)
        dx = config.width_m/config.nx
        def variance(pressure):
            surface = pressure.qz_m_s[config.nz*config.nx:]
            total = sum(surface)
            return sum(q*((i+.5)*dx-.5)**2 for i, q in enumerate(surface))/total
        self.assertGreater(variance(p_high), 5*variance(p_low))
        full = tuple(range(config.nx))
        full_low = solve_pressure(replace(low_x, leak_bottom_cells=full))
        full_high = solve_pressure(replace(high_x, leak_bottom_cells=full))
        self.assertAlmostEqual(surface_flux_summary(low_x, full_low)[0],
                               surface_flux_summary(high_x, full_high)[0],
                               delta=surface_flux_summary(low_x, full_low)[0]*2e-8)

    def test_surface_flux_is_spatial_not_a_buried_coordinate(self):
        config = case(nx=14, nz=8, leak=(2, 3))
        pressure = solve_pressure(config)
        flow, centroid = surface_flux_summary(config, pressure)
        buried_centroid = sum((i+.5)/config.nx for i in config.leak_bottom_cells)/len(config.leak_bottom_cells)
        self.assertGreater(flow, 0)
        self.assertNotEqual(tuple(pressure.qz_m_s[config.nz*config.nx:]), (flow,))
        self.assertGreater(abs(centroid-buried_centroid), 1e-3)

    def test_invalid_shapes_and_unconverged_solve_fail_closed(self):
        config = case()
        for change in ({"soils": config.soils[:-1]}, {"water_saturation": (1.,)*(config.nx*config.nz)},
                       {"leak_bottom_cells": ()}, {"leak_pressure_pa": 1.}):
            with self.assertRaises((ValueError, TypeError)):
                replace(config, **change)
        with self.assertRaises(ValueError):
            solve_pressure(config, maximum_iterations=1, tolerance_pa=1e-30)
        with self.assertRaises(ValueError):
            advance(config, solve_pressure(config), initial_state(config), -1)

    def test_pressure_field_is_immutable_and_nonfinite_fields_are_rejected(self):
        config = case()
        pressure = solve_pressure(config)
        values = list(pressure.pressure_pa)
        copied = PressureField(values, pressure.qx_m_s, pressure.qz_m_s,
                               pressure.iterations, pressure.maximum_update_pa)
        values[0] = -1
        self.assertEqual(copied.pressure_pa[0], pressure.pressure_pa[0])
        with self.assertRaises(ValueError):
            PressureField((float("nan"),), (0,), (0,), 1, 0)


if __name__ == "__main__":
    unittest.main()
