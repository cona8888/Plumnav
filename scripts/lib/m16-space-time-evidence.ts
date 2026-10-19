import { activeSniffKernel } from '../../src/sim/activeSniff'
import type { Vec2 } from '../../src/sim/types'
import { MULTIVIEW_POLICY, type LocalCentralSample, type LocalQuadSample } from './multiview-source-evidence'

export const M16_POLICY = Object.freeze({ version: 'joint-space-time-two-scale-v1',
  windowSeconds: 6, spatialScale: 0.065, temporalScale: 6, dimensions: 12,
  relativeEigenTolerance: 1e-12, operatorTolerance: 1e-6,
  minimumCentralSamples: 8, minimumRows: 12, minimumSupport: 0.25,
  noiseMultiplier: 3, diffusivityFactors: [0.5, 2], windFraction: 0.35,
})
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0)
const dot = (a: number[], b: number[]) => sum(a.map((v, i) => v * b[i]!))
export const spaceTimeBasis = (p: Vec2, anchor: Vec2, time: number, reference: number) => {
  const X = (p.x - anchor.x) / M16_POLICY.spatialScale
  const Y = (p.y - anchor.y) / M16_POLICY.spatialScale
  const T = (time - reference) / M16_POLICY.temporalScale
  const R2 = X * X + Y * Y
  return [1, X, Y, X * X / 2, X * Y, Y * Y / 2, T, X * T, Y * T, T * T / 2, R2 * T / 2, R2 * R2 / 24]
}

/** Small symmetric pseudoinverse with an explicit operator reconstruction check.
 * Condition is reported, never confused with a physical noise allowance. */
