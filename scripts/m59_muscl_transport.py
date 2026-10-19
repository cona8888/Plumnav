"""Conservative bounded MUSCL transport for the M56 soil cross-section.

Advection uses monotonized-central limited piecewise-linear reconstruction;
diffusion uses the existing central harmonic face coefficient. Time integration
is two-stage SSP RK2. The scheme is second order for smooth advection away from
limiter extrema, but intentionally reverts toward first order near sharp fronts.
"""

from dataclasses import dataclass
from math import isfinite

from m54_soil_closure import bulk_diffusivity_mq
from m56_soil_cross_section import (CrossSectionConfig, CrossSectionState,
                                    PressureField, stored_mass)


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


def _minmod(*values):
    if all(value > 0 for value in values):
        return min(values)
    if all(value < 0 for value in values):
        return max(values)
    return 0.0


@dataclass(frozen=True)
class MusclResult:
    state: CrossSectionState
    surface_flux_kg_m2_s: tuple[float, ...]
    leak_flux_kg_m2_s: tuple[float, ...]
    stored_mass_kg_m: float
    mass_balance_error_kg_m: float
    substeps: int
    minimum_concentration_kg_m3: float
    maximum_concentration_kg_m3: float


def _properties(config):
    capacity, diffusivity = [], []
    for soil, sw in zip(config.soils, config.water_saturation):
        gas = 1-sw
        capacity.append(soil.porosity*gas)
        diffusivity.append(bulk_diffusivity_mq(soil.porosity, gas,
                                               config.free_diffusivity_m2_s))
    return tuple(capacity), tuple(diffusivity)


def _slopes(config, concentration):
    nx, nz = config.nx, config.nz
    dx, dz = config.width_m/nx, config.depth_m/nz
    sx, sz = [0.0]*(nx*nz), [0.0]*(nx*nz)
    for iz in range(nz):
        for ix in range(nx):
            i = iz*nx+ix
            if 0 < ix < nx-1:
                left, right = concentration[i-1], concentration[i+1]
                sx[i] = _minmod(2*(concentration[i]-left)/dx,
                                (right-left)/(2*dx),
                                2*(right-concentration[i])/dx)
            if 0 < iz < nz-1:
                lower, upper = concentration[i-nx], concentration[i+nx]
                sz[i] = _minmod(2*(concentration[i]-lower)/dz,
                                (upper-lower)/(2*dz),
                                2*(upper-concentration[i])/dz)
    return sx, sz


def _bounded_face(value, neighbour, reconstructed):
    return max(min(value, neighbour), min(max(value, neighbour), reconstructed))


def _operator(config, pressure, concentration, capacity, diffusivity):
    nx, nz = config.nx, config.nz
    dx, dz = config.width_m/nx, config.depth_m/nz
    sx, sz = _slopes(config, concentration)
    jx = [0.0]*(nz*(nx+1))
    for iz in range(nz):
        for face in range(1, nx):
            left, right = iz*nx+face-1, iz*nx+face
            q = pressure.qx_m_s[iz*(nx+1)+face]
            left_face = _bounded_face(concentration[left], concentration[right],
                                      concentration[left]+.5*dx*sx[left])
            right_face = _bounded_face(concentration[right], concentration[left],
                                       concentration[right]-.5*dx*sx[right])
            upwind = left_face if q >= 0 else right_face
            d = _harmonic(diffusivity[left], diffusivity[right])
            jx[iz*(nx+1)+face] = q*upwind-d*(concentration[right]-concentration[left])/dx
    jz = [0.0]*((nz+1)*nx)
    for ix in config.leak_bottom_cells:
        q, cell = pressure.qz_m_s[ix], ix
        upwind = config.leak_concentration_kg_m3_gas if q >= 0 else concentration[cell]
        jz[ix] = (q*upwind+2*diffusivity[cell]
                  *(config.leak_concentration_kg_m3_gas-concentration[cell])/dz)
    for face in range(1, nz):
        for ix in range(nx):
            lower, upper = (face-1)*nx+ix, face*nx+ix
            q = pressure.qz_m_s[face*nx+ix]
            lower_face = _bounded_face(concentration[lower], concentration[upper],
                                       concentration[lower]+.5*dz*sz[lower])
            upper_face = _bounded_face(concentration[upper], concentration[lower],
                                       concentration[upper]-.5*dz*sz[upper])
            upwind = lower_face if q >= 0 else upper_face
            d = _harmonic(diffusivity[lower], diffusivity[upper])
            jz[face*nx+ix] = q*upwind-d*(concentration[upper]-concentration[lower])/dz
    for ix in range(nx):
        cell = (nz-1)*nx+ix
        q = pressure.qz_m_s[nz*nx+ix]
        upwind = concentration[cell] if q >= 0 else config.ambient_concentration_kg_m3_gas
        jz[nz*nx+ix] = (q*upwind+2*diffusivity[cell]
                        *(concentration[cell]-config.ambient_concentration_kg_m3_gas)/dz)
    derivative = [0.0]*(nx*nz)
    for iz in range(nz):
        for ix in range(nx):
            i = iz*nx+ix
            net = ((jx[iz*(nx+1)+ix]-jx[iz*(nx+1)+ix+1])*dz
                   +(jz[iz*nx+ix]-jz[(iz+1)*nx+ix])*dx)
            derivative[i] = net/(capacity[i]*dx*dz)
    return derivative, tuple(jz[:nx]), tuple(jz[nz*nx:])


