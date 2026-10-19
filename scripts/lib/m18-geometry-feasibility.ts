import type { Vec2 } from '../../src/sim/types'
import { geometrySample, designInverse, MULTIVIEW_POLICY } from './multiview-source-evidence'
import { spaceTimeRows, spaceTimeInverse, M16_POLICY } from './m16-space-time-evidence'
import { M17_POLICY } from './m17-prediction-guard'

export const M18_DESIGN = Object.freeze({ version: 'geometry-noise-preflight-v1', geometryOnly: true,
  profiles: ['pair-prior', 'pair-last', 'triplet-last', 'burst-last'],
  reaches: [0.0325, 0.065, 0.0975], windows: [3, 6], maps: ['open', 'wall', 'corridor'], models: ['m14', 'm16'],
  noise: 0.025, saturation: 1.5, dt: 0.25, strength: 0.78, horizon: 40,
  wind: { x: 0.018, y: 0.006 }, diffusivity: 0.0004,
  predictionCap: 0.15, residualConcentrationBudget: 0.15, residualReferenceSeconds: 1,
  expectedPlans: 144, expectedEpochs: 432, evaluationEpochs: 3,
})
export type M18Plan = { id: string; profile: 'pair-prior' | 'pair-last' | 'triplet-last' | 'burst-last';
  reach: number; window: 3 | 6; map: 'open' | 'wall' | 'corridor'; model: 'm14' | 'm16' }
export const m18Plans = (): M18Plan[] => {
  const plans: M18Plan[] = []
  for (const profile of ['pair-prior', 'pair-last', 'triplet-last', 'burst-last'] as const) for (const reach of M18_DESIGN.reaches)
    for (const window of [3, 6] as const) for (const map of ['open', 'wall', 'corridor'] as const) for (const model of ['m14', 'm16'] as const)
      plans.push({ profile, reach, window, map, model, id: `${profile}-r${reach}-w${window}-${map}-${model}` })
  return plans
}
export const m18Map = (name: M18Plan['map']) => (p: Vec2, clearance = 0) =>
  p.x - clearance <= 0 || p.y - clearance <= 0 || p.x + clearance >= 1 || p.y + clearance >= 1 ||
  (name === 'wall' && p.x + clearance >= 0.525) ||
  (name === 'corridor' && (p.y - clearance <= 0.48 || p.y + clearance >= 0.52))
export const m18Schedule = (plan: M18Plan) => {
  const perBlock = plan.profile === 'triplet-last' ? 3 : plan.profile === 'burst-last' ? 6 : 2
  const blocks = 18 / perBlock
  const interval = perBlock === 3 ? 5 : perBlock === 6 ? 12 : 3
  return Array.from({ length: blocks }, (_, block) => Array.from({ length: perBlock }, (_, slot) => ({
    block, slot, start: 10 + interval * block + slot * 0.5, duration: 0.5,
    reach: (slot + block) % 2 ? plan.reach / 2 : plan.reach,
    bearing: 0.31 + (block % 2 ? Math.PI / 4 : 0),
  }))).flat()
}
export const m18Budget = (plan: M18Plan) => {
  const schedule = m18Schedule(plan)
  const blocks = [...new Set(schedule.map((s) => s.block))].length
  const idealTurningSeconds = (blocks - 1) * 0.5
  const transitions = schedule.slice(1).filter((s, i) => s.block !== schedule[i]!.block)
  const turnGapsValid = transitions.every((s) => {
    const previous = schedule.filter((r) => r.block === s.block - 1).at(-1)!
    return s.start - (previous.start + previous.duration) >= 0.5
  })
  return { cycles: schedule.length, blocks, samplingSeconds: schedule.reduce((s, e) => s + e.duration, 0),
    idealTurningSeconds, suctionEnergyProxy: 4 * M18_DESIGN.strength ** 2 * 9, pathLength: 0,
    reachSwitches: schedule.slice(1).filter((s, i) => s.reach !== schedule[i]!.reach).length,
    finalReturn: schedule.at(-1)!.start + 0.5, turnGapsValid,
    budgetValid: turnGapsValid && schedule.length === 18 && schedule.at(-1)!.start + 0.5 <= 40 }
}
export type GeometricRow = { x: number[]; sigma: number }
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0)

