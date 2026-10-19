"""Research-only soil constitutive primitives, NOT a coupled soil-flow solver.

Source equations: PFLOTRAN modified Brooks-Corey and DuMuX Millington-Quirk.
All material/critical parameters must be supplied explicitly; no soil label is
mapped to an invented measured value. Static structure and prescribed saturation.
"""
from dataclasses import dataclass
from math import isfinite


def finite(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number")
    try:
        valid = isfinite(value)
    except OverflowError:
        valid = False
    if not valid:
        raise ValueError(f"{name} must be a finite number")
    return value


def fraction(value, name):
    finite(value, name)
    if not 0 <= value <= 1:
        raise ValueError(f"{name} must be in [0,1]")
    return value


def intrinsic_from_water_conductivity(ks_m_s, water_viscosity_pa_s, water_density_kg_m3, gravity_m_s2):
    """Convert saturated water hydraulic conductivity to k [m²].

    Conversion assumes Darcy flow and the same unchanged pore structure; it is
    not a calibration of gas slip, trapped gas, swelling or preferential paths.
    """
    values = (ks_m_s, water_viscosity_pa_s, water_density_kg_m3, gravity_m_s2)
    for value in values:
        finite(value, "conductivity conversion input")
    if ks_m_s < 0 or min(values[1:]) <= 0:
        raise ValueError("Invalid conductivity or water properties")
    numerator = finite(ks_m_s*water_viscosity_pa_s, "conductivity numerator")
    denominator = finite(water_density_kg_m3*gravity_m_s2, "conductivity denominator")
    if denominator == 0:
        raise ValueError("Conductivity denominator underflow")
    return finite(numerator/denominator, "intrinsic permeability")


@dataclass(frozen=True)
class SoilClosure:
    intrinsic_k_m2: tuple  # diagonal tensor (kx, ky, kz), not hydraulic conductivity
    porosity: float
    residual_water: float
    residual_gas: float
    water_exponent: float
    gas_exponent: float
    provenance: str  # e.g. explicit synthetic sensitivity or verified dataset ID

    def __post_init__(self):
        if not isinstance(self.intrinsic_k_m2, (tuple, list)):
            raise ValueError("Permeability must be a tuple or list")
        # A frozen dataclass alone does not freeze a caller-supplied list.
        object.__setattr__(self, "intrinsic_k_m2", tuple(self.intrinsic_k_m2))
        if len(self.intrinsic_k_m2) != 3:
            raise ValueError("Require three principal permeabilities")
        for k in self.intrinsic_k_m2:
            if finite(k, "k") < 0:
                raise ValueError("Negative permeability")
        if not 0 < fraction(self.porosity, "porosity") < 1:
            raise ValueError("Porosity must be strictly between zero and one")
        fraction(self.residual_water, "residual_water")
        fraction(self.residual_gas, "residual_gas")
        if self.residual_water + self.residual_gas >= 1:
            raise ValueError("Residual saturations must sum to less than one")
        for exponent in (self.water_exponent, self.gas_exponent):
            if finite(exponent, "exponent") <= 0:
                raise ValueError("Exponent must be positive")
        if not isinstance(self.provenance, str) or not self.provenance.strip():
            raise ValueError("Material provenance required")

    def relative_permeability(self, water_saturation):
        """Returns (kr_water, kr_gas); residuals are not universal thresholds."""
        sw = fraction(water_saturation, "water_saturation")
        denominator = 1-self.residual_water-self.residual_gas
        clamp = lambda v: max(0., min(1., v))
        ew = clamp((sw-self.residual_water)/denominator)
        eg = clamp((1-sw-self.residual_gas)/denominator)
        return ew**self.water_exponent, eg**self.gas_exponent

    def darcy_flux(self, water_saturation, phase, viscosity_pa_s, driving_gradient_pa_m):
        """q [m/s], using grad(p)-rho*g supplied in common Cartesian coordinates.

        Axes must align with the diagonal tensor. No capillary-entry subtraction:
        invasion of water-filled pores is a different process, not solved here.
        """
        if phase not in ("water", "gas"):
            raise ValueError("Unknown phase")
        if finite(viscosity_pa_s, "viscosity") <= 0 or len(driving_gradient_pa_m) != 3:
            raise ValueError("Positive viscosity and 3-D gradient required")
        kr = self.relative_permeability(water_saturation)[0 if phase == "water" else 1]
        return tuple(finite(-k*kr/viscosity_pa_s*finite(g, "gradient"), "Darcy flux")
                     for k, g in zip(self.intrinsic_k_m2, driving_gradient_pa_m))


def bulk_diffusivity_mq(porosity, phase_saturation, free_diffusivity_m2_s):
    """Bulk-area D_eff: do NOT multiply by porosity/saturation again in flux.

    Smooth continuum closure, no finite percolation cutoff and no claim of
    accuracy near disconnected gas clusters. Use threshold_sensitivity as an
    ALTERNATIVE sensitivity law, not as an uncalibrated extra multiplier.
    """
    phi = fraction(porosity, "porosity")
    saturation = fraction(phase_saturation, "phase_saturation")
    d0 = finite(free_diffusivity_m2_s, "diffusivity")
    if phi <= 0 or phi >= 1 or d0 < 0:
        raise ValueError("Invalid porosity or diffusivity")
    # Algebraically identical form avoids underflow in the phi**2 denominator.
    return finite(d0*phi**(4/3)*saturation**(10/3), "bulk diffusivity")


def threshold_sensitivity(phase_saturation, critical_saturation, exponent):
    """Uncalibrated alternative normalized conductance; 0 below a supplied cutoff.

    Gas and water cutoffs must be supplied independently. This does not solve
    finite-size connectivity, hysteresis, trapping or pressure-driven invasion.
    No default exponent: the robot's 2-D path does not make soil pore space 2-D.
    """
    saturation = fraction(phase_saturation, "phase_saturation")
    critical = fraction(critical_saturation, "critical_saturation")
    if critical >= 1 or finite(exponent, "exponent") <= 0:
        raise ValueError("Invalid threshold or exponent")
    return (max(0., saturation-critical)/(1-critical))**exponent


def species_flux(darcy_q, phase_concentration, bulk_diffusivity, concentration_gradient):
    """Methane J [kg/m²/s], C [kg/m³-phase], grad C [kg/m⁴-phase].

    Restricted to dilute transport with effectively constant phase density.
    General pressurized/composition-dependent gas requires a density-consistent
    species-fraction formulation; this primitive is not that mixture model.
    """
    c = finite(phase_concentration, "concentration")
    d = finite(bulk_diffusivity, "diffusivity")
    if c < 0 or d < 0 or len(darcy_q) != 3 or len(concentration_gradient) != 3:
        raise ValueError("Invalid species flux inputs")
    return tuple(finite(finite(q, "q")*c-d*finite(g, "concentration_gradient"), "species flux")
                 for q, g in zip(darcy_q, concentration_gradient))


def bulk_storage(porosity, water_saturation, gas_concentration, water_concentration):
    """Methane mass per bulk volume. Does not assume instantaneous Henry equilibrium."""
    phi = fraction(porosity, "porosity")
    sw = fraction(water_saturation, "water_saturation")
    cg, cw = finite(gas_concentration, "Cg"), finite(water_concentration, "Cw")
    if phi <= 0 or phi >= 1 or min(cg, cw) < 0:
        raise ValueError("Invalid storage parameters")
    return finite(phi*((1-sw)*cg+sw*cw), "bulk storage")


def exchange_soil_air(soil_mass, air_mass, surface_fluxes, face_areas, dt):
    """Conservation witness for GAS-side interface fluxes, positive soil→air.

    Not a transport solver. Rejects overdrawing either compartment rather than
    silently clipping flux; a real integrator must substep/solve consistently.
    Dissolved methane must not be fed here without an explicit exchange model.
    """
    for name, value in (("soil_mass", soil_mass), ("air_mass", air_mass), ("dt", dt)):
        if finite(value, name) < 0:
            raise ValueError("Negative mass or time")
    if len(surface_fluxes) != len(face_areas) or not surface_fluxes:
        raise ValueError("Flux/area arrays must match and be nonempty")
    rate = 0.
    for flux, area in zip(surface_fluxes, face_areas):
        if finite(area, "face_area") <= 0:
            raise ValueError("Nonpositive area")
        rate = finite(rate+finite(flux, "surface_flux")*area, "interface rate")
    moved = finite(rate*dt, "interface mass transfer")
    new_soil = finite(soil_mass-moved, "updated soil mass")
    new_air = finite(air_mass+moved, "updated air mass")
    if new_soil < 0 or new_air < 0:
        raise ValueError("Interface step overdraws mass; reduce dt or solve storage")
    return new_soil, new_air
