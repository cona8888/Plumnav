import unittest
from dataclasses import replace
from m54_soil_closure import (SoilClosure, bulk_diffusivity_mq, threshold_sensitivity,
                              species_flux, bulk_storage, exchange_soil_air,
                              intrinsic_from_water_conductivity)


def synthetic():
    return SoilClosure((1e-12, 2e-12, 0.5e-12), .4, .1, .05, 3, 2,
                       "Synthetic unit test only; not measured sand/silt/clay")


class SoilTests(unittest.TestCase):
    def test_material_copies_mutable_permeability_input(self):
        values = [1e-12, 2e-12, 3e-12]
        soil = replace(synthetic(), intrinsic_k_m2=values)
        values[0] = -1e-12
        self.assertEqual(soil.intrinsic_k_m2, (1e-12, 2e-12, 3e-12))
        self.assertLess(soil.darcy_flux(.5, "gas", 1e-5, (10, 0, 0))[0], 0)

    def test_hydraulic_conductivity_is_not_intrinsic_permeability(self):
        self.assertAlmostEqual(intrinsic_from_water_conductivity(1e-5, 1e-3, 1000, 10), 1e-12,
                               delta=1e-25)
        with self.assertRaises(ValueError):
            intrinsic_from_water_conductivity(1e-5, 1e-3, 0, 10)

    def test_mobility_endpoints_bounds_and_monotonicity(self):
        rows = [synthetic().relative_permeability(i/100) for i in range(101)]
        self.assertEqual(rows[0], (0, 1))
        self.assertEqual(rows[-1], (1, 0))
        self.assertTrue(all(0 <= v <= 1 for row in rows for v in row))
        self.assertTrue(all(a[0] <= b[0] and a[1] >= b[1] for a, b in zip(rows, rows[1:])))
        self.assertTrue(all(v > 0 for v in rows[50]))

    def test_independent_thresholds_overlap_and_cutoffs(self):
        self.assertEqual(threshold_sensitivity(.1, .1, 2), 0)
        self.assertEqual(threshold_sensitivity(.099, .1, 2), 0)
        self.assertGreater(threshold_sensitivity(.101, .1, 2), 0)
        self.assertGreater(threshold_sensitivity(.5, .1, 2), 0)  # gas
        self.assertGreater(threshold_sensitivity(.5, .2, 3), 0)  # water, not its complement

    def test_k_and_viscosity_scaling_and_reverse_flow(self):
        soil = synthetic()
        q = soil.darcy_flux(.5, "gas", 1e-5, (10, 0, -10))
        self.assertLess(q[0], 0)
        self.assertGreater(q[2], 0)
        doubled = replace(soil, intrinsic_k_m2=tuple(2*k for k in soil.intrinsic_k_m2))
        self.assertEqual(doubled.darcy_flux(.5, "gas", 1e-5, (10, 0, -10)), tuple(2*v for v in q))
        self.assertEqual(soil.darcy_flux(.5, "gas", 2e-5, (10, 0, -10)), tuple(v/2 for v in q))
        self.assertEqual(doubled.darcy_flux(.5, "gas", 2e-5, (10, 0, -10)), q)
        self.assertEqual(soil.darcy_flux(.5, "gas", 1e-5, (-10, 0, 10)), tuple(-v for v in q))

    def test_phase_diffusion_independent_of_intrinsic_k(self):
        self.assertEqual(bulk_diffusivity_mq(.4, 0, 1e-5), 0)
        self.assertGreater(bulk_diffusivity_mq(.4, 1, 1e-9), 0)  # dissolved path at Sw=1
        self.assertAlmostEqual(bulk_diffusivity_mq(.4, 1, 1), .4**(4/3))
        self.assertGreater(bulk_diffusivity_mq(.4, .6, 1), bulk_diffusivity_mq(.4, .3, 1))
        impermeable = replace(synthetic(), intrinsic_k_m2=(0, 0, 0))
        q = impermeable.darcy_flux(.5, "gas", 1e-5, (10, 0, 0))
        self.assertEqual(q, (0, 0, 0))
        self.assertLess(species_flux(q, 1, bulk_diffusivity_mq(.4, .5, 1e-5), (1, 0, 0))[0], 0)

    def test_zero_gas_mobility_does_not_erase_dissolved_methane(self):
        soil = synthetic()
        self.assertEqual(soil.darcy_flux(1, "gas", 1e-5, (10, 0, 0)), (0, 0, 0))
        self.assertGreater(bulk_storage(.4, 1, 0, 2), 0)
        dissolved_d = bulk_diffusivity_mq(.4, 1, 1e-9)
        self.assertLess(species_flux((0, 0, 0), 2, dissolved_d, (1, 0, 0))[0], 0)

    def test_derived_overflow_rejected(self):
        cases = (
            lambda: species_flux((1e308, 0, 0), 2, 0, (0, 0, 0)),
            lambda: exchange_soil_air(1, 1, [1e308], [2], 0),
            lambda: intrinsic_from_water_conductivity(1e308, 2, 1, 1),
            lambda: replace(synthetic(), intrinsic_k_m2=(1e308, 0, 0)).darcy_flux(
                0, "gas", .1, (10, 0, 0)),
        )
        for call in cases:
            with self.assertRaises(ValueError):
                call()
        self.assertEqual(bulk_diffusivity_mq(1e-300, 1, 1), 0)  # finite underflow, not 0/0

    def test_flux_and_storage_units_linear_scaling(self):
        self.assertEqual(species_flux((0, 0, 0), 3, .1, (0, 0, 0)), (0, 0, 0))
        a = species_flux((.01, 0, 0), 2, .1, (.03, 0, 0))
        b = species_flux((.01, 0, 0), 4, .1, (.06, 0, 0))
        self.assertEqual(b, tuple(2*v for v in a))
        self.assertAlmostEqual(bulk_storage(.4, .75, 2, 4), 1.4)

    def test_interface_exchange_conserves_mass_in_both_directions(self):
        for flux in (.02, -.02, 0):
            soil, air = exchange_soil_air(2, 1, [flux, flux], [2, 3], .5)
            self.assertAlmostEqual(soil+air, 3)
            self.assertAlmostEqual(air-1, flux*5*.5)
        with self.assertRaises(ValueError):
            exchange_soil_air(0, 1, [.1], [1], 1)

    def test_invalid_and_nonfinite_rejected(self):
        for kwargs in ({"porosity": 0}, {"residual_gas": .95}, {"gas_exponent": 0},
                       {"intrinsic_k_m2": (1e-12, float("nan"), 1e-12)}, {"provenance": ""}):
            with self.assertRaises(ValueError):
                replace(synthetic(), **kwargs)
        for sw in (-.1, 1.1, float("inf"), True):
            with self.assertRaises(ValueError):
                synthetic().relative_permeability(sw)
        with self.assertRaises(ValueError):
            synthetic().darcy_flux(.5, "gas", 0, (1, 2, 3))


if __name__ == "__main__":
    unittest.main()
