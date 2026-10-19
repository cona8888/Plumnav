import { activeSniffKernel } from '../../src/sim/activeSniff'
import { dot, magnitude, normalize, sub } from '../../src/sim/math'
import type { QuadSniffStatus, Vec2 } from '../../src/sim/types'

/** Research-only hypothesis. Not a calibrated probability or a source declaration. */
export const FLOW_SOURCE_POLICY = Object.freeze({
  version: 'flow-source-residual-v1',
  minimumSupport: 0.95,
  centralWindowSeconds: 6,
  minimumCentralSamples: 8,
  maximumCentralAgeSeconds: 1.25,
  diffusivityFactors: [0.5, 2] as const,
  windComponentUncertaintyFraction: 0.35,
  noiseMultiplier: 3,
  finalWindowScans: 6,
  requiredPositiveScans: 4,
  lossLowerBound: 0,
  activeEntrainmentCalibration: 0.67,
})

export type CentralSample = { time: number; concentration: number }
type Input = {
  position: Vec2; time: number; cycleSeconds: number; quad: QuadSniffStatus;
  central: CentralSample[]; wind: Vec2; diffusivity: number;
  sensorNoise: number; sensorSaturation: number;
  isBlocked: (point: Vec2, clearance?: number) => boolean;
}
export type FlowSourceEvidence = {
  usable: boolean; positive: boolean; reason: string;
  lowerBound: number | null; nominalResidual: number | null;
  centralPrediction: number | null; temporalDerivative: number | null;
  gradient: Vec2 | null; laplacian: number | null; maximumNoiseBound: number | null;
}
const unavailable = (reason: string): FlowSourceEvidence => ({ usable: false, positive: false, reason,
  lowerBound: null, nominalResidual: null, centralPrediction: null, temporalDerivative: null,
  gradient: null, laplacian: null, maximumNoiseBound: null })

const inverse = (matrix: number[][]) => {
  const n = matrix.length
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => Number(i === j))])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row
    if (Math.abs(a[pivot]![col]!) < 1e-9) return null
    ;[a[col], a[pivot]] = [a[pivot]!, a[col]!]
    const divisor = a[col]![col]!
    a[col] = a[col]!.map((v) => v / divisor)
    for (let row = 0; row < n; row++) if (row !== col) {
      const factor = a[row]![col]!
      a[row] = a[row]!.map((v, j) => v - factor * a[col]![j]!)
    }
  }
  return a.map((row) => row.slice(n))
}
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

/**
 * Fits a local axis-aligned quadratic through central passive and four channel
 * observations. Active channels use the calibrated footprint's first AND
 * second moments, not a fictitious point at the footprint centroid.
 * R = dC/dt + u.grad(C) - D.laplacian(C) is the nonconservative transport
 * residual; a nonnegative loss term is omitted for a conservative lower bound.
 * No plume, source coordinate, emission rate or target-presence input is accepted.
 */
