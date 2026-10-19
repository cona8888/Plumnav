import { correctDirectionReadings, directionDecision, type DirectionCalibration } from './m21-direction'
import { M21_NUISANCES, m21Calibrate } from './m21-direction-study'
import { recoveryDecision, type TimedView } from './m22-recovery'
import { M23_ANGLES } from './m23-rotation-transfer'
import { SimulationEngine } from '../../src/sim/engine'
import { createDefaultConfig } from '../../src/sim/config'
import { SeededRandom } from '../../src/sim/rng'
import { createQuadSniffEvent, integrateQuadSniffEvent, quadSniffStatusAt, type QuadSniffEvent } from '../../src/sim/quadSniff'
import type { Measurement, QuadSniffStatus, Vec2 } from '../../src/sim/types'
import type { PlumeModel } from '../../src/sim/plume'

export const M24_DYNAMICS = [
  { id: 'static', kind: 'constant', value: 0 },
  ...[-Math.PI / 2, -Math.PI / 4, -Math.PI / 8, Math.PI / 8, Math.PI / 4, Math.PI / 2].map((value) => ({ id: `rate-${value}`, kind: 'constant', value })),
  { id: 'reverse-positive', kind: 'reversal', value: Math.PI / 4 }, { id: 'reverse-negative', kind: 'reversal', value: -Math.PI / 4 },
  { id: 'accelerate-positive', kind: 'acceleration', value: Math.PI / 8 }, { id: 'accelerate-negative', kind: 'acceleration', value: -Math.PI / 8 },
] as const
export type M24Dynamic = typeof M24_DYNAMICS[number]
export const M24_ARMS = ['calibrated-consistent', 'calibrated-recovery', 'time-aware'] as const
export const M24_DESIGN = { dynamics: M24_DYNAMICS, angles: M23_ANGLES, arms: M24_ARMS,
  calibrationReplicates: 2, trials: 5, expectedCalibrations: 14, expectedEpisodes: 49280,
  expectedDecisions: 147840, calibrationSeedBase: 61000, episodeSeedBase: 1000000,
  bandwidthSeconds: 0.75, fitResidualRadians: Math.PI / 6, maximumRate: 2,
  acceptanceFloor: 0.5, wrongCap: 0.05, medianCap: 30, finalTime: 11.5,
  movementExecuted: false, gslTrajectories: 0, appPromoted: false } as const
const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x))
export const timeAwareDecision = (views: TimedView[], c: DirectionCalibration, now: number, responseSeconds: number) => {
  const explore = (reason: string) => ({ direction: null as { x: number; y: number } | null, reason, fittedRate: null as number | null,
    maximumResidual: null as number | null, action: { kind: 'explore' as const, direction: { x: Math.cos((views.at(-1)?.heading ?? 0) + Math.PI / 2), y: Math.sin((views.at(-1)?.heading ?? 0) + Math.PI / 2) }, plannedDistance: 0.01, plannedDuration: 1, executedDistance: 0 } })
  if (!Number.isFinite(responseSeconds) || responseSeconds <= 0 || responseSeconds > 0.75) return explore('sensor-bandwidth')
  if (views.length !== 4 || !Number.isFinite(now) || views.some((v, i) => !Number.isFinite(v.time) || v.time > now || (i > 0 && v.time <= views[i - 1]!.time)) || now - views[3]!.time > 0.25) return explore('invalid-or-stale-history')
  if (directionDecision(views, c, 'calibrated').reason === 'boundary-or-incomplete') return explore('boundary-or-incomplete')
  const threshold = 3 * Math.sqrt(c.correctedVariance)
  const rows = views.slice(-3).map((v) => {
    const z = correctDirectionReadings(v.values, c); const bx = z[0]! - z[2]!; const by = z[3]! - z[1]!
    const x = bx * Math.cos(v.heading) - by * Math.sin(v.heading); const y = bx * Math.sin(v.heading) + by * Math.cos(v.heading)
    return { time: v.time - 0.25, angle: Math.atan2(y, x), magnitude: Math.hypot(x, y) }
  })
  if (rows.some((r) => !Number.isFinite(r.magnitude) || r.magnitude <= threshold)) return explore('weak-contrast')
  const angles = [rows[0]!.angle]
  for (let i = 1; i < rows.length; i++) angles.push(angles[i - 1]! + wrap(rows[i]!.angle - rows[i - 1]!.angle))
  const mt = rows.reduce((s, r) => s + r.time, 0) / 3; const ma = angles.reduce((s, a) => s + a, 0) / 3
  const den = rows.reduce((s, r) => s + (r.time - mt) ** 2, 0)
  const rate = rows.reduce((s, r, i) => s + (r.time - mt) * (angles[i]! - ma), 0) / den
  const residual = Math.max(...rows.map((r, i) => Math.abs(wrap(angles[i]! - (ma + rate * (r.time - mt))))))
  if (!Number.isFinite(rate) || Math.abs(rate) > 2 || residual > Math.PI / 6) return explore('unreliable-temporal-fit')
  const angle = ma + rate * (now - mt); const direction = { x: Math.cos(angle), y: Math.sin(angle) }
  return { direction, reason: 'time-aware-direction', fittedRate: rate, maximumResidual: residual,
    action: { kind: 'follow' as const, direction, plannedDistance: 0.01, plannedDuration: 1, executedDistance: 0 } }
}

