import { designInverse, evaluateMultiView, type MultiViewEvidence } from './multiview-source-evidence'
import { evaluateSpaceTime, spaceTimeInverse, spaceTimeRows, type SpaceTimeInput } from './m16-space-time-evidence'

export const M17_POLICY = Object.freeze({ version: 'paired-prequential-guard-v1',
  windowSeconds: 6, predictionNoiseMultiplier: 3, numericalTolerance: 1e-4,
  maximumPredictionAllowanceFractionOfSaturation: 0.1,
  requiredTestChannels: 8, preferredModel: 'm16', fallbackModel: 'm14',
})
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0)

/** The complete current pair is excluded from BOTH fitting and residual estimation.
 * Only known acquisition geometry, measured concentrations and calibration enter.
 * No field identity, true source, width, period, derivative or residual is accepted. */
export const predictExcludedPair = (input: SpaceTimeInput, pairStart: number, model: 'm14' | 'm16') => {
  const training = { ...input, central: input.central.filter((s) => s.time <= pairStart),
    scans: input.scans.filter((s) => s.time <= pairStart) }
  const heldOut = input.scans.filter((s) => s.time > pairStart && s.time <= input.time)
  const evidence = model === 'm16' ? evaluateSpaceTime(training) : evaluateMultiView(training)
  const simple = evidence as MultiViewEvidence
  const fit = model === 'm16' ? (evidence as ReturnType<typeof evaluateSpaceTime>).fit :
    simple.usable && simple.nominalResidual !== null && simple.gradient !== null && simple.laplacian !== null && simple.center !== null && simple.fitRms !== null ? {
      center: simple.center, gradient: simple.gradient, laplacian: simple.laplacian, fitRms: simple.fitRms,
      residual: simple.nominalResidual, temporal: simple.nominalResidual - input.wind.x * simple.gradient.x - input.wind.y * simple.gradient.y + input.diffusivity * simple.laplacian,
    } : null
  const initial = { model, trainingThrough: pairStart, trainingScans: training.scans.map((s) => s.time),
    testScans: heldOut.map((s) => s.time), evidence, fit,
    passed: false, reason: 'invalid or incomplete excluded pair', coefficients: null as number[] | null,
    predictions: [] as Array<{ predicted: number; observed: number; error: number; allowance: number }>,
    predictionRmse: null as number | null, maximumAllowance: null as number | null }
  if (!Number.isFinite(pairStart) || input.time !== pairStart + 1 || !Number.isFinite(input.sensorNoise) ||
      input.sensorNoise < 0 || !Number.isFinite(input.sensorSaturation) || input.sensorSaturation <= 0 ||
      heldOut.length !== 2 || heldOut.some((s, i) => s.time !== pairStart + 0.5 * (i + 1) || s.cycleSeconds !== 0.5 ||
        s.quad.readings?.length !== 4 || new Set(s.quad.readings.map((r) => r.channel)).size !== 4)) return initial
  const trainRows = spaceTimeRows(training).rows
  const testRows = spaceTimeRows({ ...input, central: [], scans: heldOut }).rows
  if (trainRows.length < 12 || testRows.length !== M17_POLICY.requiredTestChannels || !fit) return initial
  const project = (x: number[]) => model === 'm14' ? x.slice(0, 7) : x
  const x = trainRows.map((r) => project(r.x))
  const d = model === 'm16' ? spaceTimeInverse(x) : designInverse(x)
  const pseudo = 'pseudo' in d ? d.pseudo : d.inv.map((r) => x.map((v) => dot(r, v)))
  const coefficients = pseudo.map((r) => dot(r, trainRows.map((v) => v.y)))
  const result = { ...initial, coefficients, reason: 'test operator unidentifiable' }
  for (const row of testRows) {
    const op = project(row.x)
    if (!d.estimable(op)) return result
    const weights = x.map((_, j) => op.reduce((s, v, i) => s + v * pseudo[i]![j]!, 0))
    const predicted = dot(op, coefficients)
    // Deliberately exclude fit RMS: bad training fit cannot inflate this test's
    // acceptance envelope. This is a heuristic marginal-noise guard, not a CI.
    const allowance = M17_POLICY.numericalTolerance + M17_POLICY.predictionNoiseMultiplier *
      (row.sigma + weights.reduce((s, w, i) => s + Math.abs(w) * trainRows[i]!.sigma, 0))
    result.predictions.push({ predicted, observed: row.y, error: row.y - predicted, allowance })
  }
  if (!result.predictions.every((p) => [p.predicted, p.error, p.allowance].every(Number.isFinite))) return { ...result, reason: 'nonfinite prediction' }
  result.predictionRmse = Math.sqrt(result.predictions.reduce((s, p) => s + p.error ** 2, 0) / testRows.length)
  result.maximumAllowance = Math.max(...result.predictions.map((p) => p.allowance))
  if (result.maximumAllowance > M17_POLICY.maximumPredictionAllowanceFractionOfSaturation * input.sensorSaturation) return { ...result, reason: 'prediction too uncertain' }
  if (!result.predictions.every((p) => Math.abs(p.error) <= p.allowance)) return { ...result, reason: 'excluded-pair prediction failed' }
  return { ...result, passed: true, reason: 'excluded-pair prediction passed' }
}

export const evaluatePairedGuard = (input: SpaceTimeInput, pairStart: number) => {
  const complex = predictExcludedPair(input, pairStart, 'm16')
  const simple = predictExcludedPair(input, pairStart, 'm14')
  const selected = complex.passed && complex.evidence.usable ? complex :
    simple.passed && simple.evidence.usable ? simple : null
  return { usable: selected !== null, positive: selected?.evidence.positive ?? false,
    selectedModel: selected?.model ?? null, fit: selected?.fit ?? null,
    reason: selected ? `${selected.model}: ${selected.reason}; ${selected.evidence.reason}` : 'abstain: neither model independently validated',
    complex, simple }
}
