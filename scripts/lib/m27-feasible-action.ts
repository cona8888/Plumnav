import { add, distance, normalize, scale } from '../../src/sim/math'
import type { Vec2 } from '../../src/sim/types'
import { M21_NUISANCES, m21Calibrate } from './m21-direction-study'
import { m24Angle, m24Episode, M24_DYNAMICS } from './m24-time-aware'
import { M23_ANGLES } from './m23-rotation-transfer'
import { m26Maps } from './m26-action-horizon'

export const M27_POLICIES = ['feasible-forecast', 'direct-forecast'] as const
export const M27_DESIGN = { policies: M27_POLICIES, maps: ['open', 'complexity-2', 'complexity-4', 'complexity-6'],
  actionSeconds: 1, steps: 4, dt: 0.25, plannedDistance: 0.01, segmentProbe: 0.008,
  candidateBearings: 16, calibrationReplicates: 2, trials: 5, expectedEpisodes: 49280,
  expectedActions: 394240, calibrationSeedBase: 63000, episodeSeedBase: 3000000,
  fullDistanceFraction: 0.99, positiveGainOverall: 0.95, positiveGainCell: 0.90,
  movementExecuted: true, newSensorCycles: 197120, gslTrajectories: 0, appPromoted: false } as const

type Map = ReturnType<typeof m26Maps>[number]
const executableDirection = (map: Map, position: Vec2, desired: Vec2, project: boolean) => {
  const target = normalize(desired)
  if (!project) return map.environment.safeDirection(position, target)
  let best = { direction: map.environment.safeDirection(position, target), score: -Infinity }
  for (let i = 0; i < M27_DESIGN.candidateBearings; i++) {
    const a = 2 * Math.PI * i / M27_DESIGN.candidateBearings
    const command = { x: Math.cos(a), y: Math.sin(a) }, actual = map.environment.safeDirection(position, command)
    const norm = Math.hypot(actual.x, actual.y); if (norm < 1e-12) continue
    const proposed = add(position, scale(actual, 0.0025 * map.environment.terrainMobilityScale(actual)))
    if (map.environment.isBlocked(proposed)) continue
    const score = actual.x * target.x + actual.y * target.y
    if (score > best.score) best = { direction: actual, score }
  }
  return best.direction
}

export const executeM27Action = (map: Map, desired: Vec2, project = true) => {
  let position = { ...map.start }; const path = [{ ...position }]; let collisions = 0; let alignment = 0
  const target = normalize(desired)
  for (let step = 0; step < M27_DESIGN.steps; step++) {
    const safe = executableDirection(map, position, target, project); alignment += safe.x * target.x + safe.y * target.y
    const proposed = add(position, scale(safe, 0.0025 * map.environment.terrainMobilityScale(safe)))
    const travel = distance(position, proposed), probes = Math.max(1, Math.ceil(travel / M27_DESIGN.segmentProbe)); let blocked = false
    for (let i = 1; i <= probes; i++) if (map.environment.isBlocked({ x: position.x + (proposed.x - position.x) * i / probes, y: position.y + (proposed.y - position.y) * i / probes })) { blocked = true; break }
    if (blocked) collisions++; else { position = proposed; path.push({ ...position }) }
  }
  return { position, path, distance: path.slice(1).reduce((s, p, i) => s + distance(path[i]!, p), 0), collisions,
    blockedEndpoint: map.environment.isBlocked(position), meanAlignment: alignment / M27_DESIGN.steps }
}

const rotate = (v: Vec2, a: number) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) })
const gainAtEnd = (dynamic: string, phase: number, start: Vec2, end: Vec2) => {
  const d = M24_DYNAMICS.find((x) => x.id === dynamic)!, a = m24Angle(d, phase, 12.5)
  return 4 * Math.cos(a) * (end.x - start.x) + 4 * Math.sin(a) * (end.y - start.y)
}

