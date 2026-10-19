"""Experimental observation-only survey scheduler; NOT a source estimator.

All defaults are synthetic engineering choices, not soil/sensor calibration.
Candidates are regions proposed from observed concentrations. A persistent region
can be an advected plume maximum, not a soil-emergence vent or buried defect.
The function deliberately never returns ``no leak`` or a buried-source estimate.
Do not wire this development fixture into a confirmatory benchmark unchanged.
"""

from dataclasses import dataclass
from math import isfinite


@dataclass(frozen=True)
class PolicyConfig:
    minimum_excess_signal: float = 0.10
    uncertainty_margin: float = 2.0
    confirming_windows: int = 2
    minimum_window_gap_seconds: float = 4.0
    correlation_time_multiplier: float = 3.0
    acquisition_seconds: float = 8.0
    spatial_probe_seconds: float = 10.0
    correlation_observation_seconds: float = 20.0
    maximum_window_age_seconds: float = 60.0
    wet_prior_lower_bound: float = 0.70
    wet_prior_gap_multiplier: float = 2.0


@dataclass(frozen=True)
class SoilPrior:
    """Optional declared uncertain context, never truth permeability/connectivity.

    A saturation interval must have positive width. Its synthetic scheduling
    effect is tested as a separate information arm. No soil prior is evidence
    for leak absence, source position, or a connected gas pathway.
    """

    saturation_interval: tuple[float, float]
    provenance: str  # synthetic-public-observation or independent-public-measurement


@dataclass(frozen=True)
class Window:
    start_seconds: float
    end_seconds: float
    mean_excess_signal: float  # observed concentration minus a declared background
    standard_error: float  # observation-derived; must account for correlation
    spatial_check_passed: bool = False  # withheld observation check, not source truth


@dataclass(frozen=True)
class Candidate:
    candidate_id: str
    observed_position: tuple[float, float]
    windows: tuple[Window, ...] = ()
    travel_seconds: float = 0.0  # current public motion-planner estimate


@dataclass(frozen=True)
class Evidence:
    now_seconds: float
    remaining_seconds: float
    candidates: tuple[Candidate, ...] = ()
    survey_complete: bool = False  # declared coverage criterion, NOT all soil inspected
    # Estimated only from collected data; None means it has not been resolved.
    correlation_time_upper_seconds: float | None = None
    soil_prior: SoilPrior | None = None
    # Public planner's travel time to the next survey sample. Zero explicitly
    # means a stationary acquisition; the scheduler does not invent free motion.
    survey_travel_seconds: float = 0.0


@dataclass(frozen=True)
class Decision:
    action: str
    reason: str
    target_candidate_id: str | None
    required_seconds: float
    # Relative delay is authoritative; the absolute timestamp can lose precision
    # when a caller supplies a very large clock epoch.
    acquisition_delay_seconds: float | None
    earliest_acquisition_seconds: float | None
    supported_observation_regions: tuple[str, ...]
    unresolved_candidates: tuple[str, ...]
    confirmation_window_gap_seconds: float | None
    scheduling_window_gap_seconds: float | None
    soil_prior_used: bool
    claim: str = "Observation-region evidence only; leak location and absence unresolved."


def _number(value: object, name: str, minimum: float | None = None) -> None:
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise ValueError(f"{name} must be a finite number")
    try:
        finite = isfinite(value)
    except (OverflowError, TypeError):
        finite = False
    if not finite:
        raise ValueError(f"{name} must be a finite number")
    if minimum is not None and value < minimum:
        raise ValueError(f"{name} must be >= {minimum}")


