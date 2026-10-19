import type { Vec2 } from '../../src/sim/types'
import { M21_NUISANCES, m21Calibrate } from './m21-direction-study'
import {
  M24_DYNAMICS, m24Angle, m24Concentration, makeM24Sensor, m24Passive, m24Scan,
  timeAwareDecision, type M24Dynamic,
} from './m24-time-aware'
import { M23_ANGLES } from './m23-rotation-transfer'
import { m26Maps } from './m26-action-horizon'
import { executeM28ActionFrom } from './m28-continuous-feasible'
import type { TimedView } from './m22-recovery'

export const M30_ARMS = ['fresh-resense', 'stale-replay-sham'] as const
export const M30_DESIGN = {
  arms: M30_ARMS,
  maps: ['open', 'complexity-2', 'complexity-4', 'complexity-6'],
  dynamics: M24_DYNAMICS.map((dynamic) => dynamic.id),
  phases: M23_ANGLES,
  bodyHeadings: M23_ANGLES,
  calibrationReplicates: 2,
  trials: 5,
  calibrationSeedBase: 66000,
  episodeSeedBase: 6000000,
  baseEpisodes: 49280,
  reacquisitionDecisions: 394240,
  firstDecisionTime: 11.5,
  firstActionEndTime: 12.5,
  resenseStartTime: 13,
  resenseDecisionTime: 16.5,
  secondActionEndTime: 17.5,
  minimumForecastAlignment: 0.98,
  acceptanceFloorPerCell: 0.5,
  fullDistanceFraction: 0.99,
  correctDirectionOverall: 0.95,
  correctDirectionCell: 0.9,
  positiveProgressOverall: 0.95,
  positiveProgressCell: 0.9,
  movementExecuted: true,
  gslTrajectories: 0,
  appPromoted: false,
} as const

type Arm = typeof M30_ARMS[number]
type Cell = {
  map: string; dynamic: string; nuisance: string; arm: Arm; decisions: number;
  accepted: number; follows: number; explores: number; correct: number;
  positiveProgress: number; fullDistance: number; collisions: number;
  blockedEndpoints: number; distance: number; alignment: number;
  reasons: Record<string, number>;
}

const rotate = (v: Vec2, angle: number) => ({
  x: v.x * Math.cos(angle) - v.y * Math.sin(angle),
  y: v.x * Math.sin(angle) + v.y * Math.cos(angle),
})
const angleError = (a: Vec2, b: Vec2) => Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y)) * 180 / Math.PI
const explore = (body: number) => ({ x: Math.cos(body + Math.PI / 2), y: Math.sin(body + Math.PI / 2) })

export const m30InitialViews = (sensor: ReturnType<typeof makeM24Sensor>, field: (p: Vec2, time: number) => number,
  body: number, origin: Vec2) => {
  m24Passive(sensor, field, 0, 32, origin)
  return [0, 1, 2, 3].map((slot) => {
    const start = 8 + slot
    if (slot) m24Passive(sensor, field, start - 0.5, 2, origin)
    const heading = body + slot * Math.PI / 2
    return { heading, time: start + 0.5, values: m24Scan(sensor, field, start, heading, origin) }
  })
}

export const m30FreshViews = (sensor: ReturnType<typeof makeM24Sensor>, field: (p: Vec2, time: number) => number,
  body: number, origin: Vec2) => [0, 1, 2, 3].map((slot) => {
  const start = M30_DESIGN.resenseStartTime + slot
  m24Passive(sensor, field, start - 0.5, 2, origin)
  const heading = body + slot * Math.PI / 2
  return { heading, time: start + 0.5, values: m24Scan(sensor, field, start, heading, origin) }
})

export type M30RunLimits = { nuisances?: number; dynamics?: number; angles?: number; calibrationReplicates?: number; trials?: number; maps?: number }
export type M30Decision = typeof timeAwareDecision
export type M30ViewAcquisition = (...args: Parameters<typeof m30InitialViews>) => TimedView[]
export type M30ActionExecutor = typeof executeM28ActionFrom
export type M30DecisionObservation = { map: string; dynamic: string; phase: number; nuisance: string; arm: Arm; body: number;
  position: Vec2; views: ReturnType<M30ViewAcquisition>; field: (p: Vec2, time: number) => number;
  calibration: Parameters<M30Decision>[1]; decision: ReturnType<M30Decision>;
  decisionTime: number; responseSeconds: number; firstMove: ReturnType<M30ActionExecutor> }
export type M30RunOptions = { calibrationSeedBase?: number; episodeSeedBase?: number; decision?: M30Decision;
  initialDecision?: M30Decision; freshDecision?: M30Decision;
  initialAcquisition?: M30ViewAcquisition; freshAcquisition?: M30ViewAcquisition;
  actionExecutor?: M30ActionExecutor;
  onDecision?: (observation: M30DecisionObservation) => void;
  honorNonDirectionalActions?: boolean;
  firstDecisionTime?: number; firstActionEndTime?: number; resenseDecisionTime?: number; secondActionEndTime?: number }