export const evaluateFlowSourceEvidence = (input: Input): FlowSourceEvidence => {
  const p = FLOW_SOURCE_POLICY
  const readings = input.quad.readings ?? []
  if (readings.length !== 4 || new Set(readings.map((r) => r.channel)).size !== 4) return unavailable('four channels required')
  if (![input.time, input.cycleSeconds, input.diffusivity, input.sensorNoise, input.sensorSaturation,
    input.wind.x, input.wind.y, input.position.x, input.position.y].every(Number.isFinite) ||
    input.diffusivity <= 0 || input.sensorNoise < 0 || input.cycleSeconds <= 0 || input.sensorSaturation <= 0) {
    return unavailable('invalid calibration')
  }
  if (readings.some((r) => !Number.isFinite(r.concentration) || r.concentration < 0 ||
      r.saturated || r.concentration >= input.sensorSaturation || r.support < p.minimumSupport)) {
    return unavailable('clipped or unsupported channel')
  }
  const samples = input.central.filter((s) => s.time >= input.time - p.centralWindowSeconds && s.time <= input.time)
  if (samples.length < p.minimumCentralSamples || samples.some((s) => !Number.isFinite(s.time) ||
      !Number.isFinite(s.concentration) || s.concentration < 0 || s.concentration >= input.sensorSaturation)) {
    return unavailable('insufficient or clipped central samples')
  }
  if (input.time - Math.max(...samples.map((s) => s.time)) > p.maximumCentralAgeSeconds) return unavailable('stale central samples')
  const meanTime = sum(samples.map((s) => s.time)) / samples.length
  const sxx = sum(samples.map((s) => (s.time - meanTime) ** 2))
  if (sxx < 1) return unavailable('insufficient temporal span')
  const targetTime = input.time - input.cycleSeconds / 2
  const derivativeWeights = samples.map((s) => (s.time - meanTime) / sxx)
  const predictionWeights = derivativeWeights.map((w) => 1 / samples.length + (targetTime - meanTime) * w)
  const center = sum(samples.map((s, i) => predictionWeights[i]! * s.concentration))
  const derivative = sum(samples.map((s, i) => derivativeWeights[i]! * s.concentration))
  if (center <= p.noiseMultiplier * input.sensorNoise || center >= input.sensorSaturation) return unavailable('central signal below noise floor or clipped')
  const meanC = sum(samples.map((s) => s.concentration)) / samples.length
  const trendRms = Math.sqrt(sum(samples.map((s) => (s.concentration - meanC - derivative * (s.time - meanTime)) ** 2)) / samples.length)
  const centralSigma = Math.max(input.sensorNoise, trendRms)
  const axis = normalize(input.quad.forward)
  if (magnitude(input.quad.forward) < 1e-9) return unavailable('invalid sensor orientation')
  const side = { x: -axis.y, y: axis.x }
  const h = Math.max(...readings.map((r) => r.reach))
  if (!Number.isFinite(h) || h <= 0) return unavailable('invalid footprint reach')
  const rows: number[][] = []
  for (const r of readings) {
    const passive = input.quad.samplingMode === 'passive-array'
    const kernel = passive
      ? [{ point: { x: input.position.x + r.effectiveOffset.x, y: input.position.y + r.effectiveOffset.y }, weight: 1 }]
      : activeSniffKernel(input.position, r.direction, r.reach, input.isBlocked)
    const gain = passive ? 1 : p.activeEntrainmentCalibration * input.quad.strength * r.support
    if (gain <= 0 || kernel.length === 0) return unavailable('no directional sampling gain')
    const row = [0, 0, 0, 0]
    let crossMoment = 0
    for (const sample of kernel) {
      const offset = sub(sample.point, input.position)
      const x = dot(offset, axis) / h; const y = dot(offset, side) / h
      const weight = sample.weight * gain
      row[0]! += weight * x; row[1]! += weight * y
      row[2]! += weight * x * x / 2; row[3]! += weight * y * y / 2
      crossMoment += weight * x * y
    }
    // Four directional observations cannot identify the fifth (xy) coefficient.
    // Refuse asymmetric clipping rather than silently assuming it to be zero.
    if (Math.abs(crossMoment) > 1e-8) return unavailable('unidentifiable mixed curvature')
    rows.push(row)
  }
  const inv = inverse(rows)
  if (!inv) return unavailable('singular footprint geometry')
  const coefficients = inv.map((row) => sum(row.map((w, i) => w * (readings[i]!.concentration - center))))
  const gradient = { x: (axis.x * coefficients[0]! + side.x * coefficients[1]!) / h,
    y: (axis.y * coefficients[0]! + side.y * coefficients[1]!) / h }
  const laplacian = (coefficients[2]! + coefficients[3]!) / h ** 2
  let lowerBound = Infinity; let maximumNoiseBound = 0
  const windDelta = p.windComponentUncertaintyFraction * magnitude(input.wind)
  for (const dx of [-windDelta, windDelta]) for (const dy of [-windDelta, windDelta]) for (const factor of p.diffusivityFactors) {
    const wind = { x: input.wind.x + dx, y: input.wind.y + dy }
    const diffusivity = factor * input.diffusivity
    const operator = [dot(wind, axis) / h, dot(wind, side) / h, -diffusivity / h ** 2, -diffusivity / h ** 2]
    const channelWeights = readings.map((_, j) => sum(operator.map((v, i) => v * inv[i]![j]!)))
    const centralWeights = predictionWeights.map((w, i) => derivativeWeights[i]! - sum(channelWeights) * w)
    // L1 propagation is conservative to arbitrary correlation given marginal
    // noise scales. It is not a calibrated confidence interval for model error.
    const noiseBound = p.noiseMultiplier * (sum(centralWeights.map((w) => Math.abs(w) * centralSigma)) +
      sum(channelWeights.map((w, i) => Math.abs(w) * input.sensorNoise /
        Math.sqrt(Math.max(1, readings[i]!.effectiveIntegrationSamples)))))
    const residual = derivative + dot(wind, gradient) - diffusivity * laplacian
    lowerBound = Math.min(lowerBound, residual - noiseBound)
    maximumNoiseBound = Math.max(maximumNoiseBound, noiseBound)
  }
  const nominalResidual = derivative + dot(input.wind, gradient) - input.diffusivity * laplacian
  if (![lowerBound, nominalResidual, maximumNoiseBound].every(Number.isFinite)) return unavailable('nonfinite reconstruction')
  return { usable: true, positive: lowerBound > 0, reason: lowerBound > 0 ? 'positive transport residual' : 'no robust positive residual',
    lowerBound, nominalResidual, centralPrediction: center, temporalDerivative: derivative, gradient, laplacian, maximumNoiseBound }
}
