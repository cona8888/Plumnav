import { createQuadSniffEvent, integrateQuadSniffEvent, quadSniffEffectiveSampleCount, quadSniffStatusAt, type QuadSniffEvent } from '../../src/sim/quadSniff'
import { SeededRandom, hashNumbers } from '../../src/sim/rng'
import type { PlumeModel } from '../../src/sim/plume'
import type { Vec2 } from '../../src/sim/types'
import { exactField, M15_CALIBRATION as c, type ExactFieldValue } from './m15-manufactured-fields'
import { diagnoseFit, openCalibrationMap } from './m15-measurement-calibration'
import { evaluateMultiView, type LocalCentralSample, type LocalQuadSample } from './multiview-source-evidence'
import { evaluateSpaceTime } from './m16-space-time-evidence'

export const M16_DESIGN = Object.freeze({ version: 'm16-parameter-transfer-v1', diagnosticOnly: true,
  widths: [0.024, 0.042], periods: [0, 5, 12], offsets: [0, 0.005, 0.015, 0.06],
  seeds: [16101, 16102, 16103, 16104], expectedTrajectories: 390, expectedScores: 7800,
  policies: ['wide-active', 'two-scale-active', 'fixed-passive'],
  reachSequence: [0.065, 0.065, 0.0325, 0.0325],
})
export type M16Job = { id: string; field: 'gaussian' | 'wave' | 'zero'; width: number; period: number;
  offset: number; anchor: Vec2; policy: 'wide-active' | 'two-scale-active' | 'fixed-passive'; noise: number; seed: number }
export const m16Jobs = (): M16Job[] => {
  const cases: Array<Pick<M16Job, 'field' | 'width' | 'period' | 'offset'>> = []
  for (const width of M16_DESIGN.widths) for (const period of M16_DESIGN.periods) for (const offset of M16_DESIGN.offsets) cases.push({ field: 'gaussian', width, period, offset })
  cases.push({ field: 'wave', width: 0, period: 0, offset: 0 }, { field: 'zero', width: 0, period: 0, offset: 0 })
  const jobs: M16Job[] = []
  for (const setting of cases) for (const policy of ['wide-active', 'two-scale-active', 'fixed-passive'] as const) {
    for (const noise of [{ noise: 0, seed: 16101 }, ...M16_DESIGN.seeds.map((seed) => ({ noise: 0.025, seed }))]) {
      jobs.push({ ...setting, policy, ...noise, anchor: { x: 0.5 + setting.offset, y: 0.5 },
        id: `${setting.field}-w${setting.width}-p${setting.period}-x${setting.offset}-${policy}-n${noise.noise}-s${noise.seed}` })
    }
  }
  return jobs
}
/** Manufactured truth is used only by the forward/evaluation harness. */
export const m16Exact = (job: Pick<M16Job, 'field' | 'width' | 'period'>, p: Vec2, time: number): ExactFieldValue => {
  if (job.field !== 'gaussian') return exactField(job.field === 'wave' ? 'source-free-wave' : 'zero', p, time)
  const x = p.x - 0.5; const y = p.y - 0.5; const s2 = job.width ** 2; const r2 = x * x + y * y
  const omega = job.period ? 2 * Math.PI / job.period : 0
  const a = 1 + 0.25 * Math.sin(omega * time); const at = 0.25 * omega * Math.cos(omega * time)
  const shape = 0.8 * Math.exp(-r2 / (2 * s2))
  const gradient = { x: -x / s2 * shape * a, y: -y / s2 * shape * a }
  const laplacian = (r2 / s2 ** 2 - 2 / s2) * shape * a; const temporal = at * shape
  return { concentration: 0.1 + a * shape, gradient, laplacian, temporal,
    residual: temporal + c.wind.x * gradient.x + c.wind.y * gradient.y - c.diffusivity * laplacian }
}
export const m16Reach = (job: M16Job, slot: number) => job.policy === 'fixed-passive' ? 0.0125 :
  job.policy === 'wide-active' ? 0.065 : M16_DESIGN.reachSequence[slot % 4]!
