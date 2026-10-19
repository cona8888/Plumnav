import { distance, dot, magnitude, normalize, sub } from '../math'
import type { Vec2 } from '../types'
import type { GradientRay, GradientRayEstimate } from './quadSoilSniff'

/** Conditional first-order uncertainty, not a calibrated confidence guarantee.
 * Independent equal-noise orthogonal local channels give sigma_angle ~ 1/SNR.
 * Gradient directions must converge toward one stationary target. No wind
 * remapping, turbulent-gradient bias, position error or shared drift is included.
 */
export function physicalBearingIntersection(rays: readonly GradientRay[], headSpacing: number,
  inspectionRadius: number): GradientRayEstimate | null {
  if (rays.length < 3 || ![headSpacing, inspectionRadius].every(v => Number.isFinite(v) && v > 0) ||
      rays.some(r => !Number.isFinite(r.angularSigma) || r.angularSigma! <= 0 ||
        !Number.isFinite(r.origin.x) || !Number.isFinite(r.origin.y) ||
        !Number.isFinite(r.direction.x) || !Number.isFinite(r.direction.y) || magnitude(r.direction) < 1e-12)) return null
  // Center and scale the calculation by the physical head, not the world domain.
  const origin = rays[0]!.origin
  const data = rays.map(r => ({ p: { x: (r.origin.x - origin.x) / headSpacing,
    y: (r.origin.y - origin.y) / headSpacing }, d: normalize(r.direction), sigma: r.angularSigma! }))
  const solve = (at: Vec2 | null) => {
    let xx = 0, xy = 0, yy = 0, bx = 0, by = 0
    for (const r of data) {
      const range = at ? Math.max(0.5, distance(at, r.p)) : 1
      const weight = 1 / (range * r.sigma) ** 2
      const nx = -r.d.y, ny = r.d.x, projected = nx * r.p.x + ny * r.p.y
      xx += weight * nx * nx; xy += weight * nx * ny; yy += weight * ny * ny
      bx += weight * nx * projected; by += weight * ny * projected
    }
    const det = xx * yy - xy * xy, trace = xx + yy
    if (!Number.isFinite(det) || det <= 1e-10 * trace * trace || trace <= 0) return null
    return { point: { x: (yy * bx - xy * by) / det, y: (xx * by - xy * bx) / det },
      xx, xy, yy, det, trace }
  }
  let fit = solve(null)
  if (!fit) return null
  for (let i = 0; i < 12; i++) {
    const next = solve(fit.point)
    if (!next) return null
    const change = distance(next.point, fit.point)
    fit = next
    if (change < 1e-8) break
    if (i === 11) return null // Do not advertise covariance for an unconverged fit.
  }
  let squaredResidual = 0, chiSquare = 0, poseSpan = 0
  for (let i = 0; i < data.length; i++) {
    const r = data[i]!, delta = sub(fit.point, r.p), range = magnitude(delta)
    if (range < 0.5 || dot(delta, r.d) <= 0) return null
    const perp = -r.d.y * delta.x + r.d.x * delta.y
    squaredResidual += perp * perp
    const angularError = Math.atan2(perp, dot(delta, r.d))
    chiSquare += (angularError / r.sigma) ** 2
    for (let j = i + 1; j < data.length; j++) poseSpan = Math.max(poseSpan, distance(r.p, data[j]!.p))
  }
  // Residual inflation can widen uncertainty, never shrink it below the model.
  const reducedChiSquare = chiSquare / (data.length - 2)
  const inflation = Math.max(1, reducedChiSquare)
  const lambdaMax = inflation * (fit.trace + Math.hypot(fit.xx - fit.yy, 2 * fit.xy)) / (2 * fit.det)
  const nominalRadius95 = Math.sqrt(5.991464547107979 * lambdaMax) * headSpacing
  const point = { x: origin.x + fit.point.x * headSpacing, y: origin.y + fit.point.y * headSpacing }
  if (![point.x, point.y, nominalRadius95].every(Number.isFinite) ||
      point.x <= 0 || point.x >= 1 || point.y <= 0 || point.y >= 1) return null
  const acceptable = nominalRadius95 <= inspectionRadius && reducedChiSquare <= 9
  // Gaussian isotropic-upper-covariance approximation; a model score, NOT a
  // measured probability of source localisation. Additional 95% gate below.
  const quality = 1 - Math.exp(-((inspectionRadius / headSpacing) ** 2) / (2 * lambdaMax))
  return { point, residual: Math.sqrt(squaredResidual / data.length) * headSpacing,
    geometryQuality: 4 * fit.det / fit.trace ** 2, forwardFraction: 1,
    poseSpan: poseSpan * headSpacing, quality, rayCount: data.length,
    physicalUncertainty: { version: 'linearized-local-bearing-v1', nominalRadius95,
      reducedChiSquare, acceptable } }
}
