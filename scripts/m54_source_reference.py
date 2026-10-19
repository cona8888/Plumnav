"""Analytical 3-D passive-scalar references; no CFD or field validation.

Finite-width Gaussian injection in z>=0, constant horizontal wind and scalar
diffusivity, homogeneous Neumann ground. The image source enforces zero flux.
Mass concentration units: M/L^3. Initial width is a source regularization,
not sensor reach or a soil permeability parameter.
"""
from dataclasses import dataclass
from math import erf, exp, isfinite, pi, sqrt


@dataclass(frozen=True)
class Release:
    diffusivity: float = 0.02
    wind: tuple = (0.2, 0.0)
    source: tuple = (0.0, 0.0, 0.025)
    sigma: float = 0.05

    def __post_init__(self):
        values = (self.diffusivity, self.sigma, *self.wind, *self.source)
        if len(self.wind) != 2 or len(self.source) != 3:
            raise ValueError("Require horizontal wind and a 3-D source")
        if not all(isfinite(v) for v in values):
            raise ValueError("Nonfinite input")
        if self.diffusivity < 0 or self.sigma <= 0 or self.source[2] < 0:
            raise ValueError("Invalid diffusivity, width or source height")


def _state(release, age, mass):
    if not isfinite(age) or age < 0 or not isfinite(mass) or mass < 0:
        raise ValueError("Age and mass must be finite and nonnegative")
    variance = release.sigma**2 + 2 * release.diffusivity * age
    x, y, h = release.source
    return variance, (x + release.wind[0] * age, y + release.wind[1] * age, h)


def pulse(point, age, mass=1.0, release=Release()):
    """Exact concentration for an instantaneous finite-width mass release."""
    variance, (cx, cy, h) = _state(release, age, mass)
    x, y, z = point
    if not all(isfinite(v) for v in point) or z < 0:
        raise ValueError("Point must lie in the finite atmospheric half-space")
    horizontal = exp(-((x-cx)**2 + (y-cy)**2)/(2*variance))
    vertical = exp(-(z-h)**2/(2*variance)) + exp(-(z+h)**2/(2*variance))
    return mass * horizontal * vertical / (2*pi*variance)**1.5


def cell_mass(bounds, age, mass=1.0, release=Release()):
    """Exact volume integral, suitable for conservative FV initialisation."""
    variance, centre = _state(release, age, mass)
    if len(bounds) != 3 or any(lo >= hi for lo, hi in bounds) or bounds[2][0] < 0:
        raise ValueError("Invalid atmospheric cell")
    scale = sqrt(2*variance)
    def interval(pair, c):
        lo, hi = pair
        return 0.5*(erf((hi-c)/scale)-erf((lo-c)/scale))
    return mass * interval(bounds[0], centre[0]) * interval(bounds[1], centre[1]) * (
        interval(bounds[2], centre[2]) + interval(bounds[2], -centre[2]))


def continuous(point, time, rate=1.0, stop=None, panels=1024, release=Release()):
    """Midpoint time quadrature of a constant-rate finite-width injection.

    This is an approximate temporal integral of the exact pulse kernel.
    A quadrature-refinement check is required before using it as an oracle.
    """
    if not isfinite(time) or time < 0 or not isfinite(rate) or rate < 0:
        raise ValueError("Invalid time or rate")
    if not isinstance(panels, int) or isinstance(panels, bool) or panels < 1:
        raise ValueError("Positive integer panel count required")
    if stop is not None and (not isfinite(stop) or stop < 0):
        raise ValueError("Invalid release stop time")
    duration = time if stop is None else min(time, stop)
    # Validate location even for a zero-duration release.
    pulse(point, 0, 0, release)
    dt = duration/panels
    return rate*dt*sum(pulse(point, time-(i+0.5)*dt, 1, release) for i in range(panels))
