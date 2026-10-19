import unittest

from m60_soil_regimes import build_regimes


class SoilRegimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = build_regimes()

    def test_six_cases_and_numerical_acceptance(self):
        self.assertEqual(self.result["case_count"], 6)
        self.assertTrue(all(self.result["acceptance"].values()))

    def test_water_saturation_reduces_surface_delivery(self):
        for texture in ("sand", "clay"):
            fluxes = [row["surface_flux_normalized_tracer_kg_m2_s"]
                      for row in self.result["cases"] if row["texture"] == texture]
            self.assertTrue(all(a > b for a, b in zip(fluxes, fluxes[1:])))

    def test_emission_bridge_is_dimensionless_and_referenced(self):
        rows = {row["case_id"]: row for row in self.result["cases"]}
        self.assertAlmostEqual(rows["sand-sw-0p2"]["emission_scale_relative_to_sand_sw_0p2"], 1.0)
        self.assertGreater(rows["sand-sw-0p8"]["emission_scale_relative_to_sand_sw_0p2"],
                           rows["clay-sw-0p8"]["emission_scale_relative_to_sand_sw_0p2"])


if __name__ == "__main__":
    unittest.main()
