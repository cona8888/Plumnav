import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { SimulationEngine } from '../src/sim/engine'
import type { PlumeModel } from '../src/sim/plume'
import type { SimulationConfig, Vec2 } from '../src/sim/types'
import { M15_CALIBRATION as c } from './lib/m15-manufactured-fields'
import { m17Exact, m17Input, m17Jobs, m17Schedule, simulateM17 } from './lib/m17-paired-study'
import { evaluatePairedGuard, predictExcludedPair } from './lib/m17-prediction-guard'
import { evaluateSpaceTime } from './lib/m16-space-time-evidence'

const polynomial = (p: Vec2, time: number) => {
  const x = p.x - 0.5; const y = p.y - 0.5; const t = time - 35; const r2 = x * x + y * y
  return 0.8 + 0.2 * x - 0.1 * y - 15 * x * x + 2 * x * y - 20 * y * y +
    0.008 * t + 0.03 * x * t - 0.02 * y * t + 0.0005 * t * t + 0.2 * r2 * t + 300 * r2 * r2
}
const base = () => m17Jobs().find((j) => j.policy === 'paired-active' && j.offset === 0 && j.noise === 0)!
it('fixes 870 unique jobs, common decisions and matched nine-second sensing budgets', () => {
  const jobs = m17Jobs(); expect(jobs).toHaveLength(870); expect(new Set(jobs.map((j) => j.id)).size).toBe(870)
  const paired = simulateM17(base()); const wide = simulateM17({ ...base(), policy: 'wide-active' })
  expect(paired.scans).toHaveLength(18); expect(wide.scans).toHaveLength(9)
  expect(paired.scans.filter((_, i) => i % 2).map((s) => s.time)).toEqual(wide.scans.map((s) => s.time))
  expect(paired.central.map((s) => s.time)).toEqual(wide.central.map((s) => s.time))
  expect(paired.budget.samplingSeconds).toBe(9); expect(wide.budget.samplingSeconds).toBe(9)
  expect(paired.budget.idealTurningSeconds).toBe(4); expect(wide.budget.idealTurningSeconds).toBe(4)
  expect(paired.budget.suctionEnergyProxy).toBe(wide.budget.suctionEnergyProxy)
  expect(paired.budget.reachSwitches).toBe(9)
  expect(paired.scans[0]!.quad.readings![0]!.effectiveIntegrationSamples).toBeCloseTo(8 / 3, 12)
  expect(wide.scans[0]!.quad.readings![0]!.effectiveIntegrationSamples).toBeCloseTo(32 / 7, 12)
})
it('checks nonseparable moving/breathing derivatives by independent finite differences', () => {
  const h = 1e-5; const p = { x: 0.511, y: 0.507 }
  for (const job of m17Jobs().filter((j) => ['moving', 'breathing'].includes(j.field) && j.offset === 0 && j.policy === 'wide-active' && j.noise === 0)) {
    for (const t of [4.3, 31.75]) {
      const f = (x: number, y: number, dt: number) => m17Exact(job, { x: p.x + x, y: p.y + y }, t + dt).concentration
      const truth = m17Exact(job, p, t)
      expect((f(h, 0, 0) - f(-h, 0, 0)) / (2 * h)).toBeCloseTo(truth.gradient.x, 5)
      expect((f(0, h, 0) - f(0, -h, 0)) / (2 * h)).toBeCloseTo(truth.gradient.y, 5)
      expect((f(0, 0, h) - f(0, 0, -h)) / (2 * h)).toBeCloseTo(truth.temporal, 7)
      expect((f(h, 0, 0) + f(-h, 0, 0) + f(0, h, 0) + f(0, -h, 0) - 4 * f(0, 0, 0)) / h ** 2).toBeCloseTo(truth.laplacian, 3)
    }
  }
})
it('recovers representable derivatives through paired forward aspiration and predicts unseen returns', () => {
  const raw = simulateM17(base(), { concentration: polynomial, sensorLag: 0 }); const before = JSON.stringify(raw)
  for (const time of [20, 23, 26, 29, 32, 35]) {
    const input = m17Input(raw, time); const e = evaluateSpaceTime(input); const t = time - 35
    expect(e.fit, e.reason).not.toBeNull()
    expect(e.fit!.laplacian).toBeCloseTo(-70 + 0.8 * t, 4)
    expect(e.fit!.temporal).toBeCloseTo(0.008 + 0.001 * t, 6)
    const p = predictExcludedPair(input, time - 1, 'm16')
    expect(p.passed, p.reason).toBe(true)
    expect(p.predictions).toHaveLength(8)
    expect(p.fit!.laplacian).toBeCloseTo(-70 + 0.8 * t, 4)
    expect(p.predictionRmse!).toBeLessThan(1e-7)
  }
  expect(JSON.stringify(raw)).toBe(before)
})
it('keeps current-pair values out of coefficients, forecasts AND the estimated residual', () => {
  const raw = simulateM17(base(), { concentration: polynomial, sensorLag: 0 })
  const input = m17Input(raw, 35); const before = predictExcludedPair(input, 34, 'm16')
  const corrupted = { ...input, scans: input.scans.map((s) => s.time <= 34 ? s : { ...s,
    quad: { ...s.quad, readings: s.quad.readings!.map((r) => ({ ...r, concentration: r.concentration + 0.1 })) } }) }
  const after = predictExcludedPair(corrupted, 34, 'm16')
  expect(after.coefficients).toEqual(before.coefficients)
  expect(after.fit).toEqual(before.fit)
  expect(after.predictions.map((p) => p.predicted)).toEqual(before.predictions.map((p) => p.predicted))
  expect(after.passed).toBe(false); expect(after.reason).toBe('excluded-pair prediction failed')
  expect(evaluatePairedGuard(corrupted, 34).usable).toBe(false)
  expect(before.trainingScans.every((t) => t <= 34)).toBe(true)
})
it('abstains on missing, clipped and invalid validation inputs', () => {
  const raw = simulateM17(base(), { concentration: polynomial, sensorLag: 0 }); const input = m17Input(raw, 35)
  expect(evaluatePairedGuard({ ...input, scans: input.scans.slice(0, -1) }, 34).usable).toBe(false)
  expect(evaluatePairedGuard({ ...input, sensorNoise: NaN }, 34).positive).toBe(false)
  expect(evaluatePairedGuard({ ...input, scans: input.scans.map((s) => s.time <= 34 ? s : { ...s,
    quad: { ...s.quad, readings: s.quad.readings!.map((r) => ({ ...r, saturated: true })) } }) }, 34).usable).toBe(false)
  expect(predictExcludedPair(input, 33, 'm16').passed).toBe(false)
})
it('can fall back to M14 using only independently validated measurements', () => {
  const raw = simulateM17(base(), { concentration: () => 0.8, sensorLag: 0 })
  const wide = simulateM17({ ...base(), policy: 'wide-active' }, { concentration: () => 0.8, sensorLag: 0 })
  const input = m17Input(raw, 35)
  // Retain only broad historical returns: M16 cannot separate quartic curvature,
  // while a constant field is exactly representable and predictable by M14.
  const limited = { ...input, scans: [...wide.scans.filter((s) => s.time >= 29 && s.time <= 34), ...input.scans.filter((s) => s.time > 34)] }
  const e = evaluatePairedGuard(limited, 34)
  expect(e.complex.passed).toBe(false)
  expect(e.simple.passed, e.simple.reason).toBe(true)
  expect(e.selectedModel).toBe('m14')
  expect(e.usable).toBe(true)
})
it('matches the actual engine for paired/wide/passive schedules, moving/breathing fields and both noise levels', async () => {
  const archive = JSON.parse(await readFile('research/evidence/m14_sniff_turn_bearing_corrected_2026-09-06/design.json', 'utf8'))
  for (const field of ['moving', 'breathing'] as const) for (const policy of ['wide-active', 'paired-active', 'fixed-passive'] as const) for (const noise of [0, 0.025]) {
    const job = m17Jobs().find((j) => j.field === field && j.policy === policy && j.noise === noise && j.seed === 17101 && j.period === 5 && j.width === 0.024 && j.offset === 0.015)!
    const previous = archive.jobs.find((j: any) => j.world === 'open-downwind-0' && j.armId === (policy === 'fixed-passive' ? 'geometry-passive' : 'geometry-active'))
    const schedule = m17Schedule(job)
    const config: SimulationConfig = { ...previous.config, physicsMode: 'filament', seed: job.seed, sensorNoise: noise,
      activeSniffCycleSeconds: schedule[0]!.duration, windNoise: 0, sourcePositionOverride: c.center,
      robotStartPositionOverride: job.anchor, robotStartHeadingDegrees: c.bearing * 180 / Math.PI }
    const engine = new SimulationEngine(config)
    const plume: PlumeModel = { scenario: engine.scenario, seed: job.seed, concentrationAt: (p, t) => m17Exact(job, p, t).concentration,
      windAt: () => c.wind, transportAt: () => c.wind, puffsAt: () => [], expectedHitRate: () => { throw new Error('Truth likelihood forbidden') } }
    ;(engine as unknown as { plume: PlumeModel }).plume = plume
    const readings: Array<{ time: number; values: number[] }> = []; const central: Array<{ time: number; concentration: number }> = []
    let next = 0
    engine.controller.step = (input) => {
      if (input.measurement.sampleMode === 'passive') central.push({ time: input.time, concentration: input.measurement.concentration })
      if (input.measurement.quadSniff?.readings) readings.push({ time: input.time, values: input.measurement.quadSniff.readings.map((r) => r.concentration) })
      const hold = { direction: { x: 0, y: 0 }, speedScale: 0, estimate: null, confidence: 0, phase: 'M17 FORWARD CONFORMANCE' }
      const request = schedule[next]
      if (request && input.time === request.start) {
        engine.config.activeSniffReach = request.reach; engine.config.activeSniffCycleSeconds = request.duration; next++
        return { ...hold, quadSniff: { scanId: next, forward: { x: Math.cos(request.bearing), y: Math.sin(request.bearing) } } }
      }
      return hold
    }
    engine.runToCompletion()
    const raw = simulateM17(job)
    expect(readings).toHaveLength(schedule.length); expect(central).toHaveLength(raw.central.length)
    for (const [i, r] of central.entries()) {
      expect(r.time).toBe(raw.central[i]!.time)
      expect(r.concentration).toBeCloseTo(raw.central[i]!.concentration, 12)
    }
    for (const [i, r] of readings.entries()) {
      expect(r.time).toBe(raw.scans[i]!.time)
      for (const [j, value] of r.values.entries()) expect(value).toBeCloseTo(raw.scans[i]!.quad.readings![j]!.concentration, 12)
    }
  }
})