// Development candidate for M32. Unlike the legacy M21 validity screen, this
// tests differential information after channel calibration and therefore does
// not reject an entire four-view history merely because one absolute reading is
// near the sensor boundary.
export const contrastAwareTimeDecision = (views: TimedView[], c: DirectionCalibration, now: number, responseSeconds: number) => {
  const explore = (reason: string) => ({ direction: null as Vec2 | null, reason, fittedRate: null as number | null,
    maximumResidual: null as number | null, action: { kind: 'explore' as const,
      direction: { x: Math.cos((views.at(-1)?.heading ?? 0) + Math.PI / 2), y: Math.sin((views.at(-1)?.heading ?? 0) + Math.PI / 2) },
      plannedDistance: 0.01, plannedDuration: 1, executedDistance: 0 } })
  if (!Number.isFinite(responseSeconds) || responseSeconds <= 0 || responseSeconds > M24_DESIGN.bandwidthSeconds) return explore('sensor-bandwidth')
  if (views.length !== 4 || !Number.isFinite(now) || views.some((v, i) => !Number.isFinite(v.time) || v.time > now ||
    v.values.length !== 4 || v.values.some((x) => !Number.isFinite(x)) || (i > 0 && v.time <= views[i - 1]!.time)) ||
    now - views[3]!.time > 0.25) return explore('invalid-or-stale-history')
  if (c.slopes.length !== 4 || c.offsets.length !== 4 || c.slopes.some((x) => !Number.isFinite(x) || x < 0.25 || x > 2) ||
    c.offsets.some((x) => !Number.isFinite(x)) || !Number.isFinite(c.correctedVariance) || c.correctedVariance < 0) return explore('invalid-calibration')
  const threshold = 3 * Math.sqrt(c.correctedVariance)
  const rows = views.slice(-3).map((v) => {
    const z = correctDirectionReadings(v.values, c)
    const bx = z[0]! - z[2]!, by = z[3]! - z[1]!
    const x = bx * Math.cos(v.heading) - by * Math.sin(v.heading)
    const y = bx * Math.sin(v.heading) + by * Math.cos(v.heading)
    const rawLow = v.values.filter((value) => value <= 0.075).length
    const rawHigh = v.values.filter((value) => value >= 1.425).length
    return { time: v.time - 0.25, angle: Math.atan2(y, x), magnitude: Math.hypot(x, y), allAtBoundary: rawLow === 4 || rawHigh === 4 }
  })
  if (rows.some((row) => row.allAtBoundary || !Number.isFinite(row.magnitude) || row.magnitude <= threshold)) return explore('insufficient-differential-contrast')
  const angles = [rows[0]!.angle]
  for (let i = 1; i < rows.length; i++) angles.push(angles[i - 1]! + wrap(rows[i]!.angle - rows[i - 1]!.angle))
  const mt = rows.reduce((total, row) => total + row.time, 0) / rows.length
  const ma = angles.reduce((total, angle) => total + angle, 0) / angles.length
  const den = rows.reduce((total, row) => total + (row.time - mt) ** 2, 0)
  const rate = rows.reduce((total, row, i) => total + (row.time - mt) * (angles[i]! - ma), 0) / den
  const residual = Math.max(...rows.map((row, i) => Math.abs(wrap(angles[i]! - (ma + rate * (row.time - mt))))))
  if (!Number.isFinite(rate) || Math.abs(rate) > M24_DESIGN.maximumRate || residual > M24_DESIGN.fitResidualRadians) return explore('unreliable-temporal-fit')
  const angle = ma + rate * (now - mt)
  const direction = { x: Math.cos(angle), y: Math.sin(angle) }
  return { direction, reason: 'contrast-aware-time-direction', fittedRate: rate, maximumResidual: residual,
    action: { kind: 'follow' as const, direction, plannedDistance: 0.01, plannedDuration: 1, executedDistance: 0 } }
}
export const m24Angle = (d: M24Dynamic, phase: number, time: number) => {
  const u = time - 8
  if (d.kind === 'constant') return phase + d.value * u
  if (d.kind === 'reversal') return phase + d.value * (u <= 2 ? u : 4 - u)
  return phase + 0.5 * d.value * u * u
}
type Nuisance = typeof M21_NUISANCES[number]
export type M24SensorSeam = { time: number; rng: SeededRandom; sensorState: number; quadSensorStates: Record<string, number>;
  senseConcentration: (c: number, mode: 'passive') => Measurement;
  senseQuadConcentration: (e: QuadSniffEvent, s: QuadSniffStatus) => Measurement }
