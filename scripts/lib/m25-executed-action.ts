import { createDefaultConfig } from '../../src/sim/config'
import { createScenario } from '../../src/sim/scenarios'
import { createControllerObservationModel } from '../../src/sim/controllerObservationModel'
import { createEnvironment } from '../../src/sim/environment'
import { add, distance, normalize, pointInObstacle, scale } from '../../src/sim/math'
import type { Scenario, Vec2 } from '../../src/sim/types'
import { m24Angle, M24_DYNAMICS } from './m24-time-aware'

export const M25_POLICIES = ['time-aware', 'recovery', 'explore-only'] as const
export const M25_MAPS = ['open', 'complexity-2', 'complexity-4', 'complexity-6'] as const
export const M25_DESIGN = { policies: M25_POLICIES, maps: M25_MAPS, start: { x: 0.5, y: 0.5 },
  actionSeconds: 1, steps: 4, dt: 0.25, plannedDistance: 0.01, segmentProbe: 0.008,
  expectedEpisodes: 49280, expectedActions: 591360, fullDistanceFraction: 0.99,
  positiveGainOverall: 0.95, positiveGainCell: 0.90, movementExecuted: true,
  newSensorCycles: 0, gslTrajectories: 0, appPromoted: false } as const
const configFor = (complexity: number) => ({ ...createDefaultConfig('coverage', complexity ? 'obstructed' : 'open'),
  obstacleComplexityLevel: complexity, targetStatus: 'absent' as const, terrainSlopeDegrees: 0,
  robotStartPositionOverride: undefined, sourcePositionOverride: undefined })
const publicScenario = (s: Scenario) => { const { source: _s, targetStatus: _t, ...rest } = s; return rest }
export const m25Maps = () => M25_MAPS.map((id) => {
  const complexity = id === 'open' ? 0 : Number(id.split('-')[1])
  let fallback: ReturnType<typeof buildMap> | null = null
  for (let seed = 70000; seed < 90000; seed++) {
    const built = buildMap(id, complexity, seed); const { environment } = built
    const centerFree = !environment.isBlocked(M25_DESIGN.start)
    const nearBlocked = complexity === 0 || Array.from({ length: 8 }, (_, i) => i * Math.PI / 4)
      .some((a) => environment.isBlocked(add(M25_DESIGN.start, { x: 0.034 * Math.cos(a), y: 0.034 * Math.sin(a) })))
    if (centerFree && !fallback) fallback = { ...built, localAvoidanceChallenge: nearBlocked }
    if (centerFree && nearBlocked) return { ...built, localAvoidanceChallenge: true }
  }
  if (fallback) return fallback
  throw new Error(`No center-safe map found for ${id}`)
})
const buildMap = (id: typeof M25_MAPS[number], complexity: number, seed: number) => {
  const cfg = configFor(complexity); const raw = createScenario(complexity ? 'obstructed' : 'open', seed, cfg)
  const scenario = { ...raw, robotStart: { ...M25_DESIGN.start } }
  const model = createControllerObservationModel(publicScenario(scenario), seed + 1)
  const environment = createEnvironment(scenario, seed + 2, model, 0.01, 20)
  return { id, complexity, seed, scenario, environment, localAvoidanceChallenge: false }
}
export const executeM25Action = (map: ReturnType<typeof m25Maps>[number], desired: Vec2) => {
  let position: Vec2 = { ...M25_DESIGN.start }; const path: Vec2[] = [{ ...position }]; let collisions = 0; let alignment = 0
  const unit = normalize(desired)
  for (let step = 0; step < 4; step++) {
    const safe = map.environment.safeDirection(position, unit); alignment += safe.x * unit.x + safe.y * unit.y
    const displacement = scale(safe, 0.0025 * map.environment.terrainMobilityScale(safe)); const proposed = add(position, displacement)
    const travel = distance(position, proposed); const probes = Math.max(1, Math.ceil(travel / 0.008)); let blocked = false
    for (let i = 1; i <= probes; i++) if (map.environment.isBlocked({ x: position.x + (proposed.x - position.x) * i / probes, y: position.y + (proposed.y - position.y) * i / probes })) { blocked = true; break }
    if (blocked) collisions++; else { position = proposed; path.push({ ...position }) }
  }
  return { position, path, distance: path.slice(1).reduce((s, p, i) => s + distance(path[i]!, p), 0),
    collisions, blockedEndpoint: map.environment.isBlocked(position), meanAlignment: alignment / 4 }
}
type M24Archive = { episodes: Array<{ nuisance: string; responseSeconds: number; dynamic: string; phase: number; body: number; seed: number;
  decisions: Array<{ arm: string; direction: Vec2 | null; action: { direction: Vec2 } }> }> }
