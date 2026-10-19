"""Controlled 2-D vertical frozen-moisture soil cross-section.

x is horizontal and z points upward. A bottom boundary patch represents the
outer boundary of a resolved buried gas reservoir; the full top is exposed to
ambient pressure/concentration. Side walls and the remainder of the bottom are
no-flow. The pressure equation is steady and incompressible; dilute methane is
transient. This is a verification model, not field-calibrated multiphase CFD.
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
class CrossSectionConfig:
    width_m: float
    depth_m: float
    nx: int
    nz: int
    soils: tuple[SoilClosure, ...]  # row-major: bottom row first
    water_saturation: tuple[float, ...]
    leak_bottom_cells: tuple[int, ...]
    gas_viscosity_pa_s: float
    free_diffusivity_m2_s: float
    leak_pressure_pa: float
    surface_pressure_pa: float
    leak_concentration_kg_m3_gas: float
    ambient_concentration_kg_m3_gas: float = 0.0

    def __post_init__(self):
        object.__setattr__(self, "soils", tuple(self.soils))
        object.__setattr__(self, "water_saturation", tuple(self.water_saturation))
        object.__setattr__(self, "leak_bottom_cells", tuple(self.leak_bottom_cells))
        _finite(self.width_m, "width", 0)
        _finite(self.depth_m, "depth", 0)
        if self.width_m == 0 or self.depth_m == 0:
            raise ValueError("Width and depth must be positive")
        if type(self.nx) is not int or type(self.nz) is not int or self.nx < 2 or self.nz < 2:
            raise ValueError("nx and nz must be integers >= 2")
        count = self.nx*self.nz
        if len(self.soils) != count or len(self.water_saturation) != count:
            raise ValueError("Soil and saturation arrays must match nx*nz")
        if not self.leak_bottom_cells or len(set(self.leak_bottom_cells)) != len(self.leak_bottom_cells):
            raise ValueError("Require unique nonempty bottom leak cells")
        if any(type(i) is not int or i < 0 or i >= self.nx for i in self.leak_bottom_cells):
            raise ValueError("Leak cell indices must lie on the bottom row")
        _finite(self.gas_viscosity_pa_s, "gas viscosity", 0)
        if self.gas_viscosity_pa_s == 0:
            raise ValueError("Gas viscosity must be positive")
        _finite(self.free_diffusivity_m2_s, "free diffusivity", 0)
        for name in ("leak_pressure_pa", "surface_pressure_pa",
                     "leak_concentration_kg_m3_gas", "ambient_concentration_kg_m3_gas"):
            _finite(getattr(self, name), name, 0)
        if self.leak_pressure_pa < self.surface_pressure_pa:
            raise ValueError("Controlled release tier requires leak pressure >= surface pressure")
        for soil, sw in zip(self.soils, self.water_saturation):
            if type(soil) is not SoilClosure:
                raise TypeError("Each cell requires a SoilClosure")
            _finite(sw, "water saturation", 0)
            if sw >= 1:
                raise ValueError("This gas-phase tier requires water saturation < 1")


@dataclass(frozen=True)
class PressureField:
    pressure_pa: tuple[float, ...]
    qx_m_s: tuple[float, ...]  # nz rows of nx+1 faces, positive right
    qz_m_s: tuple[float, ...]  # nz+1 rows of nx faces, positive upward
    iterations: int
    maximum_update_pa: float

    def __post_init__(self):
        object.__setattr__(self, "pressure_pa", tuple(self.pressure_pa))
        object.__setattr__(self, "qx_m_s", tuple(self.qx_m_s))
        object.__setattr__(self, "qz_m_s", tuple(self.qz_m_s))
        for value in self.pressure_pa+self.qx_m_s+self.qz_m_s:
            _finite(value, "pressure-field value")
        if type(self.iterations) is not int or self.iterations < 1:
            raise ValueError("Pressure iterations must be a positive integer")
        _finite(self.maximum_update_pa, "maximum pressure update", 0)


@dataclass(frozen=True)
class CrossSectionState:
    time_s: float
    concentration_kg_m3_gas: tuple[float, ...]
    cumulative_leak_input_kg_m: float = 0.0
    cumulative_surface_output_kg_m: float = 0.0

    def __post_init__(self):
        object.__setattr__(self, "concentration_kg_m3_gas",
                           tuple(self.concentration_kg_m3_gas))
        _finite(self.time_s, "state time", 0)
        for value in self.concentration_kg_m3_gas:
            _finite(value, "state concentration", 0)
        _finite(self.cumulative_leak_input_kg_m, "cumulative leak transfer")
        _finite(self.cumulative_surface_output_kg_m, "cumulative surface transfer")


@dataclass(frozen=True)
class CrossSectionResult:
    state: CrossSectionState
    surface_flux_kg_m2_s: tuple[float, ...]
    leak_flux_kg_m2_s: tuple[float, ...]
    stored_mass_kg_m: float
    mass_balance_error_kg_m: float
    substeps: int


def _material(config):
    mobility_x, mobility_z, capacity, diffusivity = [], [], [], []
    for soil, sw in zip(config.soils, config.water_saturation):
        krg = soil.relative_permeability(sw)[1]
        mobility_x.append(soil.intrinsic_k_m2[0]*krg/config.gas_viscosity_pa_s)
        mobility_z.append(soil.intrinsic_k_m2[2]*krg/config.gas_viscosity_pa_s)
        gas_saturation = 1-sw
        capacity.append(soil.porosity*gas_saturation)
        diffusivity.append(bulk_diffusivity_mq(
            soil.porosity, gas_saturation, config.free_diffusivity_m2_s))
    return tuple(mobility_x), tuple(mobility_z), tuple(capacity), tuple(diffusivity)


def solve_pressure(config, tolerance_pa=1e-10, maximum_iterations=100000, relaxation=1.5):
    """Solve div(lambda grad p)=0 by cell-centred finite volumes and SOR."""
    if type(config) is not CrossSectionConfig:
        raise TypeError("CrossSectionConfig required")
    tol = _finite(tolerance_pa, "pressure tolerance", 0)
    if tol == 0 or type(maximum_iterations) is not int or maximum_iterations < 1:
        raise ValueError("Positive tolerance and iteration count required")
    omega = _finite(relaxation, "relaxation", 0)
    if not 0 < omega < 2:
        raise ValueError("SOR relaxation must lie in (0,2)")
    nx, nz = config.nx, config.nz
    dx, dz = config.width_m/nx, config.depth_m/nz
    mobility_x, mobility_z, _, _ = _material(config)
    if any(value <= 0 for value in mobility_x+mobility_z):
        raise ValueError("Pressure solve requires positive gas mobility in every cell")
    leak = set(config.leak_bottom_cells)
    span = config.leak_pressure_pa-config.surface_pressure_pa
    p = [config.surface_pressure_pa+span*(1-(iz+.5)/nz)
         for iz in range(nz) for _ in range(nx)]
    maximum_update = float("inf")
    for iteration in range(1, maximum_iterations+1):
        maximum_update = 0.0
        for iz in range(nz):
            for ix in range(nx):
                index = iz*nx+ix
                numerator = denominator = 0.0
                if ix > 0:
                    conductance = _harmonic(mobility_x[index], mobility_x[index-1])*dz/dx
                    numerator += conductance*p[index-1]; denominator += conductance
                if ix+1 < nx:
                    conductance = _harmonic(mobility_x[index], mobility_x[index+1])*dz/dx
                    numerator += conductance*p[index+1]; denominator += conductance
                if iz > 0:
                    conductance = _harmonic(mobility_z[index], mobility_z[index-nx])*dx/dz
                    numerator += conductance*p[index-nx]; denominator += conductance
                elif ix in leak:
                    conductance = 2*mobility_z[index]*dx/dz
                    numerator += conductance*config.leak_pressure_pa; denominator += conductance
                if iz+1 < nz:
                    conductance = _harmonic(mobility_z[index], mobility_z[index+nx])*dx/dz
                    numerator += conductance*p[index+nx]; denominator += conductance
                else:
                    conductance = 2*mobility_z[index]*dx/dz
                    numerator += conductance*config.surface_pressure_pa; denominator += conductance
                if denominator <= 0:
                    raise ValueError("Disconnected pressure cell")
                target = numerator/denominator
                updated = p[index]+omega*(target-p[index])
                maximum_update = max(maximum_update, abs(updated-p[index]))
                p[index] = updated
        if maximum_update <= tol:
            break
    else:
        raise ValueError("Pressure solver did not converge")

    qx = [0.0]*(nz*(nx+1))
    for iz in range(nz):
        for face in range(1, nx):
            left, right = iz*nx+face-1, iz*nx+face
            qx[iz*(nx+1)+face] = -_harmonic(mobility_x[left], mobility_x[right])*(p[right]-p[left])/dx
    qz = [0.0]*((nz+1)*nx)
    for ix in leak:
        qz[ix] = 2*mobility_z[ix]*(config.leak_pressure_pa-p[ix])/dz
    for face in range(1, nz):
        for ix in range(nx):
            lower, upper = (face-1)*nx+ix, face*nx+ix
            qz[face*nx+ix] = -_harmonic(mobility_z[lower], mobility_z[upper])*(p[upper]-p[lower])/dz
    for ix in range(nx):
        index = (nz-1)*nx+ix
        qz[nz*nx+ix] = 2*mobility_z[index]*(p[index]-config.surface_pressure_pa)/dz
    return PressureField(tuple(p), tuple(qx), tuple(qz), iteration, maximum_update)


def initial_state(config, concentration=0.0):
    _finite(concentration, "initial concentration", 0)
    return CrossSectionState(0.0, (float(concentration),)*(config.nx*config.nz))


def stored_mass(config, concentrations):
    if len(concentrations) != config.nx*config.nz:
        raise ValueError("Concentration length mismatch")
    _, _, capacity, _ = _material(config)
    volume = config.width_m/config.nx*config.depth_m/config.nz
    return _finite(sum(theta*_finite(c, "concentration", 0)*volume
                       for theta, c in zip(capacity, concentrations)), "stored mass", 0)


def advance(config, pressure, state, duration_s, maximum_substep_s=None):
    """Advance conservative dilute transport per unit out-of-plane thickness."""
    if type(config) is not CrossSectionConfig or type(pressure) is not PressureField or type(state) is not CrossSectionState:
        raise TypeError("Config, PressureField and CrossSectionState required")
    duration = _finite(duration_s, "duration", 0)
    nx, nz = config.nx, config.nz
    count = nx*nz
    if len(pressure.pressure_pa) != count or len(pressure.qx_m_s) != nz*(nx+1) or len(pressure.qz_m_s) != (nz+1)*nx:
        raise ValueError("Pressure field dimensions do not match config")
    concentrations = list(state.concentration_kg_m3_gas)
    if len(concentrations) != count:
        raise ValueError("State dimensions do not match config")
    dx, dz = config.width_m/nx, config.depth_m/nz
    _, _, capacity, diffusivity = _material(config)
    leak = set(config.leak_bottom_cells)
    if duration == 0:
        return CrossSectionResult(state, (0.0,)*nx, (0.0,)*nx,
                                  stored_mass(config, concentrations), 0.0, 0)

    # Positivity-oriented explicit stability bound using each cell's outgoing
    # advective and diffusive coefficient (per unit out-of-plane thickness).
    stable = float("inf")
    for iz in range(nz):
        for ix in range(nx):
            index = iz*nx+ix
            outgoing = 0.0
            q_left = pressure.qx_m_s[iz*(nx+1)+ix]
            q_right = pressure.qx_m_s[iz*(nx+1)+ix+1]
            q_down = pressure.qz_m_s[iz*nx+ix]
            q_up = pressure.qz_m_s[(iz+1)*nx+ix]
            outgoing += max(-q_left, 0)*dz+max(q_right, 0)*dz
            outgoing += max(-q_down, 0)*dx+max(q_up, 0)*dx
            if ix > 0:
                outgoing += _harmonic(diffusivity[index], diffusivity[index-1])*dz/dx
            if ix+1 < nx:
                outgoing += _harmonic(diffusivity[index], diffusivity[index+1])*dz/dx
            if iz > 0:
                outgoing += _harmonic(diffusivity[index], diffusivity[index-nx])*dx/dz
            elif ix in leak:
                outgoing += 2*diffusivity[index]*dx/dz
            if iz+1 < nz:
                outgoing += _harmonic(diffusivity[index], diffusivity[index+nx])*dx/dz
            else:
                outgoing += 2*diffusivity[index]*dx/dz
            if outgoing > 0:
                stable = min(stable, .4*capacity[index]*dx*dz/outgoing)
    requested = duration if maximum_substep_s is None else _finite(maximum_substep_s, "maximum substep", 0)
    if requested <= 0:
        raise ValueError("Maximum substep must be positive")
    limit = min(duration, requested, stable)
    if not isfinite(limit) or limit <= 0:
        raise ValueError("No finite positive transport step")
    substeps = max(1, int(duration/limit)+1)
    dt = duration/substeps
    initial_mass = stored_mass(config, concentrations)
    cumulative_in = state.cumulative_leak_input_kg_m
    cumulative_out = state.cumulative_surface_output_kg_m
    final_bottom = [0.0]*nx
    final_top = [0.0]*nx

    for _ in range(substeps):
        jx = [0.0]*(nz*(nx+1))
        for iz in range(nz):
            for face in range(1, nx):
                left, right = iz*nx+face-1, iz*nx+face
                q = pressure.qx_m_s[iz*(nx+1)+face]
                advective = q*(concentrations[left] if q >= 0 else concentrations[right])
                d = _harmonic(diffusivity[left], diffusivity[right])
                jx[iz*(nx+1)+face] = advective-d*(concentrations[right]-concentrations[left])/dx
        jz = [0.0]*((nz+1)*nx)
        for ix in leak:
            q = pressure.qz_m_s[ix]
            cell = ix
            advective = q*(config.leak_concentration_kg_m3_gas if q >= 0 else concentrations[cell])
            jz[ix] = advective+2*diffusivity[cell]*(config.leak_concentration_kg_m3_gas-concentrations[cell])/dz
        for face in range(1, nz):
            for ix in range(nx):
                lower, upper = (face-1)*nx+ix, face*nx+ix
                q = pressure.qz_m_s[face*nx+ix]
                advective = q*(concentrations[lower] if q >= 0 else concentrations[upper])
                d = _harmonic(diffusivity[lower], diffusivity[upper])
                jz[face*nx+ix] = advective-d*(concentrations[upper]-concentrations[lower])/dz
        for ix in range(nx):
            cell = (nz-1)*nx+ix
            q = pressure.qz_m_s[nz*nx+ix]
            advective = q*(concentrations[cell] if q >= 0 else config.ambient_concentration_kg_m3_gas)
            jz[nz*nx+ix] = advective+2*diffusivity[cell]*(concentrations[cell]-config.ambient_concentration_kg_m3_gas)/dz

        updated = [0.0]*count
        for iz in range(nz):
            for ix in range(nx):
                index = iz*nx+ix
                net = ((jx[iz*(nx+1)+ix]-jx[iz*(nx+1)+ix+1])*dz
                       +(jz[iz*nx+ix]-jz[(iz+1)*nx+ix])*dx)
                value = concentrations[index]+dt*net/(capacity[index]*dx*dz)
                if value < 0 or not isfinite(value):
                    raise ValueError("Transport update lost positivity/finite state")
                updated[index] = value
        concentrations = updated
        final_bottom = jz[:nx]
        final_top = jz[nz*nx:(nz+1)*nx]
        cumulative_in += sum(final_bottom)*dx*dt
        cumulative_out += sum(final_top)*dx*dt

    final_mass = stored_mass(config, concentrations)
    expected = (initial_mass+(cumulative_in-state.cumulative_leak_input_kg_m)
                -(cumulative_out-state.cumulative_surface_output_kg_m))
    error = _finite(final_mass-expected, "mass balance error")
    new_state = CrossSectionState(state.time_s+duration, tuple(concentrations),
                                  cumulative_in, cumulative_out)
    return CrossSectionResult(new_state, tuple(final_top), tuple(final_bottom),
                              final_mass, error, substeps)


def surface_flux_summary(config, pressure):
    """Return integrated gas-volume flux and horizontal centroid at the surface."""
    dx = config.width_m/config.nx
    values = pressure.qz_m_s[config.nz*config.nx:(config.nz+1)*config.nx]
    integrated = sum(values)*dx
    if integrated <= 0:
        return integrated, None
    centroid = sum((i+.5)*dx*q for i, q in enumerate(values))*dx/integrated
    return integrated, centroid