const anchor = { x: 0.5, y: 0.5 }
export const makeM24Sensor = (n: Nuisance, seed: number) => {
  const e = new SimulationEngine({ ...createDefaultConfig('quad-sniff', 'open'), sensorNoise: 0.025, sensorSaturation: 1.5,
    sensorLag: n.lag, quadChannelGainMismatch: n.drift ? 0.2 : n.gain, quadChannelNoiseCorrelation: n.rho,
    quadChannelCrossTalk: n.cross, quadChannelLagMismatch: n.lagMismatch, fixedDt: 0.25, windNoise: 0,
    sensorFalsePositiveRate: 0, sensorFalseNegativeRate: 0, stopOnNativeDeclaration: false }) as unknown as M24SensorSeam
  e.rng = new SeededRandom(seed); e.time = 0; e.sensorState = 0
  e.quadSensorStates = { front: 0, left: 0, aft: 0, right: 0 }; return e
}
export const m24Concentration = (d: M24Dynamic, phase: number, p: Vec2, time: number) => {
  const angle = m24Angle(d, phase, time)
  return Math.max(0, 0.5 + 4 * Math.cos(angle) * (p.x - 0.5) + 4 * Math.sin(angle) * (p.y - 0.5))
}
export const m24Passive = (e: M24SensorSeam, field: (p: Vec2, t: number) => number, start: number, count: number, origin: Vec2 = anchor) => {
  let measurement: Measurement | null = null
  for (let k = 1; k <= count; k++) { e.time = start + k * 0.25; measurement = e.senseConcentration(field(origin, e.time), 'passive') }
  return measurement
}
export const m24Scan = (e: M24SensorSeam, field: (p: Vec2, t: number) => number, start: number, heading: number,
  origin: Vec2 = anchor, intakeFraction = 1) => {
  const fraction = Math.max(0.05, Math.min(1, intakeFraction))
  const plume = { concentrationAt: (p: Vec2, time: number) => fraction * field(p, time) } as unknown as PlumeModel
  const event = createQuadSniffEvent({ command: { scanId: start, forward: { x: Math.cos(heading), y: Math.sin(heading) } },
    origin, time: start, strengthScale: 0.78, samplingMode: 'active-suction', passiveArrayRadius: 0.0125,
    cycleSeconds: 0.5, reachForDirection: () => 0.0975, plume, isBlocked: () => false })!
  integrateQuadSniffEvent(event, start + 0.25, plume); integrateQuadSniffEvent(event, start + 0.5, plume)
  e.time = start + 0.5
  return e.senseQuadConcentration(event, quadSniffStatusAt(event, e.time)).quadSniff!.readings!.map((r) => r.concentration)
}
export const m24Episode = (n: Nuisance, dynamic: M24Dynamic, phase: number, body: number, seed: number,
  calibration: ReturnType<typeof m21Calibrate>['calibration']) => {
  const e = makeM24Sensor(n, seed); const field = (p: Vec2, t: number) => m24Concentration(dynamic, phase, p, t)
  m24Passive(e, field, 0, 32)
  const views: TimedView[] = [0, 1, 2, 3].map((slot) => {
    const start = 8 + slot; if (slot) m24Passive(e, field, start - 0.5, 2)
    const heading = body + slot * Math.PI / 2
    return { heading, time: start + 0.5, values: m24Scan(e, field, start, heading) }
  })
  const truthAngle = m24Angle(dynamic, phase, 11.5); const truth = { x: Math.cos(truthAngle), y: Math.sin(truthAngle) }
  const decisions = M24_ARMS.map((arm) => {
    const d = arm === 'time-aware' ? timeAwareDecision(views, calibration, 11.5, n.lag) : recoveryDecision(views, calibration, arm, 11.5)
    const delta = d.direction ? Math.atan2(d.direction.y, d.direction.x) - truthAngle : null
    return { arm, ...d, angleError: delta === null ? null : Math.abs(wrap(delta)) * 180 / Math.PI }
  })
  return { nuisance: n.id, responseSeconds: n.lag, dynamic: dynamic.id, phase, body, seed, truth, views, decisions }
}
const quantile = (values: number[], p: number) => { const a = [...values].sort((x, y) => x - y); if (!a.length) return null
  const z = (a.length - 1) * p, lo = Math.floor(z), hi = Math.ceil(z); return a[lo]! + (a[hi]! - a[lo]!) * (z - lo) }
