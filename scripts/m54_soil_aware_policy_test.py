"""Synthetic decision-contract tests; no simulated or physical GSL validation."""

from dataclasses import replace
import unittest

from m54_soil_aware_policy import Candidate, Evidence, PolicyConfig, SoilPrior, Window, decide


def window(start=0.0, end=2.0, signal=0.5, error=0.01, spatial=True):
    return Window(start, end, signal, error, spatial)


def candidate(name="a", windows=(), travel=0.0):
    return Candidate(name, (0.0, 0.0), windows, travel)


class PolicyTests(unittest.TestCase):
    def test_empty_or_blank_never_means_no_leak(self):
        for evidence in (Evidence(0, 0), Evidence(10, 30, survey_complete=True),
                         Evidence(10, 0, (candidate(windows=(window(signal=0),)),))):
            decision = decide(evidence)
            self.assertEqual(decision.action, "report-unresolved")
            self.assertEqual(decision.supported_observation_regions, ())

    def test_multiple_regions_are_retained_not_just_global_peak(self):
        regions = (candidate("strong", (window(signal=5), window(10, 12, signal=5))),
                   candidate("weak", (window(), window(10, 12))))
        decision = decide(Evidence(20, 0, regions, correlation_time_upper_seconds=1))
        self.assertEqual(decision.action, "report-supported-regions")
        self.assertEqual(decision.supported_observation_regions, ("strong", "weak"))

    def test_windows_must_pass_spacing_and_uncertainty_margin(self):
        close = candidate("close", (window(), window(3, 5)))
        noisy = candidate("noisy", (window(error=1), window(10, 12, error=1)))
        decision = decide(Evidence(20, 0, (close, noisy), correlation_time_upper_seconds=1))
        self.assertEqual(decision.supported_observation_regions, ())

    def test_missing_correlation_requires_evidence_not_assumed_independence(self):
        region = candidate(windows=(window(), window(10, 12)))
        decision = decide(Evidence(20, 30, (region,)))
        self.assertEqual(decision.action, "estimate-temporal-correlation")
        self.assertEqual(decision.supported_observation_regions, ())

    def test_fresh_spatial_check_required_for_positive_candidate(self):
        region = candidate(windows=(window(spatial=False),))
        decision = decide(Evidence(10, 30, (region,), correlation_time_upper_seconds=1))
        self.assertEqual(decision.action, "collect-spatial-check")
        self.assertEqual(decision.supported_observation_regions, ())

    def test_spatial_check_can_fall_between_temporal_replicates(self):
        region = candidate(windows=(window(spatial=False), window(3, 5), window(10, 12, spatial=False)))
        decision = decide(Evidence(20, 0, (region,), correlation_time_upper_seconds=1))
        self.assertEqual(decision.supported_observation_regions, ("a",))

    def test_stop_or_negative_revisit_invalidates_historical_peak(self):
        region = candidate(windows=(window(), window(10, 12), window(20, 22, signal=0)))
        decision = decide(Evidence(30, 0, (region,), correlation_time_upper_seconds=1))
        self.assertEqual(decision.supported_observation_regions, ())

    def test_stale_or_restart_evidence_requires_new_confirmation(self):
        old = candidate(windows=(window(), window(10, 12)))
        stale = decide(Evidence(100, 0, (old,), correlation_time_upper_seconds=1))
        self.assertEqual(stale.supported_observation_regions, ())
        restarted = replace(old, windows=old.windows + (window(20, 22, signal=0), window(30, 32)))
        result = decide(Evidence(35, 0, (restarted,), correlation_time_upper_seconds=1))
        self.assertEqual(result.supported_observation_regions, ())

    def test_wait_travel_and_sampling_all_count_toward_budget(self):
        region = candidate(windows=(window(8, 10),), travel=2)
        evidence = Evidence(10, 14, (region,), survey_complete=True, correlation_time_upper_seconds=2)
        decision = decide(evidence)
        self.assertEqual(decision.action, "revisit-candidate")
        self.assertEqual(decision.earliest_acquisition_seconds, 16)
        self.assertEqual(decision.required_seconds, 14)
        self.assertEqual(decide(replace(evidence, remaining_seconds=13.99)).action, "report-unresolved")

    def test_soil_prior_only_changes_synthetic_timing(self):
        region = candidate(windows=(window(),))
        evidence = Evidence(2, 40, (region,), survey_complete=True, correlation_time_upper_seconds=1)
        prior = SoilPrior((0.8, 0.95), "synthetic-public-observation")
        base, wet = decide(evidence), decide(replace(evidence, soil_prior=prior))
        self.assertEqual(base.confirmation_window_gap_seconds, 4)
        self.assertEqual(wet.confirmation_window_gap_seconds, 4)
        self.assertEqual(base.scheduling_window_gap_seconds, 4)
        self.assertEqual(wet.scheduling_window_gap_seconds, 8)
        self.assertTrue(wet.soil_prior_used)
        self.assertEqual(wet.supported_observation_regions, ())
        # A wide uncertain interval must not be treated as known wet soil.
        uncertain = decide(replace(evidence, soil_prior=replace(prior, saturation_interval=(0.2, 0.95))))
        self.assertFalse(uncertain.soil_prior_used)

    def test_wet_prior_does_not_change_acceptance_of_identical_evidence(self):
        region = candidate(windows=(window(), window(6, 8)))
        evidence = Evidence(10, 0, (region,), correlation_time_upper_seconds=1)
        prior = SoilPrior((0.8, 0.95), "synthetic-public-observation")
        base, wet = decide(evidence), decide(replace(evidence, soil_prior=prior))
        self.assertEqual(base.supported_observation_regions, ("a",))
        self.assertEqual(base.supported_observation_regions, wet.supported_observation_regions)
        self.assertEqual(base.action, wet.action)

    def test_expired_peak_cannot_drive_fresh_positive_action_or_priority(self):
        old = candidate("old", (window(signal=100, spatial=False),))
        fresh = candidate("fresh", (window(98, 100, spatial=False),))
        evidence = Evidence(100, 30, (old,), correlation_time_upper_seconds=1)
        self.assertEqual(decide(evidence).action, "continue-survey")
        reacquire = decide(replace(evidence, survey_complete=True))
        self.assertEqual(reacquire.action, "reacquire-candidate")
        self.assertEqual(reacquire.required_seconds, 8)
        combined = decide(replace(evidence, candidates=(old, fresh)))
        self.assertEqual(combined.target_candidate_id, "fresh")
        self.assertEqual(combined.action, "collect-spatial-check")

    def test_large_clock_preserves_relative_travel_cost(self):
        evidence = Evidence(1e16, 8, (candidate(travel=1),), survey_complete=True,
                            correlation_time_upper_seconds=1)
        self.assertEqual(decide(evidence).action, "report-unresolved")
        affordable = decide(replace(evidence, remaining_seconds=9))
        self.assertEqual(affordable.action, "reacquire-candidate")
        self.assertEqual(affordable.required_seconds, 9)
        self.assertEqual(affordable.acquisition_delay_seconds, 1)
        large_travel = Evidence(0, 1e16, (candidate(travel=1e16),), survey_complete=True)
        self.assertEqual(decide(large_travel).action, "report-unresolved")

    def test_survey_travel_and_acquisition_both_count(self):
        evidence = Evidence(10, 10, survey_travel_seconds=3)
        self.assertEqual(decide(evidence).action, "report-unresolved")
        affordable = decide(replace(evidence, remaining_seconds=11))
        self.assertEqual(affordable.action, "continue-survey")
        self.assertEqual(affordable.required_seconds, 11)
        self.assertEqual(affordable.acquisition_delay_seconds, 3)
        self.assertEqual(affordable.earliest_acquisition_seconds, 13)
        stationary = decide(Evidence(10, 8))
        self.assertEqual(stationary.required_seconds, 8)
        self.assertEqual(stationary.acquisition_delay_seconds, 0)

    def test_nonfinite_derived_values_fail_closed(self):
        for evidence, config in (
            (Evidence(10, 30, (candidate(windows=(window(error=1e308),)),)), PolicyConfig()),
            (Evidence(10, 30, (candidate(windows=(window(signal=-1e308, error=5e307),)),)), PolicyConfig()),
            (Evidence(0, 10, correlation_time_upper_seconds=1e308), PolicyConfig()),
            (Evidence(0, 1e308, (candidate(travel=1e308),), survey_complete=True),
             PolicyConfig(acquisition_seconds=1e308)),
            (Evidence(1e308, 1.5e308, (candidate(travel=1e308),), survey_complete=True), PolicyConfig()),
            (Evidence(10 ** 1000, 30), PolicyConfig()),
        ):
            with self.subTest(evidence=evidence, config=config), self.assertRaises(ValueError):
                decide(evidence, config)

    def test_deterministic_ties_and_input_order_independence(self):
        a, b = candidate("a", (window(),)), candidate("b", (window(),))
        evidence = Evidence(10, 30, (b, a), correlation_time_upper_seconds=1)
        first = decide(evidence)
        self.assertEqual(first, decide(replace(evidence, candidates=(a, b))))
        self.assertEqual(first.target_candidate_id, "a")

    def test_invalid_evidence_fails_closed(self):
        valid = Evidence(20, 30, (candidate(windows=(window(),)),), correlation_time_upper_seconds=1)
        invalid = [replace(valid, now_seconds=float("nan")), replace(valid, remaining_seconds=-1),
                   replace(valid, correlation_time_upper_seconds=True), replace(valid, survey_complete=1),
                   replace(valid, survey_travel_seconds=-1),
                   replace(valid, candidates=valid.candidates * 2),
                   replace(valid, candidates=(candidate(windows=(window(end=21),)),)),
                   replace(valid, candidates=(candidate(windows=(window(), window(1, 3))),)),
                   replace(valid, candidates=(candidate(windows=(window(error=-1),)),)),
                   replace(valid, candidates=(Candidate("a", (float("inf"), 0)),)),
                   replace(valid, soil_prior=SoilPrior((0.5, 0.5), "synthetic-public-observation")),
                   replace(valid, soil_prior=SoilPrior((0.4, 0.5), "private-simulation-truth"))]
        for evidence in invalid:
            with self.subTest(evidence=evidence), self.assertRaises((ValueError, TypeError)):
                decide(evidence)

    def test_invalid_config_and_unknown_truth_fields_rejected(self):
        for config in (PolicyConfig(confirming_windows=1), PolicyConfig(acquisition_seconds=0),
                       PolicyConfig(wet_prior_gap_multiplier=0.5), PolicyConfig(confirming_windows=True)):
            with self.assertRaises(ValueError):
                decide(Evidence(0, 0), config)
        with self.assertRaises(TypeError):
            Evidence(0, 10, buried_source=(0, 0))
        with self.assertRaises(TypeError):
            decide({"now_seconds": 0}, PolicyConfig())


if __name__ == "__main__":
    unittest.main()
