import { SimulationEngine } from '../../src/sim/engine'
import { createDefaultConfig } from '../../src/sim/config'
import { SeededRandom } from '../../src/sim/rng'
import { createQuadSniffEvent, integrateQuadSniffEvent, quadSniffStatusAt, type QuadSniffEvent } from '../../src/sim/quadSniff'
import type { Measurement, QuadSniffStatus, Vec2 } from '../../src/sim/types'
import type { PlumeModel } from '../../src/sim/plume'
import { m21Calibrate, M21_NUISANCES } from './m21-direction-study'
import { recoveryDecision, type TimedView } from './m22-recovery'

export const M23_RATES = [-Math.PI / 2, -Math.PI / 4, -Math.PI / 8, 0, Math.PI / 8, Math.PI / 4, Math.PI / 2] as const
export const M23_ANGLES = Array.from({ length: 8 }, (_, i) => i * Math.PI / 4)
export const M23_ARMS = ['raw-consistent', 'calibrated-consistent', 'raw-recovery', 'calibrated-recovery'] as const
export const M23_DESIGN = { rates: M23_RATES, angles: M23_ANGLES, calibrationReplicates: 2, trials: 5,
  expectedCalibrations: 14, expectedEpisodes: 31360, expectedDecisions: 125440,
  calibrationSeedBase: 51000, episodeSeedBase: 300000, finalTime: 11.5,
  warmupSeconds: 8, drawSeconds: 2, turnSeconds: 1.5, calibrationSeconds: 144,
  acceptanceFloor: 0.5, wrongCap: 0.05, medianErrorCap: 30,
  movementExecuted: false, gslTrajectories: 0, appPromoted: false } as const
type Nuisance = typeof M21_NUISANCES[number]
type Seam = { time: number; rng: SeededRandom; sensorState: number; quadSensorStates: Record<string, number>;
  senseConcentration: (c: number, mode: 'passive') => Measurement;
  senseQuadConcentration: (e: QuadSniffEvent, s: QuadSniffStatus) => Measurement }