export const runM27 = () => {
  const maps = m26Maps(), episodes = []
  for (const [ni, n] of M21_NUISANCES.entries()) for (let rep = 0; rep < 2; rep++) {
    const calibration = m21Calibrate(n, M27_DESIGN.calibrationSeedBase + ni * 2 + rep).calibration
    for (const [di, dynamic] of M24_DYNAMICS.entries()) for (const [pi, phase] of M23_ANGLES.entries()) for (const [bi, body] of M23_ANGLES.entries()) for (let trial = 0; trial < 5; trial++) {
      const seed = M27_DESIGN.episodeSeedBase + ni * 200000 + rep * 100000 + di * 8000 + pi * 800 + bi * 10 + trial
      episodes.push(m24Episode(n, dynamic, phase, body, seed, calibration))
    }
  }
  const cells = new Map<string, { map: string; dynamic: string; nuisance: string; policy: string; actions: number; follows: number; explores: number; fullDistance: number; positiveFollowGain: number; collisions: number; blockedEndpoints: number; distance: number; gain: number; alignment: number }>(); let actions = 0
  for (const e of episodes) for (const map of maps) for (const policy of M27_POLICIES) {
    const decision = e.decisions.find((d) => d.arm === 'time-aware')!, follow = decision.direction !== null
    const desired = decision.direction ? rotate(decision.direction, decision.fittedRate! * M27_DESIGN.actionSeconds) : { x: Math.cos(e.body + Math.PI / 2), y: Math.sin(e.body + Math.PI / 2) }
    const moved = executeM27Action(map, desired, policy === 'feasible-forecast'), gain = gainAtEnd(e.dynamic, e.phase, map.start, moved.position)
    const key = `${map.id}|${e.dynamic}|${e.nuisance}|${policy}`, c = cells.get(key) ?? { map: map.id, dynamic: e.dynamic, nuisance: e.nuisance, policy, actions: 0, follows: 0, explores: 0, fullDistance: 0, positiveFollowGain: 0, collisions: 0, blockedEndpoints: 0, distance: 0, gain: 0, alignment: 0 }
    c.actions++; c.follows += Number(follow); c.explores += Number(!follow); c.fullDistance += Number(moved.distance >= 0.0099); c.positiveFollowGain += Number(follow && gain > 1e-12)
    c.collisions += moved.collisions; c.blockedEndpoints += Number(moved.blockedEndpoint); c.distance += moved.distance; c.gain += gain; c.alignment += moved.meanAlignment; cells.set(key, c); actions++
  }
  const aggregates = [...cells.values()], candidate = aggregates.filter((c) => c.policy === 'feasible-forecast'), supported = candidate.filter((c) => c.nuisance !== 'slow' && c.follows >= 20)
  const follows = supported.reduce((s, c) => s + c.follows, 0), positives = supported.reduce((s, c) => s + c.positiveFollowGain, 0)
  const failures = { safety: candidate.filter((c) => c.blockedEndpoints > 0), distance: candidate.filter((c) => c.fullDistance / c.actions < M27_DESIGN.fullDistanceFraction), gainCells: supported.filter((c) => c.positiveFollowGain / c.follows < M27_DESIGN.positiveGainCell), slowFollow: candidate.filter((c) => c.nuisance === 'slow' && c.follows > 0), overallGain: follows ? positives / follows : 0 }
  const advancesToReacquisitionTest = !failures.safety.length && !failures.distance.length && !failures.gainCells.length && !failures.slowFollow.length && failures.overallGain >= M27_DESIGN.positiveGainOverall
  return { complete: true, design: M27_DESIGN, mapManifest: maps.map((m) => ({ id: m.id, complexity: m.complexity, seed: m.seed, start: m.start, localAvoidanceChallenge: m.localAvoidanceChallenge, obstacles: m.scenario.obstacles })), episodes: episodes.length, actions, aggregates, failures, advancesToReacquisitionTest, movementExecuted: true, newSensorCycles: episodes.length * 4, gslTrajectories: 0, appPromoted: false }
}