def _validate(evidence: Evidence, config: PolicyConfig) -> None:
    if type(evidence) is not Evidence or type(config) is not PolicyConfig:
        raise TypeError("Evidence and PolicyConfig objects are required")
    for name in (
        "minimum_excess_signal", "uncertainty_margin", "minimum_window_gap_seconds",
        "correlation_time_multiplier", "acquisition_seconds", "spatial_probe_seconds",
        "correlation_observation_seconds", "wet_prior_gap_multiplier",
        "maximum_window_age_seconds",
    ):
        value = getattr(config, name)
        _number(value, name, 0)
        if value == 0:
            raise ValueError(f"{name} must be positive")
    if config.correlation_time_multiplier < 1 or config.wet_prior_gap_multiplier < 1:
        raise ValueError("Temporal gap multipliers must be >= 1")
    _number(config.wet_prior_lower_bound, "wet_prior_lower_bound", 0)
    if config.wet_prior_lower_bound > 1:
        raise ValueError("wet_prior_lower_bound must be <= 1")
    if type(config.confirming_windows) is not int or config.confirming_windows < 2:
        raise ValueError("confirming_windows must be an integer >= 2")
    _number(evidence.now_seconds, "now_seconds", 0)
    _number(evidence.remaining_seconds, "remaining_seconds", 0)
    _number(evidence.survey_travel_seconds, "survey_travel_seconds", 0)
    if type(evidence.survey_complete) is not bool:
        raise ValueError("survey_complete must be boolean")
    if evidence.correlation_time_upper_seconds is not None:
        _number(evidence.correlation_time_upper_seconds, "correlation_time_upper_seconds", 0)
    if type(evidence.candidates) is not tuple:
        raise ValueError("candidates must be an immutable tuple")
    seen: set[str] = set()
    for candidate in evidence.candidates:
        if type(candidate) is not Candidate:
            raise TypeError("Candidate objects are required")
        if (not isinstance(candidate.candidate_id, str) or not candidate.candidate_id.strip()
                or candidate.candidate_id in seen):
            raise ValueError("candidate_id must be a unique nonempty string")
        seen.add(candidate.candidate_id)
        if type(candidate.observed_position) is not tuple or len(candidate.observed_position) != 2:
            raise ValueError("observed_position must contain two coordinates")
        for coordinate in candidate.observed_position:
            _number(coordinate, "observed_position")
        _number(candidate.travel_seconds, "travel_seconds", 0)
        if type(candidate.windows) is not tuple:
            raise ValueError("windows must be an immutable tuple")
        previous_end = -1.0
        for window in candidate.windows:
            if type(window) is not Window:
                raise TypeError("Window objects are required")
            _number(window.start_seconds, "window.start_seconds", 0)
            _number(window.end_seconds, "window.end_seconds", 0)
            _number(window.mean_excess_signal, "window.mean_excess_signal")
            _number(window.standard_error, "window.standard_error", 0)
            margin = config.uncertainty_margin * window.standard_error
            _number(margin, "derived signal uncertainty margin", 0)
            _number(window.mean_excess_signal - margin, "derived signal lower bound")
            if type(window.spatial_check_passed) is not bool:
                raise ValueError("spatial_check_passed must be boolean")
            if (window.end_seconds <= window.start_seconds
                    or window.start_seconds < previous_end
                    or window.end_seconds > evidence.now_seconds):
                raise ValueError("Windows must be positive-duration, ordered, nonoverlapping, and past")
            previous_end = window.end_seconds
    prior = evidence.soil_prior
    if prior is not None:
        if type(prior) is not SoilPrior:
            raise TypeError("A SoilPrior object is required")
        if prior.provenance not in ("synthetic-public-observation", "independent-public-measurement"):
            raise ValueError("Soil prior requires declared public-observation provenance")
        if type(prior.saturation_interval) is not tuple or len(prior.saturation_interval) != 2:
            raise ValueError("saturation_interval must be an immutable pair")
        low, high = prior.saturation_interval
        _number(low, "saturation lower bound", 0)
        _number(high, "saturation upper bound", 0)
        if not 0 <= low < high <= 1:
            raise ValueError("Saturation uncertainty must have nonzero width within [0, 1]")


