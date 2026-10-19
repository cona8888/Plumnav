import { activeSniffKernel } from '../../src/sim/activeSniff'
import { quadSniffChannelDirections, QUAD_PASSIVE_ARRAY_RADIUS } from '../../src/sim/quadSniff'
import { distance, magnitude } from '../../src/sim/math'
import type { QuadSamplingMode, QuadSniffStatus, Vec2 } from '../../src/sim/types'
import { FLOW_SOURCE_POLICY } from './flow-source-evidence'

export const MULTIVIEW_POLICY = Object.freeze({
  version: 'sniff-turn-source-residual-v2-bearing-aligned', windowSeconds: 6,
  spatialScale: 0.065, temporalScaleSeconds: 6, minimumChannelSupport: 0.25,
  maximumCondition: 200, relativeEigenTolerance: 1e-10, estimabilityTolerance: 1e-7,
  minimumRows: 12, minimumCentralSamples: 8,
  secondBearingRadians: Math.PI / 4, fallbackRadius: 0.025,
  turnRateRadiansPerSecond: Math.PI / 2, settleSeconds: 0.5, arrivalRadius: 0.001,
  noiseMultiplier: FLOW_SOURCE_POLICY.noiseMultiplier,
  diffusivityFactors: FLOW_SOURCE_POLICY.diffusivityFactors,
  windComponentUncertaintyFraction: FLOW_SOURCE_POLICY.windComponentUncertaintyFraction,
  finalWindowScans: 6, requiredPositiveScans: 4,
})
export type LocalCentralSample = { time: number; position: Vec2; concentration: number }
export type LocalQuadSample = { time: number; position: Vec2; cycleSeconds: number; quad: QuadSniffStatus }
type MapQuery = (p: Vec2, clearance?: number) => boolean
type Row = { x: number[]; y: number; sigma: number }
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0)
const inner = (a: number[], b: number[]) => sum(a.map((v, i) => v * b[i]!))
const basis = (p: Vec2, anchor: Vec2, time: number, referenceTime: number) => {
  const x = (p.x - anchor.x) / MULTIVIEW_POLICY.spatialScale
  const y = (p.y - anchor.y) / MULTIVIEW_POLICY.spatialScale
  return [1, x, y, x * x / 2, x * y, y * y / 2, (time - referenceTime) / MULTIVIEW_POLICY.temporalScaleSeconds]
}

/** Small symmetric eigensolver; pseudoinverse preserves identifiable operators
 * even if an irrelevant mixed-curvature coefficient is unidentifiable. */
export const designInverse = (rows: number[][]) => {
  const n = 7
  const a = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
    sum(rows.map((r) => r[i]! * r[j]!))))
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Number(i === j)))
  for (let step = 0; step < 300; step++) {
    let p = 0; let q = 1
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (Math.abs(a[i]![j]!) > Math.abs(a[p]![q]!)) { p = i; q = j }
    const scale = Math.max(1, ...a.map((row, i) => Math.abs(row[i]!)))
    if (Math.abs(a[p]![q]!) < 1e-13 * scale) break
    const phi = Math.atan2(2 * a[p]![q]!, a[q]![q]! - a[p]![p]!) / 2
    const c = Math.cos(phi); const s = Math.sin(phi)
    const pp = a[p]![p]!; const qq = a[q]![q]!; const pq = a[p]![q]!
    a[p]![p] = c * c * pp - 2 * s * c * pq + s * s * qq
    a[q]![q] = s * s * pp + 2 * s * c * pq + c * c * qq
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
  const eigen = a.map((row, i) => row[i]!)
  const threshold = Math.max(...eigen, 1e-20) * MULTIVIEW_POLICY.relativeEigenTolerance
  const identified = eigen.map((lambda, i) => ({ lambda, i })).filter((e) => e.lambda > threshold)
  const inv = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
    sum(identified.map((e) => v[i]![e.i]! * v[j]![e.i]! / e.lambda))))
  const nullVectors = eigen.flatMap((lambda, i) => lambda <= threshold ? [v.map((row) => row[i]!)] : [])
  const estimable = (operator: number[]) => Math.sqrt(sum(nullVectors.map((z) => inner(z, operator) ** 2))) <=
    MULTIVIEW_POLICY.estimabilityTolerance * Math.max(1e-12, Math.sqrt(inner(operator, operator)))
  const condition = identified.length ? Math.sqrt(Math.max(...identified.map((e) => e.lambda)) /
    Math.min(...identified.map((e) => e.lambda))) : Infinity
  return { inv, rank: identified.length, condition, estimable }
}

