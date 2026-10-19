import unittest

from m57_soil_convergence_audit import audit, build


class AuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.report = audit()

    def test_frozen_case_geometry_and_labels(self):
        config = build(32, 16)
        self.assertEqual(len(config.soils), 512)
        self.assertTrue(all(i/32 >= .4375-1e-15 and (i+1)/32 <= .5625+1e-15
                            for i in config.leak_bottom_cells))
        self.assertTrue(all("Synthetic M57" in soil.provenance for soil in config.soils))

    def test_audit_preserves_passed_and_failed_predeclared_gates(self):
        self.assertFalse(self.report["verified"], self.report)
        self.assertTrue(self.report["gates"]["pressure_balance_each_level_le_1e-7"])
        self.assertTrue(self.report["gates"]["mass_balance_each_run_le_1e-12_kg_m"])
        self.assertTrue(self.report["gates"]["fine_timestep_outputs_within_2_percent"])
        self.assertFalse(self.report["gates"]["medium_fine_pressure_outputs_within_5_percent_or_0p01m"])
        self.assertFalse(self.report["gates"]["medium_fine_transport_outputs_within_8_percent"])

    def test_audit_keeps_physical_claim_boundary(self):
        self.assertIn("not physical validation", self.report["status"])


if __name__ == "__main__":
    unittest.main()
