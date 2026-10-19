import { createDefaultConfig } from '../../src/sim/config'
import { createScenario } from '../../src/sim/scenarios'
import { createControllerObservationModel } from '../../src/sim/controllerObservationModel'
import { createEnvironment } from '../../src/sim/environment'
import { add, distance, normalize, scale } from '../../src/sim/math'
import type { Scenario, Vec2 } from '../../src/sim/types'
import { M21_NUISANCES, m21Calibrate } from './m21-direction-study'
import { m24Angle, m24Episode, M24_DYNAMICS } from './m24-time-aware'
import { M23_ANGLES } from './m23-rotation-transfer'

export const M26_POLICIES = ['endpoint-forecast', 'decision-time', 'explore-only'] as const
export const M26_MAPS = ['open', 'complexity-2', 'complexity-4', 'complexity-6'] as const
export const M26_DESIGN = {
  policies: M26_POLICIES, maps: M26_MAPS, actionSeconds: 1, steps: 4, dt: 0.25,
  plannedDistance: 0.01, segmentProbe: 0.008, obstacleProbeRadius: 0.012,
  calibrationReplicates: 2, trials: 5, expectedEpisodes: 49280,
  expectedActions: 591360, calibrationSeedBase: 62000, episodeSeedBase: 2000000,
  fullDistanceFraction: 0.99, positiveGainOverall: 0.95, positiveGainCell: 0.90,
  minimumChallengeFraction: 0.01, developmentChoice: 'endpoint forecast from frozen M24 evidence',
  movementExecuted: true, newSensorCycles: 197120, gslTrajectories: 0, appPromoted: false,
} as const

const publicScenario = (s: Scenario) => { const { source: _s, targetStatus: _t, ...rest } = s; return rest }
const configFor = (complexity: number) => ({ ...createDefaultConfig('coverage', complexity ? 'obstructed' : 'open'),
  obstacleComplexityLevel: complexity, targetStatus: 'absent' as const, terrainSlopeDegrees: 0,
  robotStartPositionOverride: undefined, sourcePositionOverride: undefined })

const buildMap = (id: typeof M26_MAPS[number], complexity: number, seed: number) => {
  const cfg = configFor(complexity); const raw = createScenario(complexity ? 'obstructed' : 'open', seed, cfg)
  const model = createControllerObservationModel(publicScenario(raw), seed + 1)
  const environment = createEnvironment(raw, seed + 2, model, 0.01, 20)
  let start = { x: 0.5, y: 0.5 }, challenged = complexity === 0
  if (complexity) {
    challenged = false
    outer: for (let yi = 12; yi <= 188; yi++) for (let xi = 12; xi <= 188; xi++) {
      const p = { x: xi / 200, y: yi / 200 }
      if (environment.isBlocked(p)) continue
      const near = Array.from({ length: 32 }, (_, i) => i * Math.PI / 16).some((a) =>
        environment.isBlocked(add(p, { x: M26_DESIGN.obstacleProbeRadius * Math.cos(a), y: M26_DESIGN.obstacleProbeRadius * Math.sin(a) })))
      if (near) { start = p; challenged = true; break outer }
    }
  }
  return { id, complexity, seed, scenario: { ...raw, robotStart: start }, environment, start, localAvoidanceChallenge: challenged }
}

export const m26Maps = () => M26_MAPS.map((id) => {
  const complexity = id === 'open' ? 0 : Number(id.split('-')[1])
  for (let seed = 80000; seed < 80100; seed++) {
    const map = buildMap(id, complexity, seed)
    if (map.localAvoidanceChallenge) return map
  }
  throw new Error(`No obstacle-adjacent clearance-safe start found for ${id}`)
})

export const executeM26Action = (map: ReturnType<typeof m26Maps>[number], desired: Vec2) => {
  let position = { ...map.start }; const path = [{ ...position }]; let collisions = 0; let alignment = 0
  const unit = normalize(desired)
  for (let step = 0; step < M26_DESIGN.steps; step++) {
    const safe = map.environment.safeDirection(position, unit); alignment += safe.x * unit.x + safe.y * unit.y
    const displacement = scale(safe, 0.0025 * map.environment.terrainMobilityScale(safe)); const proposed = add(position, displacement)
    const travel = distance(position, proposed); const probes = Math.max(1, Math.ceil(travel / M26_DESIGN.segmentProbe)); let blocked = false
    for (let i = 1; i <= probes; i++) if (map.environment.isBlocked({ x: position.x + (proposed.x - position.x) * i / probes, y: position.y + (proposed.y - position.y) * i / probes })) { blocked = true; break }
    if (blocked) collisions++; else { position = proposed; path.push({ ...position }) }
  }
  return { position, path, distance: path.slice(1).reduce((s, p, i) => s + distance(path[i]!, p), 0), collisions,
    blockedEndpoint: map.environment.isBlocked(position), meanAlignment: alignment / M26_DESIGN.steps }
}

