"""Frozen sand/clay soil-to-air forcing cases for the localization benchmark.

The calculation is deliberately one-dimensional and homogeneous.  It estimates
the methane flux arriving at a level ground surface above a maintained buried
boundary.  It does not estimate the buried leak rate, lateral emergence offset,
cracks, oxidation, dissolution, capillary invasion, or changing water content.
"""

from dataclasses import asdict, dataclass
import json
import argparse
from math import isfinite
from pathlib import Path

from m54_soil_closure import (SoilClosure, bulk_diffusivity_mq,
                              intrinsic_from_water_conductivity)
from m55_soil_column import ColumnConfig, advance, initial_state


SCHEMA_VERSION = "m60-homogeneous-soil-regimes-v1"
SATURATIONS = (0.2, 0.5, 0.8)
SURVEY_TIME_S = 7 * 24 * 3600
DEPTH_M = 0.5
PRESSURE_EXCESS_PA = 100.0
GAS_VISCOSITY_PA_S = 1.1e-5
FREE_DIFFUSIVITY_M2_S = 2.0e-5
WATER_VISCOSITY_PA_S = 1.002e-3
WATER_DENSITY_KG_M3 = 998.2
GRAVITY_M_S2 = 9.80665
BOUNDARY_CONCENTRATION = 1.0  # linear tracer normalization, not a field methane concentration


@dataclass(frozen=True)
class SoilCase:
    case_id: str
    texture: str
    water_saturation: float
    porosity: float
    intrinsic_permeability_m2: float
    water_hydraulic_conductivity_m_s: float
    gas_relative_permeability: float
    bulk_diffusivity_m2_s: float
    darcy_flux_m_s: float
    surface_flux_normalized_tracer_kg_m2_s: float
    cumulative_surface_output_normalized_kg_m2: float
    gas_pore_peclet: float
    gas_pore_fourier: float
    advective_pore_volumes: float
    emission_scale_relative_to_sand_sw_0p2: float
    coarse_fine_surface_flux_relative_change: float
    mass_balance_error_kg_m2: float


def _load_priors():
    path = Path(__file__).resolve().parents[1] / "research/protocols/m54_rosetta_texture_priors.json"
    return json.loads(path.read_text())


def _material(texture, record):
    ks = 10 ** record["log10_Ks_cm_per_day"][0] * 0.01 / 86400
    permeability = intrinsic_from_water_conductivity(
        ks, WATER_VISCOSITY_PA_S, WATER_DENSITY_KG_M3, GRAVITY_M_S2)
    material = SoilClosure(
        (permeability,) * 3,
        record["theta_s"][0],
        0.05,
        0.02,
        3.0,
        2.0,
        f"ROSETTA texture-class central water-hydraulic prior ({texture}); gas endpoints/exponents are frozen sensitivity assumptions",
    )
    return material, ks, permeability


def _run(material, sw, cells):
    config = ColumnConfig(
        DEPTH_M,
        (material,) * cells,
        (sw,) * cells,
        GAS_VISCOSITY_PA_S,
        FREE_DIFFUSIVITY_M2_S,
        101325.0 + PRESSURE_EXCESS_PA,
        101325.0,
        BOUNDARY_CONCENTRATION,
        0.0,
    )
    return advance(config, initial_state(config), SURVEY_TIME_S, maximum_substep_s=300.0)