const field = (dynamic: string, phase: number, p: Vec2) => {
  const d = M24_DYNAMICS.find((x) => x.id === dynamic)!; const a = m24Angle(d, phase, 12.5)
  return Math.max(0, 0.5 + 4 * Math.cos(a) * (p.x - 0.5) + 4 * Math.sin(a) * (p.y - 0.5))
}
export const runM25 = (archive: M24Archive) => {
  const maps = m25Maps(); const cells = new Map<string, { map: string; dynamic: string; nuisance: string; policy: string; actions: number; follows: number; explores: number; fullDistance: number; positiveGain: number; positiveFollowGain: number; collisions: number; blockedEndpoints: number; distance: number; gain: number; alignment: number }>()
  let actions = 0
  for (const e of archive.episodes) for (const map of maps) for (const policy of M25_POLICIES) {
    const time = e.decisions.find((d) => d.arm === 'time-aware')!, recovery = e.decisions.find((d) => d.arm === 'calibrated-recovery')!
    const direction = policy === 'time-aware' ? time.action.direction : policy === 'recovery' ? recovery.action.direction : { x: Math.cos(e.body), y: Math.sin(e.body) }
    const kind = policy === 'explore-only' ? 'explore' : (policy === 'time-aware' ? time.direction : recovery.direction) ? 'follow' : 'explore'
    const moved = executeM25Action(map, direction); const gain = field(e.dynamic, e.phase, moved.position) - field(e.dynamic, e.phase, M25_DESIGN.start)
    const key = `${map.id}|${e.dynamic}|${e.nuisance}|${policy}`
    const c = cells.get(key) ?? { map: map.id, dynamic: e.dynamic, nuisance: e.nuisance, policy, actions: 0, follows: 0, explores: 0, fullDistance: 0, positiveGain: 0, positiveFollowGain: 0, collisions: 0, blockedEndpoints: 0, distance: 0, gain: 0, alignment: 0 }
    c.actions++; c.follows += Number(kind === 'follow'); c.explores += Number(kind === 'explore'); c.fullDistance += Number(moved.distance >= 0.0099)
    c.positiveGain += Number(gain > 1e-12); c.positiveFollowGain += Number(kind === 'follow' && gain > 1e-12); c.collisions += moved.collisions; c.blockedEndpoints += Number(moved.blockedEndpoint); c.distance += moved.distance; c.gain += gain; c.alignment += moved.meanAlignment
    cells.set(key, c); actions++
  }
  const aggregates = [...cells.values()]
  const time = aggregates.filter((c) => c.policy === 'time-aware'), supportedFollow = time.filter((c) => c.nuisance !== 'slow' && c.follows >= 20)
  const totalFollows = supportedFollow.reduce((s, c) => s + c.follows, 0)
  const totalPositive = supportedFollow.reduce((s, c) => s + c.positiveFollowGain, 0)
  const failures = {
    safety: time.filter((c) => c.blockedEndpoints > 0),
    distance: time.filter((c) => c.fullDistance / c.actions < 0.99),
    gainCells: supportedFollow.filter((c) => c.positiveFollowGain / c.follows < 0.90),
    slowFollow: time.filter((c) => c.nuisance === 'slow' && c.follows > 0),
    overallGain: totalFollows ? totalPositive / totalFollows : 0,
  }
  return { complete: true, design: M25_DESIGN, mapManifest: maps.map((m) => ({ id: m.id, complexity: m.complexity, seed: m.seed, localAvoidanceChallenge: m.localAvoidanceChallenge, obstacles: m.scenario.obstacles })),
    actions, aggregates, failures, advancesToReacquisitionTest: !failures.safety.length && !failures.distance.length && !failures.gainCells.length && !failures.slowFollow.length && failures.overallGain >= 0.95,
    movementExecuted: true, newSensorCycles: 0, gslTrajectories: 0, appPromoted: false }
}
