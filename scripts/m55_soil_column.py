"""Verified-development 1-D frozen-moisture soil column.

The coordinate points upward from a prescribed buried reservoir to the ground.
Pressure and methane concentration are Dirichlet data at the two outer faces.
Gas Darcy flux is steady; dilute methane storage/advection/diffusion is transient.
This is a controlled verification tier, not a crack, invasion, oxidation,
compressible-mixture, lateral-migration or coupled water-gas solver.
"""

from dataclasses import dataclass
from math import isfinite

from m54_soil_closure import SoilClosure, bulk_diffusivity_mq


def _finite(value, name, minimum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value):
        raise ValueError(f"{name} must be finite")
    if minimum is not None and value < minimum:
        raise ValueError(f"{name} must be >= {minimum}")
    return float(value)


def _harmonic(a, b):
    if a <= 0 or b <= 0:
        return 0.0
    return 2*a*b/(a+b)


@dataclass(frozen=True)
class ColumnConfig:
    depth_m: float
    soils: tuple[SoilClosure, ...]  # bottom (release) to top (surface)
    water_saturation: tuple[float, ...]
    gas_viscosity_pa_s: float
    free_diffusivity_m2_s: float
    bottom_pressure_pa: float
    surface_pressure_pa: float
    bottom_concentration_kg_m3_gas: float
    ambient_concentration_kg_m3_gas: float = 0.0

    def __post_init__(self):
        object.__setattr__(self, "soils", tuple(self.soils))
        object.__setattr__(self, "water_saturation", tuple(self.water_saturation))
        _finite(self.depth_m, "depth", 0)
        if self.depth_m == 0 or not self.soils or len(self.soils) != len(self.water_saturation):
            raise ValueError("Positive depth and matching nonempty soil/saturation cells required")
        _finite(self.gas_viscosity_pa_s, "gas viscosity", 0)
        if self.gas_viscosity_pa_s == 0:
            raise ValueError("Gas viscosity must be positive")
        _finite(self.free_diffusivity_m2_s, "free diffusivity", 0)
        for name in ("bottom_pressure_pa", "surface_pressure_pa",
                     "bottom_concentration_kg_m3_gas", "ambient_concentration_kg_m3_gas"):
            _finite(getattr(self, name), name, 0)
        for soil, saturation in zip(self.soils, self.water_saturation):
            if type(soil) is not SoilClosure:
                raise TypeError("Each cell requires a SoilClosure")
            _finite(saturation, "water saturation", 0)
            if saturation > 1:
                raise ValueError("Water saturation must be <= 1")


@dataclass(frozen=True)
class ColumnState:
    time_s: float
    concentration_kg_m3_gas: tuple[float, ...]
    cumulative_bottom_input_kg_m2: float = 0.0
    cumulative_surface_output_kg_m2: float = 0.0

    def __post_init__(self):
        object.__setattr__(self, "concentration_kg_m3_gas",
                           tuple(self.concentration_kg_m3_gas))
        _finite(self.time_s, "state time", 0)
        for concentration in self.concentration_kg_m3_gas:
            _finite(concentration, "state concentration", 0)
        # Transfers are signed: atmospheric back-diffusion makes net surface
        # output negative, so only finiteness—not positivity—is required.
        _finite(self.cumulative_bottom_input_kg_m2, "cumulative bottom transfer")
        _finite(self.cumulative_surface_output_kg_m2, "cumulative surface transfer")


@dataclass(frozen=True)
class StepResult:
    state: ColumnState
    darcy_flux_m_s: float
    bottom_flux_kg_m2_s: float
    surface_flux_kg_m2_s: float
    stored_mass_kg_m2: float
    mass_balance_error_kg_m2: float
    substeps: int


def gas_darcy_flux(config):
    """Return upward q [m/s] from series resistance with diagonal vertical Kz."""
    if type(config) is not ColumnConfig:
        raise TypeError("ColumnConfig required")
    dz = config.depth_m/len(config.soils)
    resistance = 0.0
    for soil, sw in zip(config.soils, config.water_saturation):
        krg = soil.relative_permeability(sw)[1]
        mobility = soil.intrinsic_k_m2[2]*krg/config.gas_viscosity_pa_s
        if mobility <= 0:
            return 0.0
        resistance += dz/mobility
    q = (config.bottom_pressure_pa-config.surface_pressure_pa)/resistance
    return _finite(q, "Darcy flux")


def initial_state(config, concentration=0.0):
    _finite(concentration, "initial concentration", 0)
    return ColumnState(0.0, tuple(float(concentration) for _ in config.soils))


def stored_mass(config, concentrations):
    if len(concentrations) != len(config.soils):
        raise ValueError("Concentration length mismatch")
    dz = config.depth_m/len(config.soils)
    total = 0.0
    for soil, sw, concentration in zip(config.soils, config.water_saturation, concentrations):
        c = _finite(concentration, "concentration", 0)
        total += soil.porosity*(1-sw)*c*dz
    return _finite(total, "stored mass", 0)


