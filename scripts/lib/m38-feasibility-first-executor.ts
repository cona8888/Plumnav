import { add, distance, normalize, scale } from '../../src/sim/math'
import type { Vec2 } from '../../src/sim/types'
import { M28_DESIGN, executeM28ActionFrom } from './m28-continuous-feasible'
import { runM30, type M30ActionExecutor } from './m30-move-resense'
import { summarizeM32Run } from './m32-contrast-aware-development'
import { m36QuadraticDecision } from './m36-quadratic-temporal'
import { m37RapidFreshViews } from './m37-rapid-fixed-quad'

type Map = Parameters<typeof executeM28ActionFrom>[0]
const chooseFeasible = (map: Map, position: Vec2, desired: Vec2) => {
  const target = normalize(desired)
  const commands = [target, ...Array.from({ length: M28_DESIGN.candidateBearings }, (_, i) => {
    const angle = 2 * Math.PI * i / M28_DESIGN.candidateBearings
    return { x: Math.cos(angle), y: Math.sin(angle) }
  })]
  let best: { direction: Vec2; score: number } | null = null
  for (const command of commands) {
    const actual = map.environment.safeDirection(position, command)
    if (Math.hypot(actual.x, actual.y) < 1e-12) continue
    const proposed = add(position, scale(actual, M28_DESIGN.dt * 0.01 * map.environment.terrainMobilityScale(actual)))
    if (map.environment.isBlocked(proposed)) continue
    const score = actual.x * target.x + actual.y * target.y
    if (!best || score > best.score) best = { direction: actual, score }
  }
  return best?.direction ?? { x: 0, y: 0 }
}
export const executeM38ActionFrom: M30ActionExecutor = (map, start, desired) => {
  let position = { ...start }
  const path = [{ ...position }]
  let collisions = 0, alignment = 0
  const target = normalize(desired)
  for (let step = 0; step < M28_DESIGN.steps; step++) {
    const safe = chooseFeasible(map, position, target)
    alignment += safe.x * target.x + safe.y * target.y
    const proposed = add(position, scale(safe, M28_DESIGN.dt * 0.01 * map.environment.terrainMobilityScale(safe)))
    const travel = distance(position, proposed)
    const probes = Math.max(1, Math.ceil(travel / M28_DESIGN.segmentProbe))
    let blocked = false
    for (let i = 1; i <= probes; i++) if (map.environment.isBlocked({
      x: position.x + (proposed.x - position.x) * i / probes,
      y: position.y + (proposed.y - position.y) * i / probes,
    })) { blocked = true; break }
    if (blocked) collisions++
    else { position = proposed; path.push({ ...position }) }
  }
  return { position, path, distance: path.slice(1).reduce((total, point, i) => total + distance(path[i]!, point), 0),
    collisions, blockedEndpoint: map.environment.isBlocked(position), meanAlignment: alignment / M28_DESIGN.steps }
}

export const M38_DESIGN = { calibrationSeedBase: 80000, episodeSeedBase: 20000000,
  directCandidateValidated: true, candidateBearings: 16, developmentOnly: true,
  heldOutConfirmationRequired: true } as const
export const runM38 = () => {
  const seeds = { calibrationSeedBase: M38_DESIGN.calibrationSeedBase, episodeSeedBase: M38_DESIGN.episodeSeedBase }
  const rapid = { ...seeds, resenseDecisionTime: 17, secondActionEndTime: 18,
    freshAcquisition: m37RapidFreshViews, freshDecision: m36QuadraticDecision }
  const legacy = runM30({}, seeds)
  const m37Executor = runM30({}, rapid)
  const feasibilityFirst = runM30({}, { ...rapid, actionExecutor: executeM38ActionFrom })
  return { complete: true, design: M38_DESIGN, legacy: summarizeM32Run(legacy),
    m37Executor: summarizeM32Run(m37Executor), feasibilityFirst: summarizeM32Run(feasibilityFirst) }
}
