import { add, distance, normalize, scale } from '../../src/sim/math'
import type { Vec2 } from '../../src/sim/types'
import { M21_NUISANCES, m21Calibrate } from './m21-direction-study'
import { m24Angle, m24Episode, M24_DYNAMICS } from './m24-time-aware'
import { M23_ANGLES } from './m23-rotation-transfer'
import { m26Maps } from './m26-action-horizon'

export const M28_DESIGN = { actionSeconds: 1, steps: 4, dt: 0.25, plannedDistance: 0.01, segmentProbe: 0.008,
  candidateBearings: 16, exactForecastCandidate: true, calibrationReplicates: 2, trials: 5,
  expectedEpisodes: 49280, expectedActions: 197120, calibrationSeedBase: 64000, episodeSeedBase: 4000000,
  acceptanceFloorPerCell: 0.5, fullDistanceFraction: 0.99, positiveGainOverall: 0.95, positiveGainCell: 0.90,
  movementExecuted: true, newSensorCycles: 197120, gslTrajectories: 0, appPromoted: false } as const
type Map = ReturnType<typeof m26Maps>[number]
const choose = (map: Map, position: Vec2, desired: Vec2) => {
  const target = normalize(desired), direct = map.environment.safeDirection(position, target)
  let best = { direction: direct, score: direct.x * target.x + direct.y * target.y }
  for (let i = 0; i < M28_DESIGN.candidateBearings; i++) {
    const a = 2 * Math.PI * i / M28_DESIGN.candidateBearings, command = { x: Math.cos(a), y: Math.sin(a) }, actual = map.environment.safeDirection(position, command)
    if (Math.hypot(actual.x, actual.y) < 1e-12) continue
    const proposed = add(position, scale(actual, 0.0025 * map.environment.terrainMobilityScale(actual)))
    if (map.environment.isBlocked(proposed)) continue
    const score = actual.x * target.x + actual.y * target.y; if (score > best.score) best = { direction: actual, score }
  }
  return best.direction
}
export const executeM28ActionFrom = (map: Map, start: Vec2, desired: Vec2) => {
  let position = { ...start }; const path = [{ ...position }]; let collisions = 0; let alignment = 0; const target = normalize(desired)
  for (let step = 0; step < M28_DESIGN.steps; step++) {
    const safe = choose(map, position, target); alignment += safe.x * target.x + safe.y * target.y
    const proposed = add(position, scale(safe, 0.0025 * map.environment.terrainMobilityScale(safe))), travel = distance(position, proposed), probes = Math.max(1, Math.ceil(travel / M28_DESIGN.segmentProbe)); let blocked = false
    for (let i = 1; i <= probes; i++) if (map.environment.isBlocked({ x: position.x + (proposed.x - position.x) * i / probes, y: position.y + (proposed.y - position.y) * i / probes })) { blocked = true; break }
    if (blocked) collisions++; else { position = proposed; path.push({ ...position }) }
  }
  return { position, path, distance: path.slice(1).reduce((s, p, i) => s + distance(path[i]!, p), 0), collisions, blockedEndpoint: map.environment.isBlocked(position), meanAlignment: alignment / M28_DESIGN.steps }
}
export const executeM28Action = (map: Map, desired: Vec2) => executeM28ActionFrom(map, map.start, desired)
const rotate = (v: Vec2, a: number) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) })
export const runM28 = () => {
  const maps = m26Maps(), cells = new Map<string, { map: string; dynamic: string; nuisance: string; actions: number; follows: number; explores: number; fullDistance: number; positiveFollowGain: number; collisions: number; blockedEndpoints: number; distance: number; gain: number; alignment: number }>(); let episodes = 0, actions = 0
  for (const [ni, n] of M21_NUISANCES.entries()) for (let rep = 0; rep < 2; rep++) {
    const calibration = m21Calibrate(n, M28_DESIGN.calibrationSeedBase + ni * 2 + rep).calibration
    for (const [di, dynamic] of M24_DYNAMICS.entries()) for (const [pi, phase] of M23_ANGLES.entries()) for (const [bi, body] of M23_ANGLES.entries()) for (let trial = 0; trial < 5; trial++) {
      const seed = M28_DESIGN.episodeSeedBase + ni * 200000 + rep * 100000 + di * 8000 + pi * 800 + bi * 10 + trial, e = m24Episode(n, dynamic, phase, body, seed, calibration), decision = e.decisions.find((d) => d.arm === 'time-aware')!; episodes++
      const follow = decision.direction !== null, desired = decision.direction ? rotate(decision.direction, decision.fittedRate! * M28_DESIGN.actionSeconds) : { x: Math.cos(body + Math.PI / 2), y: Math.sin(body + Math.PI / 2) }
      const truth = m24Angle(dynamic, phase, 12.5), truthDirection = { x: Math.cos(truth), y: Math.sin(truth) }
      for (const map of maps) { const moved = executeM28Action(map, desired), delta = { x: moved.position.x - map.start.x, y: moved.position.y - map.start.y }, gain = 4 * (truthDirection.x * delta.x + truthDirection.y * delta.y), key = `${map.id}|${dynamic.id}|${n.id}`
        const c = cells.get(key) ?? { map: map.id, dynamic: dynamic.id, nuisance: n.id, actions: 0, follows: 0, explores: 0, fullDistance: 0, positiveFollowGain: 0, collisions: 0, blockedEndpoints: 0, distance: 0, gain: 0, alignment: 0 }
        c.actions++; c.follows += Number(follow); c.explores += Number(!follow); c.fullDistance += Number(moved.distance >= 0.0099); c.positiveFollowGain += Number(follow && gain > 1e-12); c.collisions += moved.collisions; c.blockedEndpoints += Number(moved.blockedEndpoint); c.distance += moved.distance; c.gain += gain; c.alignment += moved.meanAlignment; cells.set(key, c); actions++ }
    }
  }
  const aggregates = [...cells.values()], supported = aggregates.filter((c) => c.nuisance !== 'slow'), follows = supported.reduce((s, c) => s + c.follows, 0), positives = supported.reduce((s, c) => s + c.positiveFollowGain, 0)
  const failures = { safety: aggregates.filter((c) => c.blockedEndpoints > 0), distance: aggregates.filter((c) => c.fullDistance / c.actions < M28_DESIGN.fullDistanceFraction), acceptance: supported.filter((c) => c.follows / c.actions < M28_DESIGN.acceptanceFloorPerCell), gainCells: supported.filter((c) => c.follows >= 20 && c.positiveFollowGain / c.follows < M28_DESIGN.positiveGainCell), slowFollow: aggregates.filter((c) => c.nuisance === 'slow' && c.follows > 0), overallGain: positives / follows }
  const advancesToReacquisitionTest = !failures.safety.length && !failures.distance.length && !failures.acceptance.length && !failures.gainCells.length && !failures.slowFollow.length && failures.overallGain >= M28_DESIGN.positiveGainOverall
  return { complete: true, design: M28_DESIGN, mapManifest: maps.map((m) => ({ id: m.id, complexity: m.complexity, seed: m.seed, start: m.start, localAvoidanceChallenge: m.localAvoidanceChallenge, obstacles: m.scenario.obstacles })), episodes, actions, aggregates, failures, advancesToReacquisitionTest, movementExecuted: true, newSensorCycles: episodes * 4, gslTrajectories: 0, appPromoted: false }
}