export const spaceTimeInverse = (rows: number[][]) => {
  const n = M16_POLICY.dimensions
  const a = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => sum(rows.map((r) => r[i]! * r[j]!))))
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Number(i === j)))
  for (let iteration = 0; iteration < 2000; iteration++) {
    let p = 0; let q = 1
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (Math.abs(a[i]![j]!) > Math.abs(a[p]![q]!)) { p = i; q = j }
    const scale = Math.max(1, ...a.map((r, i) => Math.abs(r[i]!)))
    if (Math.abs(a[p]![q]!) < 1e-14 * scale) break
    const phi = Math.atan2(2 * a[p]![q]!, a[q]![q]! - a[p]![p]!) / 2
    const c = Math.cos(phi); const s = Math.sin(phi)
    const pp = a[p]![p]!; const qq = a[q]![q]!; const pq = a[p]![q]!
    a[p]![p] = c * c * pp - 2 * c * s * pq + s * s * qq
    a[q]![q] = s * s * pp + 2 * c * s * pq + c * c * qq
    a[p]![q] = 0; a[q]![p] = 0
    for (let k = 0; k < n; k++) {
      if (k !== p && k !== q) {
        const kp = a[k]![p]!; const kq = a[k]![q]!
        a[k]![p] = a[p]![k] = c * kp - s * kq
        a[k]![q] = a[q]![k] = s * kp + c * kq
      }
      const vp = v[k]![p]!; const vq = v[k]![q]!
      v[k]![p] = c * vp - s * vq; v[k]![q] = s * vp + c * vq
    }
  }
  const eigen = a.map((r, i) => r[i]!); const threshold = Math.max(1e-20, ...eigen) * M16_POLICY.relativeEigenTolerance
  const retained = eigen.flatMap((value, i) => value > threshold ? [{ value, i }] : [])
  const inv = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
    sum(retained.map((e) => v[i]![e.i]! * v[j]![e.i]! / e.value))))
  const pseudo = inv.map((row) => rows.map((r) => dot(row, r)))
  const weights = (op: number[]) => rows.map((_, j) => sum(op.map((value, i) => value * pseudo[i]![j]!)))
  const estimable = (op: number[]) => {
    const w = weights(op)
    const residual = op.map((value, i) => sum(rows.map((r, j) => w[j]! * r[i]!)) - value)
    return Math.sqrt(dot(residual, residual)) <= M16_POLICY.operatorTolerance * Math.max(1e-12, Math.sqrt(dot(op, op)))
  }
  const condition = retained.length ? Math.sqrt(Math.max(...retained.map((e) => e.value)) / Math.min(...retained.map((e) => e.value))) : Infinity
  return { pseudo, weights, estimable, rank: retained.length, condition }
}
export type SpaceTimeInput = {
  anchor: Vec2; time: number; central: LocalCentralSample[]; scans: LocalQuadSample[];
  wind: Vec2; diffusivity: number; sensorNoise: number; sensorSaturation: number; integrationStepSeconds: number;
  isBlocked: (p: Vec2, clearance?: number) => boolean;
}
export const spaceTimeRows = (input: SpaceTimeInput) => {
  const central = input.central.filter((s) => s.time >= input.time - 6 && s.time <= input.time &&
    [s.time, s.position.x, s.position.y, s.concentration].every(Number.isFinite) && s.concentration >= 0 && s.concentration < input.sensorSaturation)
  const rows = central.map((s) => ({ x: spaceTimeBasis(s.position, input.anchor, s.time, input.time), y: s.concentration, sigma: input.sensorNoise }))
  for (const sample of input.scans) {
    if (!(sample.time >= input.time - 6 && sample.time <= input.time) || !Number.isFinite(sample.cycleSeconds) || sample.cycleSeconds <= 0) continue
    const intervals = Math.round(sample.cycleSeconds / input.integrationStepSeconds)
    if (intervals < 1 || intervals > 64 || Math.abs(intervals * input.integrationStepSeconds - sample.cycleSeconds) > 1e-9) continue
    for (const r of sample.quad.readings ?? []) {
      if (![r.concentration, r.support, r.reach, r.effectiveIntegrationSamples, r.direction.x, r.direction.y,
        r.effectiveOffset.x, r.effectiveOffset.y, sample.position.x, sample.position.y].every(Number.isFinite) ||
        r.concentration < 0 || r.concentration >= input.sensorSaturation || r.saturated || r.support < 0.25 ||
        r.reach <= 0 || r.effectiveIntegrationSamples < 1 || r.integrationSamples !== intervals + 1) continue
      const passive = sample.quad.samplingMode === 'passive-array'
      const kernel = passive ? [{ point: { x: sample.position.x + r.effectiveOffset.x, y: sample.position.y + r.effectiveOffset.y }, weight: 1 }]
        : activeSniffKernel(sample.position, r.direction, r.reach, input.isBlocked)
      const gain = passive ? 1 : 0.67 * sample.quad.strength * r.support
      if (!kernel.length || !Number.isFinite(gain) || gain <= 0 || gain > 1) continue
      const row = Array<number>(12).fill(0)
      for (let step = 0; step <= intervals; step++) {
        const weight = (step === 0 || step === intervals ? 0.5 : 1) / intervals
        const t = sample.time - sample.cycleSeconds + step * input.integrationStepSeconds
        const base = spaceTimeBasis(sample.position, input.anchor, t, input.time)
        for (let j = 0; j < 12; j++) row[j]! += weight * (1 - gain) * base[j]!
        for (const k of kernel) for (const [j, value] of spaceTimeBasis(k.point, input.anchor, t, input.time).entries()) row[j]! += weight * gain * k.weight * value
      }
      if (row.every(Number.isFinite)) rows.push({ x: row, y: r.concentration, sigma: input.sensorNoise / Math.sqrt(r.effectiveIntegrationSamples) })
    }
  }
  return { rows, centralCount: central.length }
}
export type SpaceTimeFit = { center: number; gradient: Vec2; laplacian: number; temporal: number; residual: number; fitRms: number }
export const evaluateSpaceTime = (input: SpaceTimeInput) => {
  const initial = { usable: false, positive: false, reason: 'invalid calibration', rows: 0, centralRows: 0,
    rank: 0, condition: null as number | null, fit: null as SpaceTimeFit | null,
    lowerBound: null as number | null, maximumNoiseBound: null as number | null, nominalNoiseBound: null as number | null }
  if (![input.time, input.anchor.x, input.anchor.y, input.wind.x, input.wind.y, input.diffusivity,
    input.sensorNoise, input.sensorSaturation, input.integrationStepSeconds].every(Number.isFinite) ||
    input.diffusivity <= 0 || input.sensorNoise < 0 || input.sensorSaturation <= 0 || input.integrationStepSeconds <= 0) return initial
  const { rows, centralCount } = spaceTimeRows(input)
  const result = { ...initial, rows: rows.length, centralRows: centralCount, reason: 'insufficient measurements' }
  if (rows.length < 12 || centralCount < 8) return result
  const d = spaceTimeInverse(rows.map((r) => r.x))
  result.rank = d.rank; result.condition = Number.isFinite(d.condition) ? d.condition : null
  const ops = [0, 1, 2, 6].map((index) => Array.from({ length: 12 }, (_, i) => Number(i === index)))
  ops.push(Array.from({ length: 12 }, (_, i) => Number(i === 3 || i === 5)))
  if (!ops.every(d.estimable)) return { ...result, reason: 'required operator unidentifiable or numerically unresolved' }
  const coefficients = d.pseudo.map((r) => dot(r, rows.map((row) => row.y)))
  const h = M16_POLICY.spatialScale; const tau = M16_POLICY.temporalScale
  const center = coefficients[0]!; const gradient = { x: coefficients[1]! / h, y: coefficients[2]! / h }
  const laplacian = (coefficients[3]! + coefficients[5]!) / h ** 2; const temporal = coefficients[6]! / tau
  const fitRms = Math.sqrt(sum(rows.map((r) => (r.y - dot(r.x, coefficients)) ** 2)) / rows.length)
  const fit = { center, gradient, laplacian, temporal, residual: temporal + input.wind.x * gradient.x + input.wind.y * gradient.y - input.diffusivity * laplacian, fitRms }
  if (![center, gradient.x, gradient.y, laplacian, temporal, fitRms, fit.residual].every(Number.isFinite)) return { ...result, reason: 'nonfinite reconstruction' }
  result.fit = fit
  const operator = (wx: number, wy: number, D: number) => [0, wx / h, wy / h, -D / h ** 2, 0, -D / h ** 2, 1 / tau, 0, 0, 0, 0, 0]
  const allowance = (op: number[]) => 3 * sum(d.weights(op).map((w, i) => Math.abs(w) * Math.max(rows[i]!.sigma, fitRms)))
  result.nominalNoiseBound = allowance(operator(input.wind.x, input.wind.y, input.diffusivity))
  const delta = M16_POLICY.windFraction * Math.hypot(input.wind.x, input.wind.y)
  let lowerBound = Infinity; let maximumNoiseBound = 0
  for (const wx of [input.wind.x - delta, input.wind.x + delta]) for (const wy of [input.wind.y - delta, input.wind.y + delta]) {
    for (const factor of M16_POLICY.diffusivityFactors) {
      const op = operator(wx, wy, input.diffusivity * factor)
      if (!d.estimable(op)) return { ...result, reason: 'residual operator numerically unresolved' }
      const bound = allowance(op)
      lowerBound = Math.min(lowerBound, dot(op, coefficients) - bound); maximumNoiseBound = Math.max(maximumNoiseBound, bound)
    }
  }
  result.lowerBound = lowerBound; result.maximumNoiseBound = maximumNoiseBound
  if (![lowerBound, maximumNoiseBound, result.nominalNoiseBound].every(Number.isFinite)) return { ...result, reason: 'nonfinite uncertainty' }
  if (center <= MULTIVIEW_POLICY.noiseMultiplier * input.sensorNoise || center >= input.sensorSaturation) return { ...result, reason: 'central signal below noise floor or clipped' }
  return { ...result, usable: true, positive: lowerBound > 0, reason: lowerBound > 0 ? 'positive transport residual' : 'no robust positive residual' }
}
