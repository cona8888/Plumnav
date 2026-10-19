import { geometrySample, MULTIVIEW_POLICY } from './multiview-source-evidence'
import { spaceTimeRows } from './m16-space-time-evidence'
import { M18_DESIGN, m18Map, m18Inverse, m18Operators, type GeometricRow, type M18Plan } from './m18-geometry-feasibility'

export const M19_ORDERS = ['BBB', 'BBL', 'BLB', 'BLL', 'LBB', 'LBL', 'LLB', 'LLL'] as const
export type M19Order = typeof M19_ORDERS[number]
export type BearingIndex = 0 | 1
export type M19Setting = { id: string; map: M18Plan['map']; model: M18Plan['model']; reach: number }
export type M19Event = { block: number; slot: number; start: number; duration: 0.5; reach: number; bearing: number }
export const M19_DESIGN = Object.freeze({ version: 'causal-geometry-order-selector-v1', geometryOnly: true,
  orders: [...M19_ORDERS], reaches: [...M18_DESIGN.reaches], maps: [...M18_DESIGN.maps], models: [...M18_DESIGN.models],
  noise: M18_DESIGN.noise, predictionCap: M18_DESIGN.predictionCap, residualCap: M18_DESIGN.residualConcentrationBudget,
  window: 6, firstBlock: 10, interval: 5, blocks: 6, cycleSeconds: 0.5, bootstrapBlocks: 2,
  scoreTieTolerance: 1e-10, expectedSettings: 18, contextsPerSetting: 34, expectedCandidateChecks: 4896,
  expectedRollouts: 36, expectedRolloutCandidateChecks: 1152,
})
export const m19Settings = (): M19Setting[] => {
  const settings: M19Setting[] = []
  for (const map of ['open', 'wall', 'corridor'] as const) for (const model of ['m14', 'm16'] as const)
    for (const reach of M19_DESIGN.reaches) settings.push({ map, model, reach, id: `${map}-${model}-r${reach}` })
  return settings
}
export const m19Contexts = () => {
  const contexts: Array<{ id: string; previousOrder: M19Order | null; previousBearing: BearingIndex | null; currentBearing: BearingIndex }> = []
  for (const previousOrder of M19_ORDERS) for (const previousBearing of [0, 1] as const) for (const currentBearing of [0, 1] as const)
    contexts.push({ id: `${previousOrder}-b${previousBearing}-to-b${currentBearing}`, previousOrder, previousBearing, currentBearing })
  for (const currentBearing of [0, 1] as const) contexts.push({ id: `cold-b${currentBearing}`, previousOrder: null, previousBearing: null, currentBearing })
  return contexts
}
export const m19Events = (order: M19Order, start: number, bearing: BearingIndex, reach: number, block: number): M19Event[] => {
  if (!M19_ORDERS.includes(order) || !Number.isFinite(start) || start < 0 || start % 0.25 !== 0 ||
      ![0, 1].includes(bearing) || !Number.isFinite(reach) || reach / 2 < 0.005 || reach > 0.15) throw new Error('Invalid scan recipe')
  return [...order].map((letter, slot) => ({ block, slot, start: start + slot * 0.5, duration: 0.5,
    reach: letter === 'B' ? reach : reach / 2, bearing: 0.31 + bearing * Math.PI / 4 }))
}
/** Geometry-only interface. All hypothetical current readings are represented
 * by known observation operators, never future concentrations. */