/** No plume object, concentration array, source location, noise draw or outcome
 * enters this interface. Zero placeholders are discarded after geometry rows
 * are built; they are not simulated gas observations or fitted concentrations. */
export const m18Rows = (plan: M18Plan, block: number, noise: number = M18_DESIGN.noise) => {
  if (!Number.isFinite(noise) || noise < 0) throw new Error('Invalid marginal noise')
  const anchor = { x: 0.5, y: 0.5 }; const schedule = m18Schedule(plan); const isBlocked = m18Map(plan.map)
  const current = schedule.filter((s) => s.block === block)
  if (!current.length) throw new Error('Missing acquisition block')
  const time = current.at(-1)!.start + 0.5
  const cutoff = plan.profile === 'pair-prior' ? current[0]!.start : current.at(-1)!.start
  const central = Array.from({ length: 160 }, (_, tick) => tick * 0.25)
    .filter((t) => t >= time - plan.window && t <= cutoff && !schedule.some((e) => t > e.start && t <= e.start + e.duration))
    .map((t) => ({ time: t, position: anchor, concentration: 0 }))
  const scans = schedule.filter((e) => e.start + e.duration >= time - plan.window && e.start + e.duration <= time).map((e) => {
    const sample = geometrySample(anchor, e.bearing, 'active-suction', e.reach, M18_DESIGN.strength, isBlocked, e.start + e.duration)
    return { ...sample, cycleSeconds: 0.5, quad: { ...sample.quad, readings: sample.quad.readings!.map((r) => ({
      ...r, integrationSamples: 3, effectiveIntegrationSamples: 8 / 3,
    })) } }
  })
  const input = { anchor, time, wind: M18_DESIGN.wind, diffusivity: M18_DESIGN.diffusivity,
    sensorNoise: noise, sensorSaturation: 1.5, integrationStepSeconds: 0.25, isBlocked }
  const training = spaceTimeRows({ ...input, central, scans: scans.filter((s) => s.time <= cutoff) })
  const testing = spaceTimeRows({ ...input, central: [], scans: scans.filter((s) => s.time > cutoff) })
  const strip = (rows: typeof training.rows): GeometricRow[] => rows.map((r) => ({ x: plan.model === 'm14' ? r.x.slice(0, 7) : r.x, sigma: r.sigma }))
  return { time, cutoff, centralCount: training.centralCount, training: strip(training.rows), testing: strip(testing.rows),
    expectedTestChannels: plan.profile === 'pair-prior' ? 8 : 4,
    trainingTimes: [...central.map((s) => s.time), ...scans.filter((s) => s.time <= cutoff).map((s) => s.time)],
    testTimes: scans.filter((s) => s.time > cutoff).map((s) => s.time) }
}
export const m18Inverse = (rows: number[][], model: M18Plan['model']) => {
  const d = model === 'm14' ? designInverse(rows) : spaceTimeInverse(rows)
  const pseudo = 'pseudo' in d ? d.pseudo : d.inv.map((r) => rows.map((x) => dot(r, x)))
  const weights = (op: number[]) => rows.map((_, j) => op.reduce((s, v, i) => s + v * pseudo[i]![j]!, 0))
  return { rank: d.rank, condition: d.condition, estimable: d.estimable, pseudo, weights }
}
export const m18Operators = (model: M18Plan['model']) => {
  const n = model === 'm14' ? 7 : 12; const h = M16_POLICY.spatialScale; const tau = M16_POLICY.temporalScale
  const unit = (i: number, scale = 1) => Array.from({ length: n }, (_, j) => j === i ? scale : 0)
  const residual = (wx: number, wy: number, D: number) => Array.from({ length: n }, (_, j) =>
    j === 1 ? wx / h : j === 2 ? wy / h : j === 3 || j === 5 ? -D / h ** 2 : j === 6 ? 1 / tau : 0)
  const delta = M16_POLICY.windFraction * Math.hypot(M18_DESIGN.wind.x, M18_DESIGN.wind.y)
  const corners = []
  for (const wx of [M18_DESIGN.wind.x - delta, M18_DESIGN.wind.x + delta])
    for (const wy of [M18_DESIGN.wind.y - delta, M18_DESIGN.wind.y + delta]) for (const f of M16_POLICY.diffusivityFactors)
      corners.push(residual(wx, wy, M18_DESIGN.diffusivity * f))
  return { required: [unit(0), unit(1, 1 / h), unit(2, 1 / h), unit(6, 1 / tau),
    Array.from({ length: n }, (_, j) => j === 3 || j === 5 ? 1 / h ** 2 : 0)],
    nominalResidual: residual(M18_DESIGN.wind.x, M18_DESIGN.wind.y, M18_DESIGN.diffusivity), corners }
}
export const screenM18Epoch = (plan: M18Plan, block: number, noise: number = M18_DESIGN.noise) => {
  const rows = m18Rows(plan, block, noise); const d = m18Inverse(rows.training.map((r) => r.x), plan.model)
  const ops = m18Operators(plan.model)
  const uncertainty = (op: number[]) => 3 * d.weights(op).reduce((s, w, i) => s + Math.abs(w) * rows.training[i]!.sigma, 0)
  const residualIdentifiable = [...ops.required, ops.nominalResidual, ...ops.corners].every(d.estimable)
  const testIdentifiable = rows.testing.length === rows.expectedTestChannels && rows.testing.every((r) => d.estimable(r.x))
  const predictionAllowances = testIdentifiable ? rows.testing.map((r) => M17_POLICY.numericalTolerance + 3 * r.sigma + uncertainty(r.x)) : []
  const maxPredictionAllowance = predictionAllowances.length ? Math.max(...predictionAllowances) : null
  const nominalResidualAllowance = residualIdentifiable ? uncertainty(ops.nominalResidual) : null
  const maxResidualAllowance = residualIdentifiable ? Math.max(...ops.corners.map(uncertainty)) : null
  const gates = {
    minimumMeasurements: rows.centralCount >= 8 && rows.training.length >= 12,
    condition: Number.isFinite(d.condition) && (plan.model !== 'm14' || d.condition <= MULTIVIEW_POLICY.maximumCondition),
    residualIdentifiable, testIdentifiable,
    predictionNoiseFeasible: maxPredictionAllowance !== null && Number.isFinite(maxPredictionAllowance) && maxPredictionAllowance <= M18_DESIGN.predictionCap,
    residualNoiseFeasible: maxResidualAllowance !== null && Number.isFinite(maxResidualAllowance) &&
      maxResidualAllowance * M18_DESIGN.residualReferenceSeconds <= M18_DESIGN.residualConcentrationBudget,
  }
  return { block, time: rows.time, trainingThrough: rows.cutoff, predictionHorizon: rows.time - rows.cutoff,
    trainingRows: rows.training.length, centralRows: rows.centralCount, testRows: rows.testing.length,
    expectedTestChannels: rows.expectedTestChannels, rank: d.rank, condition: Number.isFinite(d.condition) ? d.condition : null,
    gates, feasible: Object.values(gates).every(Boolean), predictionAllowances, maxPredictionAllowance,
    nominalResidualAllowance, maxResidualAllowance,
    requiredOperatorAllowances: residualIdentifiable ? ops.required.map(uncertainty) : null }
}
export const screenM18 = (plan: M18Plan) => {
  const schedule = m18Schedule(plan); const blocks = [...new Set(schedule.map((s) => s.block))].slice(-3)
  const epochs = blocks.map((b) => screenM18Epoch(plan, b)); const budget = m18Budget(plan)
  const maximum = (key: 'maxPredictionAllowance' | 'maxResidualAllowance') => epochs.every((e) => e[key] !== null)
    ? Math.max(...epochs.map((e) => e[key]!)) : null
  return { plan, budget, epochs, feasible: budget.budgetValid && epochs.length === 3 && epochs.every((e) => e.feasible),
    worstPredictionAllowance: maximum('maxPredictionAllowance'), worstResidualAllowance: maximum('maxResidualAllowance') }
}