export const runM24 = () => {
  const calibrations = []
  const episodes: ReturnType<typeof m24Episode>[] = []
  for (const [ni, n] of M21_NUISANCES.entries()) for (let rep = 0; rep < 2; rep++) {
    const calibration = m21Calibrate(n, 61000 + ni * 2 + rep); calibrations.push({ nuisance: n.id, rep, responseSeconds: n.lag, ...calibration })
    for (const [di, dynamic] of M24_DYNAMICS.entries()) for (const [pi, phase] of M23_ANGLES.entries()) for (const [bi, body] of M23_ANGLES.entries()) for (let trial = 0; trial < 5; trial++) {
      const seed = 1000000 + ni * 200000 + rep * 100000 + di * 8000 + pi * 800 + bi * 10 + trial
      episodes.push(m24Episode(n, dynamic, phase, body, seed, calibration.calibration))
    }
  }
  const aggregates = M21_NUISANCES.flatMap((n) => M24_DYNAMICS.flatMap((dynamic) => M24_ARMS.map((arm) => {
    const ds = episodes.filter((e) => e.nuisance === n.id && e.dynamic === dynamic.id).flatMap((e) => e.decisions.filter((x) => x.arm === arm))
    const accepted = ds.filter((d) => d.direction); const errors = accepted.map((d) => d.angleError!)
    return { nuisance: n.id, responseSeconds: n.lag, dynamic: dynamic.id, arm, episodes: ds.length, accepted: accepted.length,
      wrong: errors.filter((x) => x > 45).length, medianError: quantile(errors, 0.5), p90Error: quantile(errors, 0.9),
      bandwidthAbstentions: ds.filter((d) => d.reason === 'sensor-bandwidth').length }
  })))
  const supportedFailures = aggregates.filter((a) => a.arm === 'time-aware' && a.responseSeconds <= 0.75 &&
    (a.accepted < 320 || a.wrong > 0.05 * a.accepted || a.medianError === null || a.medianError > 30))
  const unsupportedFailures = aggregates.filter((a) => a.arm === 'time-aware' && a.responseSeconds > 0.75 &&
    (a.accepted > 32 || a.bandwidthAbstentions !== 640))
  const staticCells = M21_NUISANCES.filter((n) => n.lag <= 0.75).flatMap((n) => M23_ANGLES.flatMap((phase) => M23_ANGLES.map((body) => {
    const ds = episodes.filter((e) => e.nuisance === n.id && e.dynamic === 'static' && e.phase === phase && e.body === body).flatMap((e) => e.decisions.filter((d) => d.arm === 'time-aware'))
    return { nuisance: n.id, phase, body, episodes: ds.length, accepted: ds.filter((d) => d.direction).length, wrong: ds.filter((d) => d.angleError !== null && d.angleError > 45).length }
  })))
  const staticFailures = staticCells.filter((c) => c.accepted < 5 || c.wrong > 0.05 * c.accepted)
  return { complete: true, design: M24_DESIGN, calibrations, episodes, summary: { aggregates, supportedFailures, unsupportedFailures, staticCells, staticFailures,
    advancesToExecutedActionTest: !supportedFailures.length && !unsupportedFailures.length && !staticFailures.length,
    movementExecuted: false, gslTrajectories: 0, appPromoted: false } }
}
