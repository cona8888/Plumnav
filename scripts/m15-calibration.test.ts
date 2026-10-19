import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { SimulationEngine } from '../src/sim/engine'
import type { PlumeModel } from '../src/sim/plume'
import type { SimulationConfig } from '../src/sim/types'
import { exactField, M15_CALIBRATION as c, M15_FIELDS, m15Jobs } from './lib/m15-manufactured-fields'
import { analyzeCalibration, simulateCalibration } from './lib/m15-measurement-calibration'

describe('M15 controlled measurement calibration', () => {
  it('checks all analytic derivatives independently by finite differences', () => {
    const h = 1e-5
    for (const field of M15_FIELDS) for (const x of [0.503, 0.515]) for (const t of [3.4, 25.75]) {
      const p = { x, y: 0.507 }; const f = (dx: number, dy: number, dt: number) => exactField(field, { x: x + dx, y: p.y + dy }, t + dt).concentration
      const truth = exactField(field, p, t)
      expect((f(h, 0, 0) - f(-h, 0, 0)) / (2 * h)).toBeCloseTo(truth.gradient.x, 5)
      expect((f(0, h, 0) - f(0, -h, 0)) / (2 * h)).toBeCloseTo(truth.gradient.y, 5)
      expect((f(0, 0, h) - f(0, 0, -h)) / (2 * h)).toBeCloseTo(truth.temporal, 7)
      expect((f(h, 0, 0) + f(-h, 0, 0) + f(0, h, 0) + f(0, -h, 0) - 4 * f(0, 0, 0)) / h ** 2).toBeCloseTo(truth.laplacian, 3)
      if (field === 'source-free-wave') expect(truth.residual).toBeCloseTo(0, 13)
    }
  })
  it('freezes the complete paired design without duplicate trajectory ids', () => {
    const jobs = m15Jobs()
    expect(jobs).toHaveLength(1440)
    expect(new Set(jobs.map((j) => j.id)).size).toBe(1440)
    expect(jobs.length * c.windows.length).toBe(2880)
    expect(jobs.filter((j) => j.noise === 0)).toHaveLength(288)
  })
  it('recovers representable noiseless quadratic derivatives at all reaches without changing the scorer', () => {
    for (const job of m15Jobs().filter((j) => j.field === 'quadratic-steady' && j.delivery === 'midpoint' && j.noise === 0)) {
      const raw = simulateCalibration(job); const before = JSON.stringify(raw)
      for (const result of analyzeCalibration(raw)) {
        for (const r of result.records.slice(-6)) {
          expect(r.fit).not.toBeNull()
          expect(r.fit!.laplacian).toBeCloseTo(-70, 5)
          expect(r.fit!.gradient.x).toBeCloseTo(0.4, 6)
          expect(r.fit!.gradient.y).toBeCloseTo(-0.3, 6)
          expect(r.fit!.temporal).toBeCloseTo(0, 7)
          expect(r.fit!.residual).toBeCloseTo(r.truth.residual, 7)
        }
      }
      expect(JSON.stringify(raw)).toBe(before)
      expect(raw.budget).toEqual({ horizon: 40, cycles: 12, samplingSeconds: 9, turningSeconds: job.policy === 'fixed' ? 0 : 5.5, pathLength: 0 })
    }
  })
  it('reproduces actual engine sensor observations for active/passive and zero/nonzero noise', async () => {
    const archive = JSON.parse(await readFile('research/evidence/m14_sniff_turn_bearing_corrected_2026-09-06/design.json', 'utf8'))
    for (const sensing of ['active-suction', 'passive-array'] as const) for (const noise of [0, 0.025]) {
      const job = m15Jobs().find((j) => j.field === 'gaussian-pulsing' && j.offset === 0.015 && j.sensing === sensing &&
        j.delivery === 'sensor' && j.policy === 'sniff-turn' && j.noise === noise && j.seed === 15101)!
      const base = archive.jobs.find((j: any) => j.world === 'open-downwind-0' && j.armId === (sensing === 'active-suction' ? 'geometry-active' : 'geometry-passive'))
      const config: SimulationConfig = { ...base.config, physicsMode: 'filament', seed: job.seed, sensorNoise: noise,
        windNoise: 0, robotStartPositionOverride: job.anchor, robotStartHeadingDegrees: c.bearing * 180 / Math.PI,
        sourcePositionOverride: c.center, activeSniffReach: job.reach }
      const engine = new SimulationEngine(config)
      const plume: PlumeModel = { scenario: engine.scenario, seed: job.seed,
        concentrationAt: (p, t) => exactField(job.field, p, t).concentration,
        windAt: () => c.wind, transportAt: () => c.wind, puffsAt: () => [],
        expectedHitRate: () => { throw new Error('Manufactured truth must not enter a controller likelihood') } }
      ;(engine as unknown as { plume: PlumeModel }).plume = plume
      const measured: Array<{ time: number; values: number[] }> = []; const central: Array<{ time: number; concentration: number }> = []
      let slot = 0
      engine.controller.step = (input) => {
        if (input.measurement.sampleMode === 'passive') central.push({ time: input.time, concentration: input.measurement.concentration })
        if (input.measurement.quadSniff?.readings) measured.push({ time: input.time, values: input.measurement.quadSniff.readings.map((r) => r.concentration) })
        const hold = { direction: { x: 0, y: 0 }, speedScale: 0, estimate: null, confidence: 0, phase: 'M15 FORWARD CONFORMANCE' }
        if (slot < 12 && input.time === 10 + slot * 2.5) {
          const bearing = c.bearing + (slot % 2 ? Math.PI / 4 : 0); slot++
          return { ...hold, quadSniff: { scanId: slot, forward: { x: Math.cos(bearing), y: Math.sin(bearing) } } }
        }
        return hold
      }
      engine.runToCompletion()
      const raw = simulateCalibration(job)
      expect(measured).toHaveLength(12)
      expect(central).toHaveLength(raw.central.length)
      for (const [i, r] of central.entries()) {
        expect(r.time).toBe(raw.central[i]!.time)
        expect(r.concentration).toBeCloseTo(raw.central[i]!.concentration, 12)
      }
      for (const [i, r] of measured.entries()) {
        expect(r.time).toBe(raw.scans[i]!.time)
        for (const [j, value] of r.values.entries()) expect(value).toBeCloseTo(raw.scans[i]!.quad.readings![j]!.concentration, 12)
      }
    }
  })
})