export const runM30 = (limits: M30RunLimits = {}, options: M30RunOptions = {}) => {
  const initialDecision = options.initialDecision ?? options.decision ?? timeAwareDecision
  const freshDecision = options.freshDecision ?? options.decision ?? timeAwareDecision
  const executeAction = options.actionExecutor ?? executeM28ActionFrom
  const acquireInitial = options.initialAcquisition ?? m30InitialViews
  const acquireFresh = options.freshAcquisition ?? m30FreshViews
  const firstDecisionTime = options.firstDecisionTime ?? M30_DESIGN.firstDecisionTime
  const firstActionEndTime = options.firstActionEndTime ?? M30_DESIGN.firstActionEndTime
  const resenseDecisionTime = options.resenseDecisionTime ?? M30_DESIGN.resenseDecisionTime
  const secondActionEndTime = options.secondActionEndTime ?? M30_DESIGN.secondActionEndTime
  const calibrationSeedBase = options.calibrationSeedBase ?? M30_DESIGN.calibrationSeedBase
  const episodeSeedBase = options.episodeSeedBase ?? M30_DESIGN.episodeSeedBase
  const nuisances = M21_NUISANCES.slice(0, limits.nuisances ?? M21_NUISANCES.length)
  const dynamics = M24_DYNAMICS.slice(0, limits.dynamics ?? M24_DYNAMICS.length)
  const angles = M23_ANGLES.slice(0, limits.angles ?? M23_ANGLES.length)
  const calibrationReplicates = limits.calibrationReplicates ?? M30_DESIGN.calibrationReplicates
  const trials = limits.trials ?? M30_DESIGN.trials
  const maps = m26Maps().slice(0, limits.maps ?? M30_DESIGN.maps.length)
  const cells = new Map<string, Cell>()
  let baseEpisodes = 0
  let reacquisitionDecisions = 0
  let freshSensorCycles = 0

  for (const [ni, nuisance] of nuisances.entries()) for (let rep = 0; rep < calibrationReplicates; rep++) {
    const calibration = m21Calibrate(nuisance, calibrationSeedBase + ni * 2 + rep).calibration
    for (const [di, dynamic] of dynamics.entries()) for (const [pi, phase] of angles.entries()) {
      for (const [bi, body] of angles.entries()) for (let trial = 0; trial < trials; trial++) {
        const seed = episodeSeedBase + ni * 200000 + rep * 100000 + di * 8000 + pi * 800 + bi * 10 + trial
        baseEpisodes++
        for (const map of maps) {
          const field = (p: Vec2, time: number) => m24Concentration(dynamic as M24Dynamic, phase, p, time)
          const sensor = makeM24Sensor(nuisance, seed)
          const before = acquireInitial(sensor, field, body, map.start)
          freshSensorCycles += before.length
          const first = initialDecision(before, calibration, firstDecisionTime, nuisance.lag)
          const firstForecast = first.direction && first.fittedRate !== null
            ? rotate(first.direction, first.fittedRate * (firstActionEndTime - firstDecisionTime)) : null
          const firstPreview = firstForecast ? executeAction(map, map.start, firstForecast) : null
          const firstFollow = !!firstForecast && firstPreview!.meanAlignment >= M30_DESIGN.minimumForecastAlignment
          const firstDesired = firstFollow ? firstForecast! : explore(body)
          const firstMove = firstFollow ? firstPreview! : executeAction(map, map.start, firstDesired)
          const after = acquireFresh(sensor, field, body, firstMove.position)
          freshSensorCycles += after.length

          for (const arm of M30_ARMS) {
            const views = arm === 'fresh-resense' ? after : before
            const decision = freshDecision(views, calibration, resenseDecisionTime, nuisance.lag)
            options.onDecision?.({ map: map.id, dynamic: dynamic.id, phase, nuisance: nuisance.id, arm, body,
              position: firstMove.position, views, field, calibration, decision,
              decisionTime: resenseDecisionTime, responseSeconds: nuisance.lag, firstMove })
            const accepted = decision.direction !== null
            const forecast = decision.direction && decision.fittedRate !== null
              ? rotate(decision.direction, decision.fittedRate * (secondActionEndTime - resenseDecisionTime)) : null
            const preview = forecast ? executeAction(map, firstMove.position, forecast) : null
            const follow = !!forecast && preview!.meanAlignment >= M30_DESIGN.minimumForecastAlignment
            const usePolicyAction = options.honorNonDirectionalActions && !accepted
            const desired = follow ? forecast! : usePolicyAction ? decision.action.direction : explore(body + 3 * Math.PI / 2)
            // A rejected/stale observation may request a stationary reacquisition.
            // Do not pass zero vectors to an executor whose normalization has a fallback bearing.
            const hold = usePolicyAction && decision.action.plannedDistance === 0
            const moved = follow ? preview! : hold ? { position: { ...firstMove.position },
              path: [{ ...firstMove.position }], distance: 0, collisions: 0,
              blockedEndpoint: map.environment.isBlocked(firstMove.position), meanAlignment: 0 }
              : executeAction(map, firstMove.position, desired)
            const truthNowAngle = m24Angle(dynamic, phase, resenseDecisionTime)
            const truthEndAngle = m24Angle(dynamic, phase, secondActionEndTime)
            const truthNow = { x: Math.cos(truthNowAngle), y: Math.sin(truthNowAngle) }
            const truthEnd = { x: Math.cos(truthEndAngle), y: Math.sin(truthEndAngle) }
            const delta = { x: moved.position.x - firstMove.position.x, y: moved.position.y - firstMove.position.y }
            const progress = truthEnd.x * delta.x + truthEnd.y * delta.y
            const key = `${map.id}|${dynamic.id}|${nuisance.id}|${arm}`
            const cell = cells.get(key) ?? { map: map.id, dynamic: dynamic.id, nuisance: nuisance.id, arm,
              decisions: 0, accepted: 0, follows: 0, explores: 0, correct: 0, positiveProgress: 0,
              fullDistance: 0, collisions: 0, blockedEndpoints: 0, distance: 0, alignment: 0, reasons: {} }
            cell.decisions++
            cell.accepted += Number(accepted)
            cell.follows += Number(follow)
            cell.explores += Number(!follow)
            // The frozen gate is defined over executed follow actions, not every
            // direction returned before the obstacle-alignment veto.
            cell.correct += Number(follow && angleError(decision.direction!, truthNow) <= 45)
            cell.positiveProgress += Number(follow && progress > 1e-12)
            cell.fullDistance += Number(moved.distance >= 0.0099)
            cell.collisions += moved.collisions
            cell.blockedEndpoints += Number(moved.blockedEndpoint)
            cell.distance += moved.distance
            cell.alignment += moved.meanAlignment
            cell.reasons[decision.reason] = (cell.reasons[decision.reason] ?? 0) + 1
            cells.set(key, cell)
            reacquisitionDecisions++
          }
        }
      }
    }
  }

  const aggregates = [...cells.values()]
  if (aggregates.some((cell) => cell.correct > cell.follows || cell.positiveProgress > cell.follows)) {
    throw new Error('M30 follow-action metric invariant failed')
  }
  const fresh = aggregates.filter((cell) => cell.arm === 'fresh-resense')
  const supported = fresh.filter((cell) => cell.nuisance !== 'slow')
  const supportedFollows = supported.reduce((sum, cell) => sum + cell.follows, 0)
  const correct = supported.reduce((sum, cell) => sum + cell.correct, 0)
  const positive = supported.reduce((sum, cell) => sum + cell.positiveProgress, 0)
  const failures = {
    safety: aggregates.filter((cell) => cell.blockedEndpoints > 0 || cell.collisions > 0),
    distance: aggregates.filter((cell) => cell.fullDistance / cell.decisions < M30_DESIGN.fullDistanceFraction),
    slowFollow: fresh.filter((cell) => cell.nuisance === 'slow' && cell.follows > 0),
    staleAcceptance: aggregates.filter((cell) => cell.arm === 'stale-replay-sham' && cell.accepted > 0),
    acceptance: supported.filter((cell) => cell.accepted / cell.decisions < M30_DESIGN.acceptanceFloorPerCell),
    directionCells: supported.filter((cell) => cell.follows >= 20 && cell.correct / cell.follows < M30_DESIGN.correctDirectionCell),
    progressCells: supported.filter((cell) => cell.follows >= 20 && cell.positiveProgress / cell.follows < M30_DESIGN.positiveProgressCell),
    correctDirectionOverall: supportedFollows ? correct / supportedFollows : 0,
    positiveProgressOverall: supportedFollows ? positive / supportedFollows : 0,
  }
  const advancesToMultiCycleTest = !failures.safety.length && !failures.distance.length && !failures.slowFollow.length &&
    !failures.staleAcceptance.length && !failures.acceptance.length && !failures.directionCells.length &&
    !failures.progressCells.length && failures.correctDirectionOverall >= M30_DESIGN.correctDirectionOverall &&
    failures.positiveProgressOverall >= M30_DESIGN.positiveProgressOverall
  return { complete: true, design: M30_DESIGN, mapManifest: maps.map((map) => ({ id: map.id, complexity: map.complexity,
    seed: map.seed, start: map.start, obstacles: map.scenario.obstacles })), baseEpisodes, reacquisitionDecisions,
    freshSensorCycles, aggregates, failures, advancesToMultiCycleTest, movementExecuted: true, gslTrajectories: 0,
    appPromoted: false }
}