/** Known observation operator only: no plume queries or source truth. */
export const quadMomentRows = (sample: LocalQuadSample, anchor: Vec2, referenceTime: number, isBlocked: MapQuery) => {
  const rows: Array<{ x: number[]; concentration: number; effectiveSamples: number }> = []
  const time = sample.time - sample.cycleSeconds / 2
  for (const reading of sample.quad.readings ?? []) {
    if (!Number.isFinite(reading.support) || reading.support < MULTIVIEW_POLICY.minimumChannelSupport ||
        !Number.isFinite(reading.reach) || reading.reach <= 0 || reading.saturated ||
        !Number.isFinite(reading.concentration) || reading.concentration < 0 ||
        !Number.isFinite(reading.effectiveIntegrationSamples) || reading.effectiveIntegrationSamples < 1) continue
    const passive = sample.quad.samplingMode === 'passive-array'
    const kernel = passive
      ? [{ point: { x: sample.position.x + reading.effectiveOffset.x, y: sample.position.y + reading.effectiveOffset.y }, weight: 1 }]
      : activeSniffKernel(sample.position, reading.direction, reading.reach, isBlocked)
    const gain = passive ? 1 : FLOW_SOURCE_POLICY.activeEntrainmentCalibration * sample.quad.strength * reading.support
    if (!kernel.length || !Number.isFinite(gain) || gain <= 0 || gain > 1) continue
    const row = basis(sample.position, anchor, time, referenceTime).map((x) => (1 - gain) * x)
    for (const k of kernel) for (const [j, value] of basis(k.point, anchor, time, referenceTime).entries()) row[j]! += gain * k.weight * value
    if (row.every(Number.isFinite)) rows.push({ x: row, concentration: reading.concentration,
      effectiveSamples: reading.effectiveIntegrationSamples })
  }
  return rows
}
const requiredOperators = [
  [1, 0, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 1, 0, 1, 0], [0, 0, 0, 0, 0, 0, 1],
]
export type MultiViewEvidence = {
  usable: boolean; positive: boolean; reason: string; rows: number; centralRows: number;
  rank: number; condition: number | null; operatorIdentifiable: boolean;
  nominalResidual: number | null; lowerBound: number | null; fitRms: number | null;
  maximumNoiseBound: number | null; center: number | null; gradient: Vec2 | null; laplacian: number | null;
}
export const evaluateMultiView = (input: {
  anchor: Vec2; time: number; central: LocalCentralSample[]; scans: LocalQuadSample[];
  wind: Vec2; diffusivity: number; sensorNoise: number; sensorSaturation: number; isBlocked: MapQuery;
}): MultiViewEvidence => {
  const result: MultiViewEvidence = { usable: false, positive: false, reason: 'insufficient measurements', rows: 0, centralRows: 0,
    rank: 0, condition: null, operatorIdentifiable: false, nominalResidual: null, lowerBound: null,
    fitRms: null, maximumNoiseBound: null, center: null, gradient: null, laplacian: null }
  if (![input.time, input.anchor.x, input.anchor.y, input.wind.x, input.wind.y, input.diffusivity,
    input.sensorNoise, input.sensorSaturation].every(Number.isFinite) || input.sensorNoise < 0 || input.diffusivity <= 0 || input.sensorSaturation <= 0) {
    return { ...result, reason: 'invalid calibration' }
  }
  const central = input.central.filter((s) => s.time >= input.time - MULTIVIEW_POLICY.windowSeconds && s.time <= input.time &&
    Number.isFinite(s.concentration) && s.concentration >= 0 && s.concentration < input.sensorSaturation &&
    Number.isFinite(s.position.x) && Number.isFinite(s.position.y))
  const rows: Row[] = central.map((s) => ({ x: basis(s.position, input.anchor, s.time, input.time), y: s.concentration, sigma: input.sensorNoise }))
  for (const sample of input.scans) if (sample.time >= input.time - MULTIVIEW_POLICY.windowSeconds && sample.time <= input.time) {
    for (const row of quadMomentRows(sample, input.anchor, input.time, input.isBlocked)) if (row.concentration < input.sensorSaturation) {
      rows.push({ x: row.x, y: row.concentration, sigma: input.sensorNoise / Math.sqrt(row.effectiveSamples) })
    }
  }
  result.rows = rows.length; result.centralRows = central.length
  if (central.length < MULTIVIEW_POLICY.minimumCentralSamples || rows.length < MULTIVIEW_POLICY.minimumRows) return result
  // Equal-weight fit: no fictitious precision from treating correlated channels
  // as independent. The propagated L1 allowance uses each marginal noise scale.
  const d = designInverse(rows.map((r) => r.x))
  result.rank = d.rank; result.condition = Number.isFinite(d.condition) ? d.condition : null
  result.operatorIdentifiable = requiredOperators.every(d.estimable)
  if (!result.operatorIdentifiable) return { ...result, reason: 'transport operator unidentifiable' }
  if (d.condition > MULTIVIEW_POLICY.maximumCondition) return { ...result, reason: 'ill-conditioned geometry' }
  const pseudo = d.inv.map((row) => rows.map((r) => inner(row, r.x)))
  const coefficients = pseudo.map((row) => inner(row, rows.map((r) => r.y)))
  const fitRms = Math.sqrt(sum(rows.map((r) => (r.y - inner(r.x, coefficients)) ** 2)) / rows.length)
  const h = MULTIVIEW_POLICY.spatialScale; const tau = MULTIVIEW_POLICY.temporalScaleSeconds
  const center = coefficients[0]!
  const gradient = { x: coefficients[1]! / h, y: coefficients[2]! / h }
  const laplacian = (coefficients[3]! + coefficients[5]!) / h ** 2
  Object.assign(result, { center, gradient, laplacian, fitRms })
  if (center <= MULTIVIEW_POLICY.noiseMultiplier * input.sensorNoise || center >= input.sensorSaturation) {
    return { ...result, reason: 'central signal below noise floor or clipped' }
  }
  const delta = MULTIVIEW_POLICY.windComponentUncertaintyFraction * magnitude(input.wind)
  let lowerBound = Infinity; let maximumNoiseBound = 0
  for (const wx of [input.wind.x - delta, input.wind.x + delta]) for (const wy of [input.wind.y - delta, input.wind.y + delta]) {
    for (const factor of MULTIVIEW_POLICY.diffusivityFactors) {
      const D = input.diffusivity * factor
      const operator = [0, wx / h, wy / h, -D / h ** 2, 0, -D / h ** 2, 1 / tau]
      if (!d.estimable(operator)) return { ...result, reason: 'transport operator unidentifiable' }
      const weights = rows.map((_, j) => sum(operator.map((value, i) => value * pseudo[i]![j]!)))
      const noiseBound = MULTIVIEW_POLICY.noiseMultiplier * sum(weights.map((w, i) => Math.abs(w) * Math.max(rows[i]!.sigma, fitRms)))
      lowerBound = Math.min(lowerBound, inner(operator, coefficients) - noiseBound)
      maximumNoiseBound = Math.max(maximumNoiseBound, noiseBound)
    }
  }
  const nominalResidual = coefficients[6]! / tau + input.wind.x * gradient.x + input.wind.y * gradient.y - input.diffusivity * laplacian
  if (![lowerBound, nominalResidual, maximumNoiseBound].every(Number.isFinite)) return { ...result, reason: 'nonfinite reconstruction' }
  return { ...result, usable: true, positive: lowerBound > 0, reason: lowerBound > 0 ? 'positive transport residual' : 'no robust positive residual',
    lowerBound, nominalResidual, maximumNoiseBound }
}