def decide(evidence: Evidence, config: PolicyConfig = PolicyConfig()) -> Decision:
    """Return one deterministic action from permissible evidence summaries.

    Repeated positive windows are separated by an explicit conservative gap.
    This spacing does not prove independence if the observed correlation-time
    bound is wrong. The signal margin is not a calibrated probability or a
    multiple-comparison correction. Future mission studies must calibrate it.
    """
    _validate(evidence, config)
    prior_used = (evidence.correlation_time_upper_seconds is not None
                  and evidence.soil_prior is not None
                  and evidence.soil_prior.saturation_interval[0] >= config.wet_prior_lower_bound)
    confirmation_gap = None
    scheduling_gap = None
    if evidence.correlation_time_upper_seconds is not None:
        correlation_gap = config.correlation_time_multiplier * evidence.correlation_time_upper_seconds
        _number(correlation_gap, "derived correlation gap", 0)
        confirmation_gap = max(config.minimum_window_gap_seconds, correlation_gap)
        scheduling_gap = confirmation_gap
        if prior_used:
            scheduling_gap *= config.wet_prior_gap_multiplier
        _number(scheduling_gap, "derived scheduling gap", 0)

    def positive(window: Window) -> bool:
        return (window.mean_excess_signal - config.uncertainty_margin * window.standard_error
                >= config.minimum_excess_signal)

    supported: list[str] = []
    pending: list[Candidate] = []
    current_windows: dict[str, list[Window]] = {}
    latest_eligible_windows: dict[str, Window | None] = {}
    for candidate in sorted(evidence.candidates, key=lambda item: item.candidate_id):
        current: list[Window] = []
        latest_eligible = None
        for window in candidate.windows:
            if evidence.now_seconds - window.end_seconds > config.maximum_window_age_seconds:
                continue
            latest_eligible = window
            # A negative/uncertain revisit starts a new confirmation episode.
            if not positive(window):
                current.clear()
            else:
                current.append(window)
        current_windows[candidate.candidate_id] = current
        latest_eligible_windows[candidate.candidate_id] = latest_eligible
        spaced: list[Window] = []
        if confirmation_gap is not None:
            for window in current:
                if not spaced or window.start_seconds - spaced[-1].end_seconds >= confirmation_gap:
                    spaced.append(window)
        # A recent contradictory window invalidates persistence; historical
        # maxima cannot survive switch-off or a clearly negative revisit.
        recent_positive = bool(latest_eligible and positive(latest_eligible))
        # The separate fresh-pose check may fall between the retained temporal
        # windows; it need not itself serve as an independent temporal replicate.
        spatial_support = any(window.spatial_check_passed for window in current)
        if len(spaced) >= config.confirming_windows and recent_positive and spatial_support:
            supported.append(candidate.candidate_id)
        else:
            pending.append(candidate)

    def result(action: str, reason: str, target: str | None = None, cost: float = 0.0,
               delay: float | None = None) -> Decision:
        _number(cost, "derived action cost", 0)
        start = None
        if delay is not None:
            _number(delay, "derived acquisition delay", 0)
            start = evidence.now_seconds + delay
            _number(start, "derived absolute acquisition time", 0)
        return Decision(action, reason, target, cost, delay, start, tuple(supported),
                        tuple(item.candidate_id for item in pending), confirmation_gap,
                        scheduling_gap, prior_used)

    def terminal(reason: str) -> Decision:
        return result("report-supported-regions" if supported else "report-unresolved", reason)

    if evidence.remaining_seconds == 0:
        return terminal("Mission budget exhausted; no claim of leak absence is justified.")
    if evidence.survey_complete and not pending:
        return terminal("Coverage criterion met; retain every supported observation region.")

    proposals: list[tuple[float, str, Candidate, str, str, float, float]] = []
    for candidate in pending:
        latest = latest_eligible_windows[candidate.candidate_id]
        strength = (latest.mean_excess_signal - config.uncertainty_margin * latest.standard_error
                    if latest else float("-inf"))
        delay = candidate.travel_seconds
        if latest is None:
            action, duration = "reacquire-candidate", config.acquisition_seconds
            reason = "No age-eligible evidence remains; exploratory reacquisition is not fresh-positive confirmation."
        elif scheduling_gap is None:
            action, duration = "estimate-temporal-correlation", config.correlation_observation_seconds
            reason = "Correlation-time evidence is unresolved; repeated windows cannot yet confirm persistence."
        elif latest and positive(latest) and not any(w.spatial_check_passed for w in current_windows[candidate.candidate_id]):
            action, duration = "collect-spatial-check", config.spatial_probe_seconds
            reason = "Test a fresh nearby pose; a local concentration maximum is not a source coordinate."
        else:
            action, duration = "revisit-candidate", config.acquisition_seconds
            reason = "Collect a temporally separated window; preserve alternative candidate regions."
            age = evidence.now_seconds - latest.end_seconds
            wait = max(0.0, scheduling_gap - age)
            delay = max(candidate.travel_seconds, wait)
        # Keep all affordability arithmetic relative. Computing an absolute
        # arrival and subtracting now can erase travel at large clock epochs.
        _number(delay, "derived acquisition delay", 0)
        cost = delay + duration
        _number(cost, "derived action cost", 0)
        # Compare component durations as well as the sum: at very large values
        # the float sum can otherwise round a small acquisition cost away.
        if (delay <= evidence.remaining_seconds
                and duration <= evidence.remaining_seconds - delay
                and cost <= evidence.remaining_seconds):
            proposals.append((-strength, candidate.candidate_id, candidate, action, reason, cost, delay))

    # Positive evidence prompts a bounded check. Otherwise complete the declared
    # coverage plan before concentrating budget on unconvincing regions.
    proposals.sort(key=lambda item: (item[0], item[1]))
    if proposals and (evidence.survey_complete or proposals[0][0] <= -config.minimum_excess_signal):
        _, _, candidate, action, reason, cost, delay = proposals[0]
        return result(action, reason, candidate.candidate_id, cost, delay)
    if not evidence.survey_complete:
        survey_cost = evidence.survey_travel_seconds + config.acquisition_seconds
        _number(survey_cost, "derived survey cost", 0)
        if (evidence.survey_travel_seconds <= evidence.remaining_seconds
                and config.acquisition_seconds <= evidence.remaining_seconds - evidence.survey_travel_seconds
                and survey_cost <= evidence.remaining_seconds):
            return result("continue-survey", "Continue the public coverage plan; charge declared travel and acquisition.",
                          cost=survey_cost, delay=evidence.survey_travel_seconds)
    return terminal("No affordable evidence-acquisition action remains; unresolved candidates stay unresolved.")
