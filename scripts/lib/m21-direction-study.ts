import { SimulationEngine } from '../../src/sim/engine'
import { createDefaultConfig } from '../../src/sim/config'
import { SeededRandom } from '../../src/sim/rng'
import { createQuadSniffEvent, integrateQuadSniffEvent, quadSniffStatusAt, type QuadSniffEvent } from '../../src/sim/quadSniff'
import type { Measurement, QuadSniffStatus, Vec2 } from '../../src/sim/types'
import type { PlumeModel } from '../../src/sim/plume'
import { directionDecision, fitDirectionCalibration, type DirectionRule } from './m21-direction'
type Nuisance = { id: string; gain: number; cross: number; rho: number; lag: number; lagMismatch: number; drift?: boolean }
const nominal = { gain: 0, cross: 0, rho: 0, lag: 0.05, lagMismatch: 0 }
export const M21_NUISANCES: Nuisance[] = [{ id: 'nominal', ...nominal }, { id: 'gain', ...nominal, gain: 0.2 },
  { id: 'cross-talk', ...nominal, cross: 0.35 }, { id: 'shared-noise', ...nominal, rho: 0.9 },
  { id: 'slow', ...nominal, lag: 2 }, { id: 'mixed', gain: 0.2, cross: 0.35, rho: 0.5, lag: 0.5, lagMismatch: 0.4 },
  { id: 'gain-drift', ...nominal, drift: true }]
export const M21_FIELDS = ['flat', 'linear', 'weak', 'peak', 'off-peak', 'pulsing', 'turning', 'low-signal'] as const
export type M21Field = typeof M21_FIELDS[number]
export const M21_RULES: DirectionRule[] = ['raw', 'calibrated', 'rotation-consistent']
export const M21_DESIGN = { calibrationReplicates: 5, episodesPerCalibration: 20, referenceSamplesPerLevel: 128,
  referenceLevels: [0.25, 0.75], calibrationDrawSeconds: 128, calibrationSettlingSeconds: 16,
  episodeDrawSeconds: 2, episodeTurnSeconds: 1.5, episodeWarmupSeconds: 8, pathLength: 0,
  expectedCalibrations: 35, expectedEpisodes: 5600, expectedDecisions: 16800, noise: 0.025,
  saturation: 1.5, reach: 0.0975, strength: 0.78, dt: 0.25, cycle: 0.5, finalTime: 11.5,
  directionOnly: true, calibrationSeedBase: 31000, testSeedBase: 100000 } as const
export const m21Field = (field: M21Field, p: Vec2, t: number) => {
  const x = p.x - 0.5; const y = p.y - 0.5
  if (field === 'flat') return { concentration: 0.5, gradient: { x: 0, y: 0 } }
  if (field === 'peak' || field === 'off-peak') {
    const dx = x - (field === 'peak' ? 0 : 0.04); const q = 0.5 * Math.exp(-(dx * dx + y * y) / (2 * 0.08 ** 2))
    return { concentration: 0.2 + q, gradient: { x: -dx * q / 0.08 ** 2, y: -y * q / 0.08 ** 2 } }
  }
  const angle = 0.61 + (field === 'turning' ? (t - 8) * Math.PI / 4 : 0)
  const magnitude = field === 'weak' || field === 'low-signal' ? 0.4 : 4
  const gradient = { x: magnitude * Math.cos(angle), y: magnitude * Math.sin(angle) }
  const baseline = field === 'low-signal' ? 0.03 : 0.5 + (field === 'pulsing' ? 0.15 * Math.sin(2 * Math.PI * t / 2) : 0)
  return { concentration: Math.max(0, baseline + gradient.x * x + gradient.y * y), gradient }
}
type Seam = { time: number; rng: SeededRandom; sensorState: number; quadSensorStates: Record<string, number>;
  senseConcentration: (c: number, mode: 'passive') => Measurement;
  senseQuadConcentration: (e: QuadSniffEvent, s: QuadSniffStatus) => Measurement }
