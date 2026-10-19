import { createQuadSniffEvent, integrateQuadSniffEvent, quadSniffEffectiveSampleCount, quadSniffStatusAt, type QuadSniffEvent } from '../../src/sim/quadSniff'
import { SeededRandom, hashNumbers } from '../../src/sim/rng'
import type { PlumeModel } from '../../src/sim/plume'
import type { Vec2 } from '../../src/sim/types'
import { M15_CALIBRATION as c, type ExactFieldValue } from './m15-manufactured-fields'
import { diagnoseFit, openCalibrationMap } from './m15-measurement-calibration'
import { evaluateMultiView, type LocalCentralSample, type LocalQuadSample } from './multiview-source-evidence'
import { m16Exact } from './m16-multiscale-study'
import { evaluateSpaceTime } from './m16-space-time-evidence'
import { evaluatePairedGuard } from './m17-prediction-guard'

export const M17_DESIGN = Object.freeze({ version: 'm17-paired-acquisition-v1', diagnosticOnly: true,
  widths: [0.024, 0.042], periods: [0, 5, 12], offsets: [0, 0.005, 0.015, 0.06],
  fields: ['gaussian', 'moving', 'breathing', 'wave', 'zero'], seeds: [17101, 17102, 17103, 17104],
  policies: ['wide-active', 'paired-active', 'fixed-passive'],
  firstSlot: 10, slotInterval: 3, slots: 9, slotDuration: 1, horizon: 40, dt: 0.25,
  expectedTrajectories: 870, expectedScores: 13050,
})
export type M17Job = { id: string; field: 'gaussian' | 'moving' | 'breathing' | 'wave' | 'zero';
  width: number; period: number; offset: number; anchor: Vec2;
  policy: 'wide-active' | 'paired-active' | 'fixed-passive'; noise: number; seed: number }
export const m17Jobs = (): M17Job[] => {
  const cases: Array<Pick<M17Job, 'field' | 'width' | 'period' | 'offset'>> = []
  for (const field of ['gaussian', 'moving', 'breathing'] as const) for (const width of M17_DESIGN.widths) {
    for (const period of M17_DESIGN.periods) {
      if (field !== 'gaussian' && period === 0) continue
      for (const offset of M17_DESIGN.offsets) cases.push({ field, width, period, offset })
    }
  }
  cases.push({ field: 'wave', width: 0, period: 0, offset: 0 }, { field: 'zero', width: 0, period: 0, offset: 0 })
  const jobs: M17Job[] = []
  for (const setting of cases) for (const policy of ['wide-active', 'paired-active', 'fixed-passive'] as const) {
    for (const noise of [{ noise: 0, seed: 17101 }, ...M17_DESIGN.seeds.map((seed) => ({ noise: 0.025, seed }))]) {
      jobs.push({ ...setting, policy, ...noise, anchor: { x: 0.5 + setting.offset, y: 0.5 },
        id: `${setting.field}-w${setting.width}-p${setting.period}-x${setting.offset}-${policy}-n${noise.noise}-s${noise.seed}` })
    }
  }
  return jobs
}
/** Analytic manufactured fields, evaluator/forward harness only. Moving and
 * breathing peaks are NONseparable in space and time, not physical point leaks. */
