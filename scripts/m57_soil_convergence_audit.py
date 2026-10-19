"""Deterministic local convergence audit for the synthetic M56 wet-cap case."""

import json

from m54_soil_closure import SoilClosure
from m56_soil_cross_section import (CrossSectionConfig, advance, initial_state,
                                    solve_pressure, surface_flux_summary)


def material(kx, kz, provenance):
    return SoilClosure((kx, (kx*kz)**.5, kz), .4, .05, .02, 3, 2, provenance)


def build(nx, nz):
    base = material(5e-11, 1e-11, "Synthetic M57 anisotropic matrix")
    cap = material(5e-13, 1e-13, "Synthetic M57 wet low-permeability cap")
    soils, saturation = [], []
    for iz in range(nz):
        z = (iz+.5)/nz
        for ix in range(nx):
            x = (ix+.5)/nx
            capped = z >= .75 and x <= .625
            soils.append(cap if capped else base)
            saturation.append(.85 if capped else .2)
    # Boundaries align exactly for every frozen grid (16/24/32 cells), avoiding
    # geometry changes masquerading as discretisation error.
    leak = tuple(i for i in range(nx)
                 if i/nx >= .4375-1e-15 and (i+1)/nx <= .5625+1e-15)
    if not leak:
        leak = (nx//2,)
    return CrossSectionConfig(1., 1., nx, nz, tuple(soils), tuple(saturation), leak,
                              1e-5, 1e-6, 101425., 101325., 1., 0.)


def weighted_centroid(values, width):
    total = sum(values)
    if total <= 0:
        return None
    dx = width/len(values)
    return sum((i+.5)*dx*v for i, v in enumerate(values))/total


def run_level(nx, nz, duration_s=5000., maximum_substep_s=None):
    config = build(nx, nz)
    pressure = solve_pressure(config, tolerance_pa=1e-9)
    dx = config.width_m/config.nx
    input_q = sum(pressure.qz_m_s[:config.nx])*dx
    output_q, pressure_centroid = surface_flux_summary(config, pressure)
    result = advance(config, pressure, initial_state(config), duration_s, maximum_substep_s)
    return {
        "nx": nx,
        "nz": nz,
        "pressure_iterations": pressure.iterations,
        "pressure_maximum_update_pa": pressure.maximum_update_pa,
        "volume_input_m2_s": input_q,
        "volume_surface_m2_s": output_q,
        "pressure_flux_relative_imbalance": abs(input_q-output_q)/max(abs(input_q), 1e-300),
        "surface_volume_flux_centroid_x_m": pressure_centroid,
        "transport_substeps": result.substeps,
        "stored_methane_kg_m": result.stored_mass_kg_m,
        "cumulative_surface_methane_kg_m": result.state.cumulative_surface_output_kg_m,
        "surface_methane_flux_kg_m_s": sum(result.surface_flux_kg_m2_s)*dx,
        "surface_methane_flux_centroid_x_m": weighted_centroid(result.surface_flux_kg_m2_s,
                                                                config.width_m),
        "mass_balance_error_kg_m": result.mass_balance_error_kg_m,
        "maximum_substep_s": maximum_substep_s,
    }


def relative_change(a, b):
    return abs(a-b)/max(abs(b), 1e-300)


def audit():
    levels = [run_level(16, 8), run_level(24, 12), run_level(32, 16)]
    fine_timestep = run_level(32, 16, maximum_substep_s=20.)
    medium, fine = levels[-2], levels[-1]
    comparisons = {
        "medium_to_fine_surface_volume_flux_relative_change": relative_change(
            medium["volume_surface_m2_s"], fine["volume_surface_m2_s"]),
        "medium_to_fine_pressure_centroid_absolute_change_m": abs(
            medium["surface_volume_flux_centroid_x_m"]-fine["surface_volume_flux_centroid_x_m"]),
        "medium_to_fine_storage_relative_change": relative_change(
            medium["stored_methane_kg_m"], fine["stored_methane_kg_m"]),
        "medium_to_fine_surface_output_relative_change": relative_change(
            medium["cumulative_surface_methane_kg_m"], fine["cumulative_surface_methane_kg_m"]),
        "fine_timestep_storage_relative_change": relative_change(
            fine["stored_methane_kg_m"], fine_timestep["stored_methane_kg_m"]),
        "fine_timestep_surface_output_relative_change": relative_change(
            fine["cumulative_surface_methane_kg_m"],
            fine_timestep["cumulative_surface_methane_kg_m"]),
    }
    gates = {
        "pressure_balance_each_level_le_1e-7": all(
            row["pressure_flux_relative_imbalance"] <= 1e-7 for row in levels),
        "mass_balance_each_run_le_1e-12_kg_m": all(
            abs(row["mass_balance_error_kg_m"]) <= 1e-12 for row in levels+[fine_timestep]),
        "medium_fine_pressure_outputs_within_5_percent_or_0p01m": (
            comparisons["medium_to_fine_surface_volume_flux_relative_change"] <= .05
            and comparisons["medium_to_fine_pressure_centroid_absolute_change_m"] <= .01),
        "medium_fine_transport_outputs_within_8_percent": (
            comparisons["medium_to_fine_storage_relative_change"] <= .08
            and comparisons["medium_to_fine_surface_output_relative_change"] <= .08),
        "fine_timestep_outputs_within_2_percent": (
            comparisons["fine_timestep_storage_relative_change"] <= .02
            and comparisons["fine_timestep_surface_output_relative_change"] <= .02),
    }
    return {
        "status": "synthetic numerical audit; not physical validation",
        "case": "anisotropic base with asymmetric wet low-permeability surface cap",
        "duration_s": 5000.,
        "levels": levels,
        "fine_maximum_substep_20s": fine_timestep,
        "comparisons": comparisons,
        "gates": gates,
        "verified": all(gates.values()),
    }


if __name__ == "__main__":
    print(json.dumps(audit(), indent=2, sort_keys=True))
