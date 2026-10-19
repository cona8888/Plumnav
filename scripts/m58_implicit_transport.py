"""Bounded backward-Euler methane transport for the M56 soil cross-section.

Uses the same cell-centred finite-volume faces, first-order upwind advection and
central diffusion as M56, but solves each transport step implicitly as an
M-matrix. This removes the explicit stability restriction; it does not increase
spatial order or by itself resolve M57's early-breakthrough grid sensitivity.
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


@dataclass(frozen=True)
class ImplicitResult:
    state: CrossSectionState
    surface_flux_kg_m2_s: tuple[float, ...]
    leak_flux_kg_m2_s: tuple[float, ...]
    stored_mass_kg_m: float
    mass_balance_error_kg_m: float
    time_steps: int
    linear_iterations: int
    maximum_linear_update_kg_m3: float


def _properties(config):
    capacity, diffusivity = [], []
    for soil, sw in zip(config.soils, config.water_saturation):
        gas = 1-sw
        capacity.append(soil.porosity*gas)
        diffusivity.append(bulk_diffusivity_mq(soil.porosity, gas,
                                               config.free_diffusivity_m2_s))
    return tuple(capacity), tuple(diffusivity)


def _add_face(diagonal, off_diagonal, a, b, volume_rate, diffusion_rate):
    """Add internal face rate positive from cell a to b."""
    if volume_rate >= 0:
        coefficient_a = volume_rate+diffusion_rate
        coefficient_b = -diffusion_rate
    else:
        coefficient_a = diffusion_rate
        coefficient_b = volume_rate-diffusion_rate
    diagonal[a] += coefficient_a
    off_diagonal[a][b] += coefficient_b
    diagonal[b] += -coefficient_b
    off_diagonal[b][a] += -coefficient_a


def _add_dirichlet_boundary(diagonal, boundary_rhs, cell, outward_volume_rate,
                            diffusion_rate, boundary_concentration):
    """Add outward-normal upwind and diffusive rate at a Dirichlet face."""
    if outward_volume_rate >= 0:
        diagonal[cell] += outward_volume_rate+diffusion_rate
        boundary_rhs[cell] += diffusion_rate*boundary_concentration
    else:
        diagonal[cell] += diffusion_rate
        boundary_rhs[cell] += (diffusion_rate-outward_volume_rate)*boundary_concentration


def _assemble_transport(config, pressure, capacity, diffusivity):
    nx, nz = config.nx, config.nz
    dx, dz = config.width_m/nx, config.depth_m/nz
    count = nx*nz
    diagonal = [0.0]*count
    off = [dict() for _ in range(count)]
    for row in off:
        # Populated lazily through setdefault-compatible wrapper below.
        pass

    class MissingZero(dict):
        def __missing__(self, key):
            return 0.0

    off = [MissingZero() for _ in range(count)]
    boundary_rhs = [0.0]*count
    for iz in range(nz):
        for face in range(1, nx):
            left, right = iz*nx+face-1, iz*nx+face
            q_rate = pressure.qx_m_s[iz*(nx+1)+face]*dz
            d_rate = _harmonic(diffusivity[left], diffusivity[right])*dz/dx
            _add_face(diagonal, off, left, right, q_rate, d_rate)
    for face in range(1, nz):
        for ix in range(nx):
            lower, upper = (face-1)*nx+ix, face*nx+ix
            q_rate = pressure.qz_m_s[face*nx+ix]*dx
            d_rate = _harmonic(diffusivity[lower], diffusivity[upper])*dx/dz
            _add_face(diagonal, off, lower, upper, q_rate, d_rate)
    for ix in config.leak_bottom_cells:
        cell = ix
        # Positive qz enters at the bottom, hence negative outward rate.
        outward = -pressure.qz_m_s[ix]*dx
        _add_dirichlet_boundary(diagonal, boundary_rhs, cell, outward,
                                2*diffusivity[cell]*dx/dz,
                                config.leak_concentration_kg_m3_gas)
    for ix in range(nx):
        cell = (nz-1)*nx+ix
        outward = pressure.qz_m_s[nz*nx+ix]*dx
        _add_dirichlet_boundary(diagonal, boundary_rhs, cell, outward,
                                2*diffusivity[cell]*dx/dz,
                                config.ambient_concentration_kg_m3_gas)
    return diagonal, off, boundary_rhs


def _boundary_fluxes(config, pressure, concentrations, diffusivity):
    nx, nz = config.nx, config.nz
    dx, dz = config.width_m/nx, config.depth_m/nz
    leak = [0.0]*nx
    for ix in config.leak_bottom_cells:
        q = pressure.qz_m_s[ix]
        cell = ix
        leak[ix] = (q*(config.leak_concentration_kg_m3_gas if q >= 0 else concentrations[cell])
                    +2*diffusivity[cell]*(config.leak_concentration_kg_m3_gas-concentrations[cell])/dz)
    surface = [0.0]*nx
    for ix in range(nx):
        cell = (nz-1)*nx+ix
        q = pressure.qz_m_s[nz*nx+ix]
        surface[ix] = (q*(concentrations[cell] if q >= 0 else config.ambient_concentration_kg_m3_gas)
                       +2*diffusivity[cell]*(concentrations[cell]-config.ambient_concentration_kg_m3_gas)/dz)
    return tuple(leak), tuple(surface)


def advance_implicit(config, pressure, state, duration_s, maximum_timestep_s=None,
                     linear_tolerance_kg_m3=1e-11, maximum_linear_iterations=20000):
    if type(config) is not CrossSectionConfig or type(pressure) is not PressureField or type(state) is not CrossSectionState:
        raise TypeError("Config, PressureField and CrossSectionState required")
    duration = _finite(duration_s, "duration", 0)
    tolerance = _finite(linear_tolerance_kg_m3, "linear tolerance", 0)
    if tolerance == 0 or type(maximum_linear_iterations) is not int or maximum_linear_iterations < 1:
        raise ValueError("Positive linear tolerance and iteration limit required")
    nx, nz = config.nx, config.nz
    count = nx*nz
    if len(state.concentration_kg_m3_gas) != count:
        raise ValueError("State dimensions do not match config")
    if len(pressure.pressure_pa) != count or len(pressure.qx_m_s) != nz*(nx+1) or len(pressure.qz_m_s) != (nz+1)*nx:
        raise ValueError("Pressure dimensions do not match config")
    capacity, diffusivity = _properties(config)
    dx, dz = config.width_m/nx, config.depth_m/nz
    cell_volume = dx*dz
    if duration == 0:
        leak, surface = _boundary_fluxes(config, pressure,
                                         state.concentration_kg_m3_gas, diffusivity)
        return ImplicitResult(state, surface, leak, stored_mass(config, state.concentration_kg_m3_gas),
                              0.0, 0, 0, 0.0)
    max_step = duration if maximum_timestep_s is None else _finite(maximum_timestep_s,
                                                                   "maximum timestep", 0)
    if max_step <= 0:
        raise ValueError("Maximum timestep must be positive")
    steps = max(1, int(duration/max_step)+(0 if duration % max_step == 0 else 1))
    dt = duration/steps
    transport_diagonal, off, boundary_rhs = _assemble_transport(
        config, pressure, capacity, diffusivity)
    concentration = list(state.concentration_kg_m3_gas)
    initial_mass = stored_mass(config, concentration)
    cumulative_in = state.cumulative_leak_input_kg_m
    cumulative_out = state.cumulative_surface_output_kg_m
    total_iterations = 0
    final_update = 0.0
    for _ in range(steps):
        transient = [theta*cell_volume/dt for theta in capacity]
        diagonal = [transient[i]+transport_diagonal[i] for i in range(count)]
        rhs = [transient[i]*concentration[i]+boundary_rhs[i] for i in range(count)]
        solution = concentration[:]
        for iteration in range(1, maximum_linear_iterations+1):
            maximum_update = 0.0
            for i in range(count):
                updated = (rhs[i]-sum(value*solution[j] for j, value in off[i].items()))/diagonal[i]
                if updated < 0 or not isfinite(updated):
                    raise ValueError("Implicit solve lost positivity/finite state")
                maximum_update = max(maximum_update, abs(updated-solution[i]))
                solution[i] = updated
            if maximum_update <= tolerance:
                break
        else:
            raise ValueError("Implicit transport solver did not converge")
        total_iterations += iteration
        final_update = maximum_update
        concentration = solution
        leak, surface = _boundary_fluxes(config, pressure, concentration, diffusivity)
        cumulative_in += sum(leak)*dx*dt
        cumulative_out += sum(surface)*dx*dt
    final_mass = stored_mass(config, concentration)
    expected = (initial_mass+(cumulative_in-state.cumulative_leak_input_kg_m)
                -(cumulative_out-state.cumulative_surface_output_kg_m))
    new_state = CrossSectionState(state.time_s+duration, tuple(concentration),
                                  cumulative_in, cumulative_out)
    return ImplicitResult(new_state, surface, leak, final_mass,
                          _finite(final_mass-expected, "mass balance error"),
                          steps, total_iterations, final_update)