export const m19Rows = (setting: M19Setting, events: M19Event[], block: number) => {
  const current = events.filter((s) => s.block === block)
  if (current.length !== 3 || current.some((s, i) => s.start !== current[0]!.start + 0.5 * i || s.duration !== 0.5)) throw new Error('Incomplete current block')
  const time = current[2]!.start + 0.5; const cutoff = current[2]!.start
  const anchor = { x: 0.5, y: 0.5 }; const isBlocked = m18Map(setting.map)
  const central = Array.from({ length: 160 }, (_, i) => i * 0.25)
    .filter((t) => t >= time - 6 && t <= cutoff && !events.some((s) => t > s.start && t <= s.start + 0.5))
    .map((t) => ({ time: t, position: anchor, concentration: 0 }))
  const scans = events.filter((s) => s.start + 0.5 >= time - 6 && s.start + 0.5 <= time).map((s) => {
    const g = geometrySample(anchor, s.bearing, 'active-suction', s.reach, 0.78, isBlocked, s.start + 0.5)
    return { ...g, cycleSeconds: 0.5, quad: { ...g.quad, readings: g.quad.readings!.map((r) => ({ ...r,
      integrationSamples: 3, effectiveIntegrationSamples: 8 / 3 })) } }
  })
  const calibration = { anchor, time, wind: M18_DESIGN.wind, diffusivity: M18_DESIGN.diffusivity,
    sensorNoise: M18_DESIGN.noise, sensorSaturation: 1.5, integrationStepSeconds: 0.25, isBlocked }
  const train = spaceTimeRows({ ...calibration, central, scans: scans.filter((s) => s.time <= cutoff) })
  const test = spaceTimeRows({ ...calibration, central: [], scans: scans.filter((s) => s.time > cutoff) })
  const strip = (rows: typeof train.rows): GeometricRow[] => rows.map((r) => ({ x: setting.model === 'm14' ? r.x.slice(0, 7) : r.x, sigma: r.sigma }))
  return { time, cutoff, centralCount: train.centralCount, training: strip(train.rows), testing: strip(test.rows),
    trainingTimes: [...central.map((s) => s.time), ...scans.filter((s) => s.time <= cutoff).map((s) => s.time)],
    testTimes: scans.filter((s) => s.time > cutoff).map((s) => s.time) }
}
export const scoreM19Rows = (setting: M19Setting, rows: ReturnType<typeof m19Rows>) => {
  const d = m18Inverse(rows.training.map((r) => r.x), setting.model); const ops = m18Operators(setting.model)
  const allowance = (op: number[]) => 3 * d.weights(op).reduce((s, w, i) => s + Math.abs(w) * rows.training[i]!.sigma, 0)
  const residualIdentifiable = [...ops.required, ops.nominalResidual, ...ops.corners].every(d.estimable)
  const testIdentifiable = rows.testing.length === 4 && rows.testing.every((r) => d.estimable(r.x))
  const maxPredictionAllowance = testIdentifiable ? Math.max(...rows.testing.map((r) => 1e-4 + 3 * r.sigma + allowance(r.x))) : null
  const maxResidualAllowance = residualIdentifiable ? Math.max(...ops.corners.map(allowance)) : null
  const gates = { minimumMeasurements: rows.centralCount >= 8 && rows.training.length >= 12,
    condition: Number.isFinite(d.condition) && (setting.model !== 'm14' || d.condition <= MULTIVIEW_POLICY.maximumCondition),
    residualIdentifiable, testIdentifiable,
    predictionNoiseFeasible: maxPredictionAllowance !== null && Number.isFinite(maxPredictionAllowance) && maxPredictionAllowance <= M19_DESIGN.predictionCap,
    residualNoiseFeasible: maxResidualAllowance !== null && Number.isFinite(maxResidualAllowance) && maxResidualAllowance <= M19_DESIGN.residualCap }
  const structural = gates.minimumMeasurements && gates.condition && residualIdentifiable && testIdentifiable
  const score = structural && maxPredictionAllowance !== null && maxResidualAllowance !== null
    ? Math.max(maxPredictionAllowance / M19_DESIGN.predictionCap, maxResidualAllowance / M19_DESIGN.residualCap) : null
  return { time: rows.time, trainingThrough: rows.cutoff, trainingRows: rows.training.length, centralRows: rows.centralCount,
    testRows: rows.testing.length, rank: d.rank, condition: Number.isFinite(d.condition) ? d.condition : null,
    maxPredictionAllowance, maxResidualAllowance, gates, feasible: Object.values(gates).every(Boolean),
    score: score !== null && Number.isFinite(score) ? score : null }
}
export const chooseM19Order = (candidates: Array<{ order: M19Order; switches: number; feasible: boolean; score: number | null }>) => {
  const eligible = candidates.filter((c) => c.feasible && c.score !== null && Number.isFinite(c.score) && c.score >= 0 && c.score <= 1)
  const best = eligible.length ? Math.min(...eligible.map((c) => c.score!)) : null
  return eligible.filter((c) => best !== null && c.score! <= best + M19_DESIGN.scoreTieTolerance)
    .sort((a, b) => a.switches - b.switches || (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))[0]?.order ?? null
}
export const selectM19Order = (setting: M19Setting, history: M19Event[], start: number, bearing: BearingIndex, block: number) => {
  if (history.some((s) => s.start + s.duration > start || s.block >= block)) throw new Error('Future acquisition in history')
  const candidates = M19_ORDERS.map((order) => {
    const current = m19Events(order, start, bearing, setting.reach, block)
    const path = [...history, ...current]
    const previousReach = history.at(-1)?.reach
    const switches = current.filter((s, i) => (i === 0 ? previousReach : current[i - 1]!.reach) !== undefined &&
      s.reach !== (i === 0 ? previousReach : current[i - 1]!.reach)).length
    return { order, switches, ...scoreM19Rows(setting, m19Rows(setting, path, block)) }
  })
  return { selectedOrder: chooseM19Order(candidates), candidates }
}
export const m19Factorial = (setting: M19Setting) => m19Contexts().map((context) => {
  const history = context.previousOrder === null ? [] : m19Events(context.previousOrder, 30, context.previousBearing!, setting.reach, 0)
  return { context, ...selectM19Order(setting, history, context.previousOrder === null ? 10 : 35, context.currentBearing, context.previousOrder === null ? 0 : 1) }
})
export const rolloutM19 = (setting: M19Setting, initialBearing: BearingIndex) => {
  const events: M19Event[] = []
  const steps: Array<{ block: number; bootstrap: boolean; acquisitionOrder: M19Order; decision: ReturnType<typeof selectM19Order> | null }> = []
  for (let block = 0; block < 6; block++) {
    const bearing = ((initialBearing + block) % 2) as BearingIndex; const start = 10 + 5 * block
    const fixed = block % 2 ? 'LBL' : 'BLB'
    const decision = block < 2 ? null : selectM19Order(setting, events, start, bearing, block)
    // A failed geometry check does not masquerade as source evidence. Continue
    // the fixed exploration recipe so all runs still pay the same sensing cost.
    const acquisitionOrder = decision?.selectedOrder ?? fixed
    events.push(...m19Events(acquisitionOrder, start, bearing, setting.reach, block))
    steps.push({ block, bootstrap: block < 2, acquisitionOrder, decision })
  }
  const switches = events.slice(1).filter((s, i) => s.reach !== events[i]!.reach).length
  return { initialBearing, steps, events, allPostBootstrapFeasible: steps.slice(2).every((s) => s.decision!.selectedOrder !== null),
    qualifiedDecisions: steps.slice(2).filter((s) => s.decision!.selectedOrder !== null).length,
    budget: { cycles: 18, samplingSeconds: 9, idealTurningSeconds: 2.5, suctionEnergyProxy: 4 * 0.78 ** 2 * 9,
      reachSwitches: switches, pathLength: 0, finalReturn: 36.5, bootstrapSamplingSeconds: 3 } }
}
export const studyM19Setting = (setting: M19Setting) => {
  const factorial = m19Factorial(setting); const rollouts = ([0, 1] as const).map((b) => rolloutM19(setting, b))
  const warm = factorial.filter((r) => r.context.previousOrder !== null)
  const warmFeasibleContexts = warm.filter((r) => r.selectedOrder !== null).length
  const coldFeasibleContexts = factorial.filter((r) => r.context.previousOrder === null && r.selectedOrder !== null).length
  return { setting, factorial, rollouts, warmFeasibleContexts, coldFeasibleContexts,
    eligibleForManufacturedDiagnostic: warm.length === 32 && warmFeasibleContexts === 32 && rollouts.every((r) => r.allPostBootstrapFeasible) }
}