export const m17Exact = (job: Pick<M17Job, 'field' | 'width' | 'period'>, p: Vec2, time: number): ExactFieldValue => {
  if (job.field !== 'moving' && job.field !== 'breathing') return m16Exact({ ...job, field: job.field }, p, time)
  const omega = 2 * Math.PI / job.period; const phase = omega * time
  const moving = job.field === 'moving'
  const cx = 0.5 + (moving ? 0.01 * Math.sin(phase) : 0)
  const cy = 0.5 + (moving ? 0.006 * Math.cos(phase) : 0)
  const vx = moving ? 0.01 * omega * Math.cos(phase) : 0
  const vy = moving ? -0.006 * omega * Math.sin(phase) : 0
  const width = job.width * (moving ? 1 : 1 + 0.2 * Math.sin(phase))
  const widthRate = moving ? 0 : job.width * 0.2 * omega * Math.cos(phase)
  const x = p.x - cx; const y = p.y - cy; const r2 = x * x + y * y; const s2 = width ** 2
  const shape = 0.8 * Math.exp(-r2 / (2 * s2))
  const gradient = { x: -x / s2 * shape, y: -y / s2 * shape }
  const laplacian = (r2 / s2 ** 2 - 2 / s2) * shape
  const temporal = shape * ((x * vx + y * vy) / s2 + r2 * widthRate / width ** 3)
  return { concentration: 0.1 + shape, gradient, laplacian, temporal,
    residual: temporal + c.wind.x * gradient.x + c.wind.y * gradient.y - c.diffusivity * laplacian }
}
export const m17Schedule = (job: Pick<M17Job, 'policy'>) => Array.from({ length: 9 }, (_, slot) => {
  const start = 10 + 3 * slot
  const bearing = c.bearing + (job.policy !== 'fixed-passive' && slot % 2 ? Math.PI / 4 : 0)
  const common = { slot, bearing }
  return job.policy === 'paired-active' ? [
    { ...common, start, duration: 0.5, reach: slot % 2 ? 0.0325 : 0.065 },
    { ...common, start: start + 0.5, duration: 0.5, reach: slot % 2 ? 0.065 : 0.0325 },
  ] : [{ ...common, start, duration: 1, reach: job.policy === 'fixed-passive' ? 0.0125 : 0.065 }]
}).flat()