const anchor = { x: 0.5, y: 0.5 }
const sensor = (n: Nuisance, seed: number) => {
  const e = new SimulationEngine({ ...createDefaultConfig('quad-sniff', 'open'), sensorNoise: 0.025, sensorSaturation: 1.5,
    sensorLag: n.lag, quadChannelGainMismatch: n.drift ? 0.2 : n.gain,
    quadChannelNoiseCorrelation: n.rho, quadChannelCrossTalk: n.cross, quadChannelLagMismatch: n.lagMismatch,
    fixedDt: 0.25, windNoise: 0, sensorFalsePositiveRate: 0, sensorFalseNegativeRate: 0,
    stopOnNativeDeclaration: false }) as unknown as Seam
  e.rng = new SeededRandom(seed); e.time = 0; e.sensorState = 0
  e.quadSensorStates = { front: 0, left: 0, aft: 0, right: 0 }; return e
}
export const m23Field = (phase: number, rate: number, p: Vec2, time: number) => {
  const angle = phase + rate * (time - 8); const gradient = { x: 4 * Math.cos(angle), y: 4 * Math.sin(angle) }
  return { concentration: Math.max(0, 0.5 + gradient.x * (p.x - 0.5) + gradient.y * (p.y - 0.5)), gradient }
}
const passive = (e: Seam, field: (p: Vec2, t: number) => number, start: number, count: number) => {
  for (let k = 1; k <= count; k++) { e.time = start + k * 0.25; e.senseConcentration(field(anchor, e.time), 'passive') }
}
const scan = (e: Seam, field: (p: Vec2, t: number) => number, start: number, heading: number) => {
  const plume = { concentrationAt: field } as unknown as PlumeModel
  const event = createQuadSniffEvent({ command: { scanId: start, forward: { x: Math.cos(heading), y: Math.sin(heading) } },
    origin: anchor, time: start, strengthScale: 0.78, samplingMode: 'active-suction', passiveArrayRadius: 0.0125,
    cycleSeconds: 0.5, reachForDirection: () => 0.0975, plume, isBlocked: () => false })!
  integrateQuadSniffEvent(event, start + 0.25, plume); integrateQuadSniffEvent(event, start + 0.5, plume)
  e.time = start + 0.5
  return e.senseQuadConcentration(event, quadSniffStatusAt(event, e.time)).quadSniff!.readings!.map((r) => r.concentration)
}
export const m23Episode = (n: Nuisance, phase: number, rate: number, body: number, seed: number,
  calibration: ReturnType<typeof m21Calibrate>['calibration']) => {
  const e = sensor(n, seed); const field = (p: Vec2, t: number) => m23Field(phase, rate, p, t).concentration
  passive(e, field, 0, 32)
  const views: TimedView[] = [0, 1, 2, 3].map((slot) => {
    const start = 8 + slot; if (slot) passive(e, field, start - 0.5, 2)
    return { heading: body + slot * Math.PI / 2, time: start + 0.5, values: scan(e, field, start, body + slot * Math.PI / 2) }
  })
  const truth = m23Field(phase, rate, anchor, 11.5).gradient
  const decisions = M23_ARMS.map((arm) => {
    const d = recoveryDecision(views, calibration, arm, 11.5)
    const delta = d.direction ? Math.atan2(d.direction.y, d.direction.x) - Math.atan2(truth.y, truth.x) : null
    return { arm, ...d, angleError: delta === null ? null : Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))) * 180 / Math.PI }
  })
  return { nuisance: n.id, phase, rate, body, seed, truth, views, decisions }
}
const quantile = (values: number[], p: number) => {
  if (!values.length) return null
  const a = [...values].sort((x, y) => x - y); const index = (a.length - 1) * p; const lo = Math.floor(index); const hi = Math.ceil(index)
  return a[lo]! + (a[hi]! - a[lo]!) * (index - lo)
}
export const runM23 = () => {
  const calibrations = []; const episodes: ReturnType<typeof m23Episode>[] = []
  for (const [ni, n] of M21_NUISANCES.entries()) for (let rep = 0; rep < 2; rep++) {
    const calibration = m21Calibrate(n, 51000 + ni * 2 + rep); calibrations.push({ nuisance: n.id, rep, ...calibration })
    for (const [ri, rate] of M23_RATES.entries()) for (const [pi, phase] of M23_ANGLES.entries())
      for (const [bi, body] of M23_ANGLES.entries()) for (let trial = 0; trial < 5; trial++)
        episodes.push(m23Episode(n, phase, rate, body,
          300000 + ni * 100000 + rep * 50000 + ri * 5000 + pi * 500 + bi * 10 + trial, calibration.calibration))
  }
  const aggregates = M21_NUISANCES.flatMap((n) => M23_RATES.flatMap((rate) => M23_ARMS.map((arm) => {
    const ds = episodes.filter((e) => e.nuisance === n.id && e.rate === rate).flatMap((e) => e.decisions.filter((d) => d.arm === arm))
    const accepted = ds.filter((d) => d.direction); const errors = accepted.map((d) => d.angleError!)
    return { nuisance: n.id, rate, arm, episodes: ds.length, accepted: accepted.length,
      wrong: errors.filter((x) => x > 45).length, recovered: accepted.filter((d) => d.stage === 'recent-pair').length,
      meanError: errors.length ? errors.reduce((s, x) => s + x, 0) / errors.length : null,
      medianError: quantile(errors, 0.5), p90Error: quantile(errors, 0.9) }
  })))
  const staticCells = M21_NUISANCES.flatMap((n) => M23_ANGLES.flatMap((phase) => M23_ANGLES.map((body) => {
    const ds = episodes.filter((e) => e.nuisance === n.id && e.rate === 0 && e.phase === phase && e.body === body)
      .flatMap((e) => e.decisions.filter((d) => d.arm === 'calibrated-recovery'))
    return { nuisance: n.id, phase, body, episodes: ds.length, accepted: ds.filter((d) => d.direction).length,
      wrong: ds.filter((d) => d.angleError !== null && d.angleError > 45).length }
  })))
  const aggregateFailures = aggregates.filter((a) => a.arm === 'calibrated-recovery' &&
    (a.accepted < 320 || a.wrong > a.accepted * 0.05 || a.medianError === null || a.medianError > 30))
  const staticFailures = staticCells.filter((c) => c.accepted < 5 || c.wrong > c.accepted * 0.05)
  return { complete: true, design: M23_DESIGN, calibrations, episodes,
    summary: { aggregates, staticCells, aggregateFailures, staticFailures,
      advancesToExecutedActionTest: aggregateFailures.length === 0 && staticFailures.length === 0,
      movementExecuted: false, gslTrajectories: 0, appPromoted: false } }
}
