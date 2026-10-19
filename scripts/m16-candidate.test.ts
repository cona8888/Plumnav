import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { SimulationEngine } from '../src/sim/engine'
import type { PlumeModel } from '../src/sim/plume'
import type { SimulationConfig, Vec2 } from '../src/sim/types'
import { M15_CALIBRATION as c } from './lib/m15-manufactured-fields'
import { m16Exact, m16Input, m16Jobs, m16Reach, simulateM16 } from './lib/m16-multiscale-study'
import { evaluateSpaceTime } from './lib/m16-space-time-evidence'

const polynomial = (p: Vec2, time: number) => {
  const x = p.x - 0.5; const y = p.y - 0.5; const t = time - 38.25; const r2 = x * x + y * y
  return 0.8 + 0.2 * x - 0.1 * y - 15 * x * x + 2 * x * y - 20 * y * y +
    0.008 * t + 0.03 * x * t - 0.02 * y * t + 0.0005 * t * t + 0.2 * r2 * t + 300 * r2 * r2
}
const base = () => m16Jobs().find((j) => j.policy === 'two-scale-active' && j.offset === 0 && j.noise === 0)!
it('fixes all 390 jobs and equal active acquisition budgets before comparison', () => {
  const jobs = m16Jobs()
  expect(jobs).toHaveLength(390)
  expect(new Set(jobs.map((j) => j.id)).size).toBe(390)
  const wide = simulateM16({ ...base(), policy: 'wide-active' }); const two = simulateM16(base())
  expect(wide.scans.map((s) => s.time)).toEqual(two.scans.map((s) => s.time))
  expect(two.budget.reachSequence.filter((r) => r === 0.065)).toHaveLength(6)
  expect(two.budget.reachSequence.filter((r) => r === 0.0325)).toHaveLength(6)
  expect(two.budget.turningSeconds).toBe(5.5)
  expect(wide.budget.turningSeconds).toBe(5.5)
})
it('checks new Gaussian width/period derivatives independently by finite differences', () => {
  const h = 1e-5; const p = { x: 0.511, y: 0.507 }
  for (const job of m16Jobs().filter((j) => j.field === 'gaussian' && j.offset === 0 && j.policy === 'wide-active' && j.noise === 0)) {
    for (const t of [4.3, 31.75]) {
      const f = (x: number, y: number, dt: number) => m16Exact(job, { x: p.x + x, y: p.y + y }, t + dt).concentration
      const truth = m16Exact(job, p, t)
      expect((f(h, 0, 0) - f(-h, 0, 0)) / (2 * h)).toBeCloseTo(truth.gradient.x, 5)
      expect((f(0, h, 0) - f(0, -h, 0)) / (2 * h)).toBeCloseTo(truth.gradient.y, 5)
      expect((f(0, 0, h) - f(0, 0, -h)) / (2 * h)).toBeCloseTo(truth.temporal, 7)
      expect((f(h, 0, 0) + f(-h, 0, 0) + f(0, h, 0) + f(0, -h, 0) - 4 * f(0, 0, 0)) / h ** 2).toBeCloseTo(truth.laplacian, 3)
    }
  }
})
it('recovers all required derivatives of a representable space/time polynomial through forward aspiration', () => {
  const raw = simulateM16(base(), { concentration: polynomial, sensorLag: 0 }); const before = JSON.stringify(raw)
  for (const scan of raw.scans.slice(-6)) {
    const e = evaluateSpaceTime(m16Input(raw, scan.time)); const t = scan.time - 38.25
    expect(e.fit, e.reason).not.toBeNull()
    expect(e.rank).toBe(12)
    expect(e.fit!.gradient.x).toBeCloseTo(0.2 + 0.03 * t, 5)
    expect(e.fit!.gradient.y).toBeCloseTo(-0.1 - 0.02 * t, 5)
    expect(e.fit!.laplacian).toBeCloseTo(-70 + 0.8 * t, 4)
    expect(e.fit!.temporal).toBeCloseTo(0.008 + 0.001 * t, 6)
  }
  expect(JSON.stringify(raw)).toBe(before)
})
it('fails closed when one footprint cannot separate radial fourth-order curvature from the Laplacian', () => {
  const raw = simulateM16({ ...base(), policy: 'wide-active' }, { concentration: polynomial, sensorLag: 0 })
  const e = evaluateSpaceTime(m16Input(raw, 38.25))
  expect(e.fit).toBeNull()
  expect(e.positive).toBe(false)
  expect(e.reason).toContain('unidentifiable')
})
it('propagates bounded channel perturbations into physical residual uncertainty and rejects invalid calibration', () => {
  const raw = simulateM16(base(), { concentration: polynomial, sensorLag: 0 })
  const input = m16Input(raw, 38.25); const baseline = evaluateSpaceTime(input)
  const sigma = 0.002
  const perturbed = { ...input, sensorNoise: sigma,
    central: input.central.map((s, i) => ({ ...s, concentration: s.concentration + (i % 2 ? 1 : -1) * sigma })),
    scans: input.scans.map((s) => ({ ...s, quad: { ...s.quad, readings: s.quad.readings!.map((r, i) => ({
      ...r, concentration: r.concentration + (i % 2 ? 1 : -1) * sigma / Math.sqrt(r.effectiveIntegrationSamples),
    })) } })) }
  const changed = evaluateSpaceTime(perturbed)
  expect(changed.fit).not.toBeNull()
  expect(Math.abs(changed.fit!.residual - baseline.fit!.residual)).toBeLessThanOrEqual(changed.nominalNoiseBound!)
  expect(evaluateSpaceTime({ ...input, sensorNoise: NaN }).usable).toBe(false)
  expect(evaluateSpaceTime({ ...input, scans: [] }).positive).toBe(false)
})
it('matches actual engine observations across variable-reach, wide and passive sensing with/without noise', async () => {
  const archive = JSON.parse(await readFile('research/evidence/m14_sniff_turn_bearing_corrected_2026-09-06/design.json', 'utf8'))
  for (const policy of ['wide-active', 'two-scale-active', 'fixed-passive'] as const) for (const noise of [0, 0.025]) {
    const job = m16Jobs().find((j) => j.policy === policy && j.noise === noise && j.seed === 16101 && j.period === 5 && j.width === 0.024 && j.offset === 0.015)!
    const previous = archive.jobs.find((j: any) => j.world === 'open-downwind-0' && j.armId === (policy === 'fixed-passive' ? 'geometry-passive' : 'geometry-active'))
    const config: SimulationConfig = { ...previous.config, physicsMode: 'filament', seed: job.seed, sensorNoise: noise,
      windNoise: 0, sourcePositionOverride: c.center, robotStartPositionOverride: job.anchor,
      robotStartHeadingDegrees: c.bearing * 180 / Math.PI }
    const engine = new SimulationEngine(config)
    const plume: PlumeModel = { scenario: engine.scenario, seed: job.seed, concentrationAt: (p, t) => m16Exact(job, p, t).concentration,
      windAt: () => c.wind, transportAt: () => c.wind, puffsAt: () => [], expectedHitRate: () => { throw new Error('Truth likelihood is not allowed') } }
    ;(engine as unknown as { plume: PlumeModel }).plume = plume
    const readings: Array<{ time: number; values: number[] }> = []; const central: Array<{ time: number; concentration: number }> = []
    let slot = 0
    engine.controller.step = (input) => {
      if (input.measurement.sampleMode === 'passive') central.push({ time: input.time, concentration: input.measurement.concentration })
      if (input.measurement.quadSniff?.readings) readings.push({ time: input.time, values: input.measurement.quadSniff.readings.map((r) => r.concentration) })
      const hold = { direction: { x: 0, y: 0 }, speedScale: 0, estimate: null, confidence: 0, phase: 'M16 FORWARD CONFORMANCE' }
      if (slot < 12 && input.time === 10 + slot * 2.5) {
        engine.config.activeSniffReach = m16Reach(job, slot)
        const bearing = c.bearing + (policy !== 'fixed-passive' && slot % 2 ? Math.PI / 4 : 0); slot++
        return { ...hold, quadSniff: { scanId: slot, forward: { x: Math.cos(bearing), y: Math.sin(bearing) } } }
      }
      return hold
    }
    engine.runToCompletion()
    const raw = simulateM16(job)
    expect(readings).toHaveLength(12); expect(central).toHaveLength(raw.central.length)
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