const rotate = (v: Vec2, angle: number) => ({ x: v.x * Math.cos(angle) - v.y * Math.sin(angle), y: v.x * Math.sin(angle) + v.y * Math.cos(angle) })
const field = (dynamic: string, phase: number, anchor: Vec2, p: Vec2) => {
  const d = M24_DYNAMICS.find((x) => x.id === dynamic)!; const a = m24Angle(d, phase, 12.5)
  return Math.max(0, 0.5 + 4 * Math.cos(a) * (p.x - anchor.x) + 4 * Math.sin(a) * (p.y - anchor.y))
}

export const runM26 = () => {
  const maps = m26Maps(); const episodes = []
  for (const [ni, n] of M21_NUISANCES.entries()) for (let rep = 0; rep < 2; rep++) {
    const calibration = m21Calibrate(n, M26_DESIGN.calibrationSeedBase + ni * 2 + rep).calibration
    for (const [di, dynamic] of M24_DYNAMICS.entries()) for (const [pi, phase] of M23_ANGLES.entries()) for (const [bi, body] of M23_ANGLES.entries()) for (let trial = 0; trial < 5; trial++) {
      const seed = M26_DESIGN.episodeSeedBase + ni * 200000 + rep * 100000 + di * 8000 + pi * 800 + bi * 10 + trial
      episodes.push(m24Episode(n, dynamic, phase, body, seed, calibration))
    }
  }
  const cells = new Map<string, { map: string; dynamic: string; nuisance: string; policy: string; actions: number; follows: number; explores: number; fullDistance: number; positiveFollowGain: number; collisions: number; blockedEndpoints: number; challenged: number; distance: number; gain: number; alignment: number }>()
  let actions = 0
  for (const e of episodes) for (const map of maps) for (const policy of M26_POLICIES) {
    const decision = e.decisions.find((d) => d.arm === 'time-aware')!
    const follow = policy !== 'explore-only' && decision.direction !== null
    const desired = policy === 'explore-only' || !decision.direction ? { x: Math.cos(e.body + Math.PI / 2), y: Math.sin(e.body + Math.PI / 2) }
      : policy === 'endpoint-forecast' ? rotate(decision.direction, decision.fittedRate! * M26_DESIGN.actionSeconds) : decision.direction
    const moved = executeM26Action(map, desired); const gain = field(e.dynamic, e.phase, map.start, moved.position) - field(e.dynamic, e.phase, map.start, map.start)
    const key = `${map.id}|${e.dynamic}|${e.nuisance}|${policy}`
    const c = cells.get(key) ?? { map: map.id, dynamic: e.dynamic, nuisance: e.nuisance, policy, actions: 0, follows: 0, explores: 0, fullDistance: 0, positiveFollowGain: 0, collisions: 0, blockedEndpoints: 0, challenged: 0, distance: 0, gain: 0, alignment: 0 }
    c.actions++; c.follows += Number(follow); c.explores += Number(!follow); c.fullDistance += Number(moved.distance >= 0.0099)
    c.positiveFollowGain += Number(follow && gain > 1e-12); c.collisions += moved.collisions; c.blockedEndpoints += Number(moved.blockedEndpoint)
    c.challenged += Number(moved.meanAlignment < 0.999); c.distance += moved.distance; c.gain += gain; c.alignment += moved.meanAlignment
    cells.set(key, c); actions++
  }
  const aggregates = [...cells.values()], candidate = aggregates.filter((c) => c.policy === 'endpoint-forecast')
  const supported = candidate.filter((c) => c.nuisance !== 'slow' && c.follows >= 20)
  const follows = supported.reduce((s, c) => s + c.follows, 0), positives = supported.reduce((s, c) => s + c.positiveFollowGain, 0)
  const obstacle = candidate.filter((c) => c.map !== 'open')
  const failures = { safety: candidate.filter((c) => c.blockedEndpoints > 0), distance: candidate.filter((c) => c.fullDistance / c.actions < M26_DESIGN.fullDistanceFraction),
    gainCells: supported.filter((c) => c.positiveFollowGain / c.follows < M26_DESIGN.positiveGainCell), slowFollow: candidate.filter((c) => c.nuisance === 'slow' && c.follows > 0),
    overallGain: follows ? positives / follows : 0, challengeFraction: obstacle.reduce((s, c) => s + c.challenged, 0) / obstacle.reduce((s, c) => s + c.actions, 0) }
  const advancesToReacquisitionTest = !failures.safety.length && !failures.distance.length && !failures.gainCells.length && !failures.slowFollow.length && failures.overallGain >= M26_DESIGN.positiveGainOverall && failures.challengeFraction >= M26_DESIGN.minimumChallengeFraction
  return { complete: true, design: M26_DESIGN, mapManifest: maps.map((m) => ({ id: m.id, complexity: m.complexity, seed: m.seed, start: m.start, localAvoidanceChallenge: m.localAvoidanceChallenge, obstacles: m.scenario.obstacles })), episodes: episodes.length, actions, aggregates, failures, advancesToReacquisitionTest, movementExecuted: true, newSensorCycles: episodes.length * 4, gslTrajectories: 0, appPromoted: false }
}