export const simulateM17 = (job: M17Job, witness?: { concentration: (p: Vec2, time: number) => number; sensorLag: number }) => {
  const value = witness?.concentration ?? ((p: Vec2, t: number) => m17Exact(job, p, t).concentration)
  const sensorLag = witness?.sensorLag ?? c.sensorLag
  const plume = { concentrationAt: value } as PlumeModel
  const rng = new SeededRandom(hashNumbers(job.seed, 9173))
  const central: LocalCentralSample[] = []; const scans: LocalQuadSample[] = []; const schedule = m17Schedule(job)
  let event: QuadSniffEvent | null = null; let next = 0; let centralState = 0
  const states = [0, 0, 0, 0]
  const alpha = sensorLag > 0 ? 1 - Math.exp(-0.25 / Math.max(0.05, sensorLag)) : 1
  const clamp = (v: number) => Math.min(c.saturation, Math.max(0, v))
  for (let tick = 0; tick < 160; tick++) {
    const time = tick * 0.25
    if (event) {
      integrateQuadSniffEvent(event, time, plume)
      if (time >= event.startedAt + event.cycleSeconds) {
        const count = quadSniffEffectiveSampleCount(event)
        const channelAlpha = sensorLag > 0 ? 1 - Math.exp(-event.cycleSeconds / Math.max(0.05, sensorLag)) : 1
        const readings = event.latentChannels.map((channel, i) => {
          const target = Math.max(0, channel.latentConcentration + rng.normal(0, job.noise / Math.sqrt(count)))
          states[i]! += (target - states[i]!) * channelAlpha
          const concentration = clamp(states[i]!)
          const { channel: id, direction, reach, support, effectiveOffset, integrationSamples } = channel
          return { channel: id, direction, reach, support, effectiveOffset, integrationSamples,
            effectiveIntegrationSamples: count, concentration, hit: concentration >= 0.1, saturated: concentration >= c.saturation - 1e-9 }
        })
        scans.push({ time, position: { ...job.anchor }, cycleSeconds: event.cycleSeconds, quad: { ...quadSniffStatusAt(event, time), readings } })
        event = null
      }
    } else {
      const truth = value(job.anchor, time)
      for (let i = 0; i < 4; i++) states[i]! += (Math.max(0, truth) - states[i]!) * alpha
      centralState += (Math.max(0, truth + rng.normal(0, job.noise)) - centralState) * alpha
      central.push({ time, position: { ...job.anchor }, concentration: clamp(centralState) })
    }
    rng.normal(0, 0); rng.normal(0, 0)
    const request = schedule[next]
    if (!event && request && time === request.start) {
      event = createQuadSniffEvent({ command: { scanId: next + 1, forward: { x: Math.cos(request.bearing), y: Math.sin(request.bearing) } },
        origin: job.anchor, time, strengthScale: c.strength, samplingMode: job.policy === 'fixed-passive' ? 'passive-array' : 'active-suction',
        cycleSeconds: request.duration, reachForDirection: () => request.reach, plume, isBlocked: openCalibrationMap })!
      next++
    }
  }
  if (next !== schedule.length || scans.length !== schedule.length || scans.some((s, i) => s.time !== schedule[i]!.start + schedule[i]!.duration ||
      s.cycleSeconds !== schedule[i]!.duration || s.quad.readings!.some((r) => r.reach !== schedule[i]!.reach))) throw new Error('M17 schedule failed')
  return { job, sensorLag, central, scans, budget: { horizon: 40, cycles: schedule.length, samplingSeconds: 9,
    activeSamplingSeconds: job.policy === 'fixed-passive' ? 0 : 9,
    idealTurningSeconds: job.policy === 'fixed-passive' ? 0 : 4, pathLength: 0,
    suctionEnergyProxy: job.policy === 'fixed-passive' ? 0 : 4 * c.strength ** 2 * 9,
    reachSwitches: schedule.slice(1).filter((r, i) => r.reach !== schedule[i]!.reach).length,
    reachSequence: schedule.map((r) => r.reach), cycleDurations: schedule.map((r) => r.duration) } }
}
export const m17Input = (observations: ReturnType<typeof simulateM17>, time: number) => ({
  anchor: observations.job.anchor, time, central: observations.central.filter((s) => s.time >= time - 6 && s.time <= time),
  scans: observations.scans.filter((s) => s.time >= time - 6 && s.time <= time), wind: c.wind,
  diffusivity: c.diffusivity, sensorNoise: observations.job.noise, sensorSaturation: c.saturation,
  integrationStepSeconds: 0.25, isBlocked: openCalibrationMap,
})
export const scoreM17 = (observations: ReturnType<typeof simulateM17>) => {
  const estimators = observations.job.policy === 'paired-active' ? ['m14', 'm16', 'guarded'] as const : ['m14'] as const
  return estimators.map((estimator) => {
    const records = Array.from({ length: 9 }, (_, slot) => {
      const time = 11 + 3 * slot; const input = m17Input(observations, time)
      const evidence = estimator === 'm14' ? evaluateMultiView(input) : estimator === 'm16' ? evaluateSpaceTime(input) : evaluatePairedGuard(input, time - 1)
      const fit = estimator === 'm14' ? diagnoseFit(input) : 'fit' in evidence ? evidence.fit : null
      return { time, evidence, fit, truth: m17Exact(observations.job, observations.job.anchor, time) }
    })
    const final = records.slice(-6)
    const valid = final.filter((r): r is typeof r & { fit: NonNullable<typeof r.fit> } => r.fit !== null)
    const mseSum = valid.reduce((s, r) => s + (r.fit.residual - r.truth.residual) ** 2, 0)
    const positive = final.filter((r) => r.evidence.positive).length
    return { estimator, records, summary: { finalRawFits: valid.length, finalUsable: final.filter((r) => r.evidence.usable).length,
      finalPositive: positive, casePositive: positive >= 4, residualRmse: valid.length === 6 ? Math.sqrt(mseSum / 6) : null,
      availableResidualSquaredError: mseSum, availableResidualCount: valid.length,
      selectedModels: Object.fromEntries(['m14', 'm16', 'abstain'].map((m) => [m, final.filter((r) =>
        'selectedModel' in r.evidence && (r.evidence.selectedModel ?? 'abstain') === m).length])),
      reasons: Object.fromEntries([...new Set(final.map((r) => r.evidence.reason))].map((reason) =>
        [reason, final.filter((r) => r.evidence.reason === reason).length])) } }
  })
}