export const simulateM16 = (job: M16Job, witness?: { concentration: (p: Vec2, time: number) => number; sensorLag: number }) => {
  const value = witness?.concentration ?? ((p: Vec2, t: number) => m16Exact(job, p, t).concentration)
  const sensorLag = witness?.sensorLag ?? c.sensorLag
  const plume = { concentrationAt: value } as PlumeModel
  const rng = new SeededRandom(hashNumbers(job.seed, 9173))
  const central: LocalCentralSample[] = []; const scans: LocalQuadSample[] = []
  let event: QuadSniffEvent | null = null; let slot = 0; let centralState = 0
  const states = [0, 0, 0, 0]
  const alpha = sensorLag > 0 ? 1 - Math.exp(-c.dt / Math.max(0.05, sensorLag)) : 1
  const channelAlpha = sensorLag > 0 ? 1 - Math.exp(-c.cycleSeconds / Math.max(0.05, sensorLag)) : 1
  const clamp = (v: number) => Math.min(c.saturation, Math.max(0, v))
  for (let tick = 0; tick < 160; tick++) {
    const time = tick * c.dt
    if (event) {
      integrateQuadSniffEvent(event, time, plume)
      if (time >= event.startedAt + c.cycleSeconds) {
        const count = quadSniffEffectiveSampleCount(event)
        const readings = event.latentChannels.map((channel, i) => {
          const target = Math.max(0, channel.latentConcentration + rng.normal(0, job.noise / Math.sqrt(count)))
          states[i]! += (target - states[i]!) * channelAlpha
          const concentration = clamp(states[i]!)
          const { channel: id, direction, reach, support, effectiveOffset, integrationSamples } = channel
          return { channel: id, direction, reach, support, effectiveOffset, integrationSamples,
            effectiveIntegrationSamples: count, concentration, hit: concentration >= 0.1, saturated: concentration >= c.saturation - 1e-9 }
        })
        scans.push({ time, position: { ...job.anchor }, cycleSeconds: c.cycleSeconds, quad: { ...quadSniffStatusAt(event, time), readings } })
        event = null
      }
    } else {
      const truth = value(job.anchor, time)
      for (let i = 0; i < 4; i++) states[i]! += (Math.max(0, truth) - states[i]!) * alpha
      centralState += (Math.max(0, truth + rng.normal(0, job.noise)) - centralState) * alpha
      central.push({ time, position: { ...job.anchor }, concentration: clamp(centralState) })
    }
    rng.normal(0, 0); rng.normal(0, 0)
    if (!event && slot < 12 && time === 10 + slot * 2.5) {
      const bearing = c.bearing + (job.policy !== 'fixed-passive' && slot % 2 ? Math.PI / 4 : 0)
      event = createQuadSniffEvent({ command: { scanId: slot + 1, forward: { x: Math.cos(bearing), y: Math.sin(bearing) } },
        origin: job.anchor, time, strengthScale: c.strength, samplingMode: job.policy === 'fixed-passive' ? 'passive-array' : 'active-suction',
        cycleSeconds: c.cycleSeconds, reachForDirection: () => m16Reach(job, slot), plume, isBlocked: openCalibrationMap })!
      slot++
    }
  }
  if (slot !== 12 || scans.length !== 12 || scans.some((s, i) => s.time !== 10.75 + i * 2.5 || s.quad.readings!.some((r) => r.reach !== m16Reach(job, i)))) throw new Error('M16 acquisition schedule failed')
  return { job, sensorLag, central, scans, budget: { horizon: 40, cycles: 12, samplingSeconds: 9,
    turningSeconds: job.policy === 'fixed-passive' ? 0 : 5.5, pathLength: 0,
    reachSequence: scans.map((s) => s.quad.readings![0]!.reach) } }
}
export const m16Input = (observations: ReturnType<typeof simulateM16>, time: number) => ({
  anchor: observations.job.anchor, time, central: observations.central.filter((s) => s.time >= time - 6 && s.time <= time),
  scans: observations.scans.filter((s) => s.time >= time - 6 && s.time <= time), wind: c.wind,
  diffusivity: c.diffusivity, sensorNoise: observations.job.noise, sensorSaturation: c.saturation,
  integrationStepSeconds: c.dt, isBlocked: openCalibrationMap,
})
export const scoreM16 = (observations: ReturnType<typeof simulateM16>) => {
  const estimators = observations.job.policy === 'fixed-passive' ? ['m14'] as const : ['m14', 'm16'] as const
  return estimators.map((estimator) => {
    const records = observations.scans.map((scan) => {
      const input = m16Input(observations, scan.time)
      const evidence = estimator === 'm14' ? evaluateMultiView(input) : evaluateSpaceTime(input)
      const fit = estimator === 'm14' ? diagnoseFit(input) : (evidence as ReturnType<typeof evaluateSpaceTime>).fit
      return { time: scan.time, evidence, fit, truth: m16Exact(observations.job, observations.job.anchor, scan.time) }
    })
    const final = records.slice(-6)
    const valid = final.filter((r): r is typeof r & { fit: NonNullable<typeof r.fit> } => r.fit !== null)
    const rmse = (key: 'residual' | 'temporal' | 'laplacian') => valid.length === 6
      ? Math.sqrt(valid.reduce((s, r) => s + (r.fit[key] - r.truth[key]) ** 2, 0) / 6) : null
    const positive = final.filter((r) => r.evidence.positive).length
    return { estimator, records, summary: { finalRawFits: valid.length, finalUsable: final.filter((r) => r.evidence.usable).length,
      finalPositive: positive, casePositive: positive >= 4, residualRmse: rmse('residual'), temporalRmse: rmse('temporal'),
      laplacianRmse: rmse('laplacian'), reasons: Object.fromEntries([...new Set(final.map((r) => r.evidence.reason))].map((reason) =>
        [reason, final.filter((r) => r.evidence.reason === reason).length])) } }
  })
}