def _transport_data(config):
    capacities = []
    diffusivities = []
    for soil, sw in zip(config.soils, config.water_saturation):
        gas_saturation = 1-sw
        capacities.append(soil.porosity*gas_saturation)
        diffusivities.append(bulk_diffusivity_mq(
            soil.porosity, gas_saturation, config.free_diffusivity_m2_s))
    return tuple(capacities), tuple(diffusivities)


def advance(config, state, duration_s, maximum_substep_s=None):
    """Advance using conservative explicit finite volumes and automatic substeps.

    Boundary fluxes are calculated, not prescribed independently. A positive
    surface flux is the atmospheric source per unit area for later coupling.
    """
    if type(config) is not ColumnConfig or type(state) is not ColumnState:
        raise TypeError("ColumnConfig and ColumnState required")
    duration = _finite(duration_s, "duration", 0)
    _finite(state.time_s, "state time", 0)
    _finite(state.cumulative_bottom_input_kg_m2, "cumulative input")
    _finite(state.cumulative_surface_output_kg_m2, "cumulative output")
    concentrations = [_finite(v, "state concentration", 0)
                      for v in state.concentration_kg_m3_gas]
    if len(concentrations) != len(config.soils):
        raise ValueError("State length mismatch")
    if duration == 0:
        mass = stored_mass(config, concentrations)
        return StepResult(state, gas_darcy_flux(config), 0.0, 0.0, mass, 0.0, 0)

    n = len(concentrations)
    dz = config.depth_m/n
    capacity, diffusivity = _transport_data(config)
    if any(value <= 0 for value in capacity):
        raise ValueError("Gas-phase storage vanishes; use a multiphase/dissolved model")
    q = gas_darcy_flux(config)
    if q < 0:
        raise ValueError("This release-to-surface tier requires nonnegative upward Darcy flux")

    # Bound outgoing explicit coefficients in each cell. The factor 0.45 leaves
    # margin below the monotonic forward-Euler limit; this is numerical, not a
    # physical calibration. Boundary half-cell distances are represented by 2D/dz.
    stable = float("inf")
    for i in range(n):
        d_down = 2*diffusivity[i] if i == 0 else _harmonic(diffusivity[i-1], diffusivity[i])
        d_up = 2*diffusivity[i] if i == n-1 else _harmonic(diffusivity[i], diffusivity[i+1])
        outgoing = q + (d_down+d_up)/dz
        if outgoing > 0:
            stable = min(stable, 0.45*capacity[i]*dz/outgoing)
    requested = duration if maximum_substep_s is None else _finite(maximum_substep_s, "maximum substep", 0)
    if requested == 0:
        raise ValueError("Maximum substep must be positive")
    step_limit = min(duration, requested, stable)
    if not isfinite(step_limit) or step_limit <= 0:
        raise ValueError("No finite positive transport step")
    substeps = max(1, int(duration/step_limit)+1)
    dt = duration/substeps

    initial_mass = stored_mass(config, concentrations)
    cumulative_in = state.cumulative_bottom_input_kg_m2
    cumulative_out = state.cumulative_surface_output_kg_m2
    last_bottom = last_surface = 0.0
    for _ in range(substeps):
        flux = [0.0]*(n+1)  # positive upward
        flux[0] = (q*config.bottom_concentration_kg_m3_gas
                   + 2*diffusivity[0]*(config.bottom_concentration_kg_m3_gas-concentrations[0])/dz)
        for face in range(1, n):
            d_face = _harmonic(diffusivity[face-1], diffusivity[face])
            flux[face] = (q*concentrations[face-1]
                          + d_face*(concentrations[face-1]-concentrations[face])/dz)
        flux[n] = (q*concentrations[-1]
                   + 2*diffusivity[-1]*(concentrations[-1]-config.ambient_concentration_kg_m3_gas)/dz)
        updated = []
        for i, concentration in enumerate(concentrations):
            value = concentration + dt*(flux[i]-flux[i+1])/(capacity[i]*dz)
            if value < -1e-12 or not isfinite(value):
                raise ValueError("Transport update lost positivity/finite state")
            updated.append(max(0.0, value))
        concentrations = updated
        cumulative_in += flux[0]*dt
        cumulative_out += flux[n]*dt
        last_bottom, last_surface = flux[0], flux[n]

    final_mass = stored_mass(config, concentrations)
    expected = initial_mass+(cumulative_in-state.cumulative_bottom_input_kg_m2)-(cumulative_out-state.cumulative_surface_output_kg_m2)
    balance_error = final_mass-expected
    new_state = ColumnState(state.time_s+duration, tuple(concentrations), cumulative_in, cumulative_out)
    return StepResult(new_state, q, last_bottom, last_surface, final_mass,
                      _finite(balance_error, "mass balance error"), substeps)