const sensor = (n: Nuisance, seed: number, test: boolean) => {
  const e = new SimulationEngine({ ...createDefaultConfig('quad-sniff', 'open'), sensorNoise: 0.025, sensorSaturation: 1.5,
    sensorLag: n.lag, quadChannelGainMismatch: test && n.drift ? 0.2 : n.gain,
    quadChannelNoiseCorrelation: n.rho, quadChannelCrossTalk: n.cross, quadChannelLagMismatch: n.lagMismatch,
    fixedDt: 0.25, windNoise: 0, sensorFalsePositiveRate: 0, sensorFalseNegativeRate: 0, stopOnNativeDeclaration: false }) as unknown as Seam
  e.rng = new SeededRandom(seed); e.sensorState = 0; e.time = 0
  e.quadSensorStates = { front: 0, left: 0, aft: 0, right: 0 }
  return e
}
type Field = (p: Vec2, t: number) => number
const anchor = { x: 0.5, y: 0.5 }
const passive = (e: Seam, field: Field, start: number, count: number) => {
  for (let k = 1; k <= count; k++) { e.time = start + k * 0.25; e.senseConcentration(field(anchor, e.time), 'passive') }
}
const scan = (e: Seam, field: Field, start: number, heading: number) => {
  const plume = { concentrationAt: field } as unknown as PlumeModel
  const event = createQuadSniffEvent({ command: { scanId: 1, forward: { x: Math.cos(heading), y: Math.sin(heading) } },
    origin: anchor, time: start, strengthScale: 0.78, samplingMode: 'active-suction', passiveArrayRadius: 0.0125,
    cycleSeconds: 0.5, reachForDirection: () => 0.0975, plume, isBlocked: () => false })!
  integrateQuadSniffEvent(event, start + 0.25, plume); integrateQuadSniffEvent(event, start + 0.5, plume)
  e.time = start + 0.5
  return e.senseQuadConcentration(event, quadSniffStatusAt(event, e.time)).quadSniff!.readings!.map((r) => r.concentration)
}
export const m21Calibrate = (n: Nuisance, seed: number) => {
  const e = sensor(n, seed, false); let time = 0
  const references = [0.25, 0.75].map((level) => {
    const field = () => level; passive(e, field, time, 32); time += 8
    return Array.from({ length: 128 }, () => { const values = scan(e, field, time, 0); time += 0.5; return values })
  })
  return { seed, references, calibration: fitDirectionCalibration(references[0]!, references[1]!) }
}
export const m21Episode = (n: Nuisance, fieldId: M21Field, seed: number, calibration: ReturnType<typeof fitDirectionCalibration>) => {
  const e = sensor(n, seed, true); const field: Field = (p, t) => m21Field(fieldId, p, t).concentration
  passive(e, field, 0, 32)
  const views = [0, 1, 2, 3].map((slot) => {
    const start = 8 + slot; if (slot > 0) passive(e, field, start - 0.5, 2)
    const heading = slot * Math.PI / 2
    return { heading, values: scan(e, field, start, heading) }
  })
  const gradient = m21Field(fieldId, anchor, 11.5).gradient; const norm = Math.hypot(gradient.x, gradient.y)
  const decisions = M21_RULES.map((rule) => {
    const decision = directionDecision(views, calibration, rule)
    const angleError = decision.direction && norm > 1e-12 ? Math.acos(Math.max(-1, Math.min(1,
      (decision.direction.x * gradient.x + decision.direction.y * gradient.y) / norm))) * 180 / Math.PI : null
    return { rule, ...decision, angleError }
  })
  return { seed, field: fieldId, nuisance: n.id, views, gradient, nullDirection: norm <= 1e-12, decisions }
}
export const summarizeM21 = (episodes: ReturnType<typeof m21Episode>[]) => {
  const cells = M21_NUISANCES.flatMap((n) => M21_FIELDS.flatMap((field) => M21_RULES.map((rule) => {
    const rows = episodes.filter((e) => e.nuisance === n.id && e.field === field)
    const decisions = rows.map((e) => e.decisions.find((d) => d.rule === rule)!)
    const accepted = decisions.filter((d) => d.direction !== null)
    return { nuisance: n.id, field, rule, episodes: rows.length, accepted: accepted.length,
      wrong: accepted.filter((d) => d.angleError !== null && d.angleError > 45).length,
      nullDirection: field === 'flat' || field === 'peak',
      meanAcceptedAngleError: accepted.some((d) => d.angleError !== null) ? accepted.reduce((s, d) => s + (d.angleError ?? 0), 0) / accepted.length : null,
      reasons: Object.fromEntries([...new Set(decisions.map((d) => d.reason))].map((r) => [r, decisions.filter((d) => d.reason === r).length])) }
  })))
  const failures = cells.filter((c) => c.rule === 'rotation-consistent' &&
    ((c.nullDirection && c.accepted / c.episodes > 0.05) || (!c.nullDirection && c.accepted > 0 && c.wrong / c.accepted > 0.05) ||
      (['linear', 'off-peak'].includes(c.field) && c.accepted / c.episodes < 0.5)))
  return { cells, failures, advancesToFurtherComponentTest: failures.length === 0, appPromoted: false, gslTrajectories: 0 }
}
export const runM21 = () => {
  const calibrations = []; const episodes = []
  for (const [ni, n] of M21_NUISANCES.entries()) for (let rep = 0; rep < 5; rep++) {
    const id = `${n.id}-${rep}`; const calibration = m21Calibrate(n, 31000 + ni * 5 + rep)
    calibrations.push({ id, nuisance: n.id, ...calibration })
    for (const [fi, field] of M21_FIELDS.entries()) for (let k = 0; k < 20; k++)
      episodes.push({ calibrationId: id, ...m21Episode(n, field, 100000 + ni * 10000 + rep * 1000 + fi * 20 + k, calibration.calibration) })
  }
  return { complete: true, design: M21_DESIGN, calibrations, episodes, summary: summarizeM21(episodes) }
}
