"""Reproducible M59 wet-cap breakthrough audit; local run is intentionally slow."""

import json

from m56_soil_cross_section import initial_state, solve_pressure, surface_flux_summary
from m57_soil_convergence_audit import build, relative_change
from m59_muscl_transport import advance_muscl


def breakthrough(nx, nz, sample_interval_s=50., threshold_fraction=.1,
                 maximum_time_s=8000.):
    config = build(nx, nz)
    pressure = solve_pressure(config, tolerance_pa=1e-9)
    state = initial_state(config)
    volume_rate = surface_flux_summary(config, pressure)[0]
    reference_mass_rate = volume_rate*config.leak_concentration_kg_m3_gas
    previous_time = previous_fraction = 0.0
    while state.time_s < maximum_time_s:
        result = advance_muscl(config, pressure, state, sample_interval_s)
        state = result.state
        surface_rate = sum(result.surface_flux_kg_m2_s)*config.width_m/config.nx
        fraction = surface_rate/reference_mass_rate
        if fraction >= threshold_fraction:
            crossing = previous_time+(threshold_fraction-previous_fraction)*(
                state.time_s-previous_time)/(fraction-previous_fraction)
            return {
                "nx": nx, "nz": nz, "crossing_time_s": crossing,
                "sample_interval_s": sample_interval_s,
                "threshold_fraction_of_q_surface_times_C_leak": threshold_fraction,
                "mass_balance_error_kg_m": result.mass_balance_error_kg_m,
                "maximum_concentration_kg_m3": result.maximum_concentration_kg_m3,
            }
        previous_time, previous_fraction = state.time_s, fraction
    raise ValueError("Breakthrough threshold not reached within maximum time")


def audit():
    levels = [breakthrough(16, 8), breakthrough(24, 12),
              breakthrough(32, 16), breakthrough(48, 24)]
    changes = []
    for coarse, fine in zip(levels, levels[1:]):
        changes.append(relative_change(coarse["crossing_time_s"], fine["crossing_time_s"]))
    return {
        "status": "synthetic numerical audit; not physical validation",
        "metric": "linearly interpolated first crossing of 10% of q_surface*C_leak",
        "levels": levels,
        "successive_relative_changes": changes,
        "fine_32_to_48_within_2_percent": changes[-1] <= .02,
    }


if __name__ == "__main__":
    print(json.dumps(audit(), indent=2, sort_keys=True))