/** Calibrated geometry witness, deliberately containing no concentration signal. */
export const geometrySample = (position: Vec2, bearing: number, mode: QuadSamplingMode, reach: number,
  strength: number, isBlocked: MapQuery, time = 0): LocalQuadSample => {
  const forward = { x: Math.cos(bearing), y: Math.sin(bearing) }
  const readings = quadSniffChannelDirections(forward).map(({ channel, direction }) => {
    const r = mode === 'passive-array' ? QUAD_PASSIVE_ARRAY_RADIUS : reach
    const kernel = activeSniffKernel(position, direction, r, isBlocked)
    const head = { x: position.x + direction.x * r, y: position.y + direction.y * r }
    const support = mode === 'passive-array' ? Number(!isBlocked(head, 0.002)) : sum(kernel.map((k) => k.nominalWeight))
    return { channel, direction, reach: r, support, effectiveOffset: { x: direction.x * r, y: direction.y * r },
      concentration: 0, hit: false, saturated: false, integrationSamples: 4, effectiveIntegrationSamples: 3.6 }
  })
  return { position, time, cycleSeconds: 0.75, quad: { scanId: 0, phase: 'return', forward, samplingMode: mode,
    strength, progress: 1, channels: readings, readings } }
}
export const selectSniffTurnPlan = (anchor: Vec2, mode: QuadSamplingMode, reach: number, strength: number,
  isBlocked: MapQuery, maxSpeed: number, initialBearing = 0) => {
  const evaluate = (secondPosition: Vec2) => {
    const rowA = quadMomentRows(geometrySample(anchor, initialBearing, mode, reach, strength, isBlocked, -2.5), anchor, 0, isBlocked)
    const rowB = quadMomentRows(geometrySample(secondPosition, initialBearing + MULTIVIEW_POLICY.secondBearingRadians, mode, reach, strength, isBlocked), anchor, 0, isBlocked)
    const rows = [-6, -3, 0].map((t) => basis(anchor, anchor, t, 0))
    // The scheduled settling interval also supplies passive samples at view B.
    rows.push(basis(secondPosition, anchor, -0.5, 0), basis(secondPosition, anchor, 0, 0))
    rows.push(...rowA.map((r) => r.x), ...rowB.map((r) => r.x))
    const d = designInverse(rows)
    return { secondPosition, rank: d.rank, condition: Number.isFinite(d.condition) ? d.condition : null,
      identifiable: requiredOperators.every(d.estimable) && d.condition <= MULTIVIEW_POLICY.maximumCondition }
  }
  const rotation = evaluate(anchor)
  if (rotation.identifiable) return { ...rotation, mode: 'turn-only' as const }
  const candidates = []
  for (let i = 0; i < 8; i++) {
    const p = { x: anchor.x + MULTIVIEW_POLICY.fallbackRadius * Math.cos(i * Math.PI / 4),
      y: anchor.y + MULTIVIEW_POLICY.fallbackRadius * Math.sin(i * Math.PI / 4) }
    const steps = Math.ceil(distance(anchor, p) / 0.003)
    const blocked = Array.from({ length: steps + 1 }, (_, j) => ({
      x: anchor.x + (p.x - anchor.x) * j / steps, y: anchor.y + (p.y - anchor.y) * j / steps,
    })).some((point) => isBlocked(point, 0.014))
    // Time bound is deliberately additive even if turning and translation can overlap.
    const transitionTime = distance(anchor, p) / maxSpeed + MULTIVIEW_POLICY.secondBearingRadians /
      MULTIVIEW_POLICY.turnRateRadiansPerSecond + MULTIVIEW_POLICY.settleSeconds
    if (!blocked && transitionTime <= 1.75) candidates.push(evaluate(p))
  }
  const best = candidates.filter((c) => c.identifiable).sort((a, b) => a.condition! - b.condition!)[0]
  return best ? { ...best, mode: 'turn-and-reposition' as const } : { ...rotation, mode: 'geometry-unavailable' as const }
}