def _stable_step(config, pressure, capacity, diffusivity):
    nx, nz = config.nx, config.nz
    dx, dz = config.width_m/nx, config.depth_m/nz
    leak = set(config.leak_bottom_cells)
    stable = float("inf")
    for iz in range(nz):
        for ix in range(nx):
            i = iz*nx+ix
            outgoing = 0.0
            ql = pressure.qx_m_s[iz*(nx+1)+ix]
            qr = pressure.qx_m_s[iz*(nx+1)+ix+1]
            qd = pressure.qz_m_s[iz*nx+ix]
            qu = pressure.qz_m_s[(iz+1)*nx+ix]
            outgoing += (max(-ql, 0)+max(qr, 0))*dz
            outgoing += (max(-qd, 0)+max(qu, 0))*dx
            if ix > 0:
                outgoing += _harmonic(diffusivity[i], diffusivity[i-1])*dz/dx
            if ix+1 < nx:
                outgoing += _harmonic(diffusivity[i], diffusivity[i+1])*dz/dx
            if iz > 0:
                outgoing += _harmonic(diffusivity[i], diffusivity[i-nx])*dx/dz
            elif ix in leak:
                outgoing += 2*diffusivity[i]*dx/dz
            if iz+1 < nz:
                outgoing += _harmonic(diffusivity[i], diffusivity[i+nx])*dx/dz
            else:
                outgoing += 2*diffusivity[i]*dx/dz
            if outgoing > 0:
                stable = min(stable, .2*capacity[i]*dx*dz/outgoing)
    return stable


def advance_muscl(config, pressure, state, duration_s, maximum_substep_s=None,
                  bound_tolerance_kg_m3=1e-7):
    if type(config) is not CrossSectionConfig or type(pressure) is not PressureField or type(state) is not CrossSectionState:
        raise TypeError("Config, PressureField and CrossSectionState required")
    duration = _finite(duration_s, "duration", 0)
    bound_tolerance = _finite(bound_tolerance_kg_m3, "bound tolerance", 0)
    if bound_tolerance == 0:
        raise ValueError("Bound tolerance must be positive")
    count = config.nx*config.nz
    if len(state.concentration_kg_m3_gas) != count:
        raise ValueError("State dimensions do not match config")
    if len(pressure.pressure_pa) != count or len(pressure.qx_m_s) != config.nz*(config.nx+1) or len(pressure.qz_m_s) != (config.nz+1)*config.nx:
        raise ValueError("Pressure dimensions do not match config")
    capacity, diffusivity = _properties(config)
    concentration = list(state.concentration_kg_m3_gas)
    _, bottom, top = _operator(config, pressure, concentration, capacity, diffusivity)
    if duration == 0:
        return MusclResult(state, top, bottom, stored_mass(config, concentration), 0., 0,
                           min(concentration), max(concentration))
    requested = duration if maximum_substep_s is None else _finite(maximum_substep_s,
                                                                    "maximum substep", 0)
    if requested <= 0:
        raise ValueError("Maximum substep must be positive")
    step_limit = min(duration, requested, _stable_step(config, pressure, capacity, diffusivity))
    if not isfinite(step_limit) or step_limit <= 0:
        raise ValueError("No finite positive MUSCL step")
    substeps = max(1, int(duration/step_limit)+1)
    dt = duration/substeps
    dx = config.width_m/config.nx
    initial_mass = stored_mass(config, concentration)
    cumulative_in = state.cumulative_leak_input_kg_m
    cumulative_out = state.cumulative_surface_output_kg_m
    global_upper = max(concentration+[config.leak_concentration_kg_m3_gas,
                                      config.ambient_concentration_kg_m3_gas])
    for _ in range(substeps):
        d0, bottom0, top0 = _operator(config, pressure, concentration, capacity, diffusivity)
        stage = [c+dt*d for c, d in zip(concentration, d0)]
        # Pressure is iterative, so its local divergence residual can perturb a
        # constant tracer. The explicit tolerance is checked, not silently
        # tightened by clipping the conservative upper state.
        if any(not isfinite(c) or c < -bound_tolerance
               or c > global_upper+bound_tolerance for c in stage):
            raise ValueError("MUSCL stage left the declared concentration bounds")
        # Retain permitted upper round-off so conservation is not altered merely
        # to print an exact maximum. Only tiny negative round-off is repaired.
        stage = [max(0.0, c) for c in stage]
        d1, bottom1, top1 = _operator(config, pressure, stage, capacity, diffusivity)
        updated = [.5*c+.5*(s+dt*d) for c, s, d in zip(concentration, stage, d1)]
        if any(not isfinite(c) or c < -bound_tolerance
               or c > global_upper+bound_tolerance for c in updated):
            raise ValueError("MUSCL update left the declared concentration bounds")
        concentration = [max(0.0, c) for c in updated]
        cumulative_in += .5*dt*dx*(sum(bottom0)+sum(bottom1))
        cumulative_out += .5*dt*dx*(sum(top0)+sum(top1))
    _, bottom, top = _operator(config, pressure, concentration, capacity, diffusivity)
    final_mass = stored_mass(config, concentration)
    expected = (initial_mass+(cumulative_in-state.cumulative_leak_input_kg_m)
                -(cumulative_out-state.cumulative_surface_output_kg_m))
    new_state = CrossSectionState(state.time_s+duration, tuple(concentration),
                                  cumulative_in, cumulative_out)
    return MusclResult(new_state, top, bottom, final_mass,
                       _finite(final_mass-expected, "mass balance error"), substeps,
                       min(concentration), max(concentration))