def build_regimes():
    priors = _load_priors()
    provisional = []
    for texture in ("sand", "clay"):
        material, ks, permeability = _material(texture, priors["classes"][texture])
        for sw in SATURATIONS:
            coarse = _run(material, sw, 20)
            fine = _run(material, sw, 40)
            gas_fraction = 1.0 - sw
            capacity = material.porosity * gas_fraction
            diffusivity = bulk_diffusivity_mq(material.porosity, gas_fraction,
                                               FREE_DIFFUSIVITY_M2_S)
            flux_scale = max(abs(fine.surface_flux_kg_m2_s), 1e-300)
            provisional.append({
                "case_id": f"{texture}-sw-{str(sw).replace('.', 'p')}",
                "texture": texture,
                "water_saturation": sw,
                "porosity": material.porosity,
                "intrinsic_permeability_m2": permeability,
                "water_hydraulic_conductivity_m_s": ks,
                "gas_relative_permeability": material.relative_permeability(sw)[1],
                "bulk_diffusivity_m2_s": diffusivity,
                "darcy_flux_m_s": fine.darcy_flux_m_s,
                "surface_flux_normalized_tracer_kg_m2_s": fine.surface_flux_kg_m2_s,
                "cumulative_surface_output_normalized_kg_m2": fine.state.cumulative_surface_output_kg_m2,
                "gas_pore_peclet": fine.darcy_flux_m_s * DEPTH_M / diffusivity,
                "gas_pore_fourier": diffusivity * SURVEY_TIME_S / (capacity * DEPTH_M ** 2),
                "advective_pore_volumes": fine.darcy_flux_m_s * SURVEY_TIME_S / (capacity * DEPTH_M),
                "coarse_fine_surface_flux_relative_change": abs(
                    coarse.surface_flux_kg_m2_s - fine.surface_flux_kg_m2_s) / flux_scale,
                "mass_balance_error_kg_m2": fine.mass_balance_error_kg_m2,
            })
    reference = next(row["surface_flux_normalized_tracer_kg_m2_s"] for row in provisional
                     if row["case_id"] == "sand-sw-0p2")
    cases = [SoilCase(**row,
                      emission_scale_relative_to_sand_sw_0p2=
                      row["surface_flux_normalized_tracer_kg_m2_s"] / reference)
             for row in provisional]
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "literature-prior, fixed-moisture numerical sensitivity; not field calibration",
        "target": "surface emergence directly above a homogeneous maintained buried boundary",
        "forcing": {
            "depth_m": DEPTH_M,
            "survey_time_s": SURVEY_TIME_S,
            "pressure_excess_pa": PRESSURE_EXCESS_PA,
            "bottom_tracer_concentration_kg_m3_gas": BOUNDARY_CONCENTRATION,
            "gas_viscosity_pa_s": GAS_VISCOSITY_PA_S,
            "free_diffusivity_m2_s": FREE_DIFFUSIVITY_M2_S,
        },
        "frozen_constitutive_assumptions": {
            "relative_permeability_family": "modified Brooks-Corey sensitivity",
            "residual_water_saturation": 0.05,
            "residual_gas_saturation": 0.02,
            "water_exponent": 3.0,
            "gas_exponent": 2.0,
            "diffusion_family": "Millington-Quirk bulk-area closure",
        },
        "dimensionless_groups": {
            "gas_pore_peclet": "q L / D_bulk",
            "gas_pore_fourier": "D_bulk t / (phi Sg L^2)",
            "advective_pore_volumes": "q t / (phi Sg L)",
        },
        "source_prior": priors["source"],
        "case_count": len(cases),
        "cases": [asdict(case) for case in cases],
        "acceptance": {
            "all_finite": all(all(isfinite(value) for value in asdict(case).values()
                                  if isinstance(value, float)) for case in cases),
            "coarse_fine_flux_change_le_0p02": all(
                case.coarse_fine_surface_flux_relative_change <= 0.02 for case in cases),
            "mass_balance_abs_le_2e_12": all(
                abs(case.mass_balance_error_kg_m2) <= 2e-12 for case in cases),
            "flux_decreases_with_saturation_per_texture": all(
                all(rows[i].surface_flux_normalized_tracer_kg_m2_s >
                    rows[i + 1].surface_flux_normalized_tracer_kg_m2_s
                    for i in range(len(rows) - 1))
                for rows in ([case for case in cases if case.texture == texture]
                             for texture in ("sand", "clay"))),
        },
        "scope_exclusions": [
            "lateral source-to-emergence displacement",
            "soil heterogeneity, cracks and preferential paths",
            "dynamic water redistribution, capillary invasion and hysteresis",
            "methane dissolution, oxidation, adsorption and density feedback",
            "field-calibrated gas relative permeability or detection probability",
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    rendered = json.dumps(build_regimes(), indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    else:
        print(rendered, end="")
