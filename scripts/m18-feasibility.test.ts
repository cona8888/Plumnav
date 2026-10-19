import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { createQuadSniffEvent, integrateQuadSniffEvent } from '../src/sim/quadSniff'
import type { PlumeModel } from '../src/sim/plume'
import type { Vec2 } from '../src/sim/types'
import { spaceTimeRows } from './lib/m16-space-time-evidence'
import { m17Input } from './lib/m17-paired-study'
import { M18_DESIGN, m18Plans, m18Schedule, m18Budget, m18Map, m18Rows, m18Inverse, m18Operators, screenM18Epoch } from './lib/m18-geometry-feasibility'

const base = () => m18Plans().find((p) => p.profile === 'pair-prior' && p.map === 'open' && p.model === 'm16' && p.reach === 0.065 && p.window === 6)!
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0)
it('fixes 144 plans and charges feasible timing, eighteen cycles and nine draw seconds', () => {
  const plans = m18Plans(); expect(plans).toHaveLength(144); expect(new Set(plans.map((p) => p.id)).size).toBe(144)
  for (const p of plans) {
    const schedule = m18Schedule(p); const budget = m18Budget(p)
    expect(schedule).toHaveLength(18); expect(budget.samplingSeconds).toBe(9); expect(budget.budgetValid).toBe(true)
    expect(budget.suctionEnergyProxy).toBe(4 * 0.78 ** 2 * 9)
    expect(budget.idealTurningSeconds).toBe((budget.blocks - 1) * 0.5)
    expect(schedule.every((s) => s.duration >= 0.5 && s.reach >= 0.005 && s.reach <= 0.15)).toBe(true)
  }
})
it('matches M17 matrices and both inherited forecast allowances without using their signals', async () => {
  const data = JSON.parse(await readFile('research/evidence/m17_paired_prediction_2026-09-06/gaussian-w0.024-p0-x0-paired-active-n0.025-s17101.json', 'utf8'))
  for (const model of ['m14', 'm16'] as const) for (const block of [6, 7, 8]) {
    const plan = { ...base(), model }; const rows = m18Rows(plan, block); const input = m17Input(data.observations, rows.time)
    const actual = spaceTimeRows({ ...input, central: input.central.filter((s) => s.time <= rows.cutoff), scans: input.scans.filter((s) => s.time <= rows.cutoff) })
    expect(rows.centralCount).toBe(actual.centralCount); expect(rows.training).toHaveLength(actual.rows.length)
    for (const [i, row] of rows.training.entries()) for (const [j, value] of row.x.entries()) expect(value).toBeCloseTo(actual.rows[i]!.x[j]!, 13)
    const archived = data.analyses.find((a: any) => a.estimator === 'guarded').records.find((r: any) => r.time === rows.time).evidence[model === 'm14' ? 'simple' : 'complex']
    expect(screenM18Epoch(plan, block).maxPredictionAllowance).toBeCloseTo(archived.maximumAllowance, 11)
  }
})
it('contains no outcome rows and excludes every validation timestamp from training', () => {
  for (const profile of ['pair-prior', 'pair-last', 'triplet-last', 'burst-last'] as const) {
    const plan = { ...base(), profile }; const block = m18Schedule(plan).at(-1)!.block
    const rows = m18Rows(plan, block)
    expect(rows.trainingTimes.every((t) => t <= rows.cutoff)).toBe(true)
    expect(rows.testTimes.every((t) => t > rows.cutoff)).toBe(true)
    expect(rows.testing).toHaveLength(profile === 'pair-prior' ? 8 : 4)
    for (const r of [...rows.training, ...rows.testing]) expect(Object.keys(r).sort()).toEqual(['sigma', 'x'])
    expect(JSON.stringify(rows)).not.toMatch(/concentration|source|truth|fitRms|residualError/)
  }
  expect(() => m18Rows(base(), 8, NaN)).toThrow('Invalid marginal noise')
  expect(() => m18Rows(base(), 8, -0.1)).toThrow('Invalid marginal noise')
  expect(() => m18Rows(base(), 99)).toThrow('Missing acquisition block')
})
it('checks every profile observation row against independent forward polynomial integration', () => {
  const h = 0.065; const tau = 6; const anchor = { x: 0.5, y: 0.5 }
  const coefficients = [0.8, 0.2 * h, -0.1 * h, -30 * h ** 2, 2 * h ** 2, -40 * h ** 2,
    0.008 * tau, 0.03 * h * tau, -0.02 * h * tau, 0.001 * tau ** 2, 0.4 * h ** 2 * tau, 7200 * h ** 4]
  for (const profile of ['pair-prior', 'pair-last', 'triplet-last', 'burst-last'] as const) for (const map of ['open', 'wall', 'corridor'] as const) {
    const plan = { ...base(), profile, map }; const schedule = m18Schedule(plan); const block = schedule.at(-1)!.block
    const rows = m18Rows(plan, block); const isBlocked = m18Map(map)
    const concentration = (p: Vec2, time: number) => {
      const x = p.x - 0.5; const y = p.y - 0.5; const t = time - rows.time; const r2 = x * x + y * y
      return 0.8 + 0.2 * x - 0.1 * y - 15 * x * x + 2 * x * y - 20 * y * y +
        0.008 * t + 0.03 * x * t - 0.02 * y * t + 0.0005 * t * t + 0.2 * r2 * t + 300 * r2 * r2
    }
    const plume = { concentrationAt: concentration } as PlumeModel
    const trainValues = rows.trainingTimes.slice(0, rows.centralCount).map((t) => concentration(anchor, t)); const testValues: number[] = []
    for (const [i, s] of schedule.entries()) {
      const end = s.start + 0.5
      if (end < rows.time - plan.window || end > rows.time) continue
      const event = createQuadSniffEvent({ command: { scanId: i, forward: { x: Math.cos(s.bearing), y: Math.sin(s.bearing) } },
        origin: anchor, time: s.start, strengthScale: 0.78, samplingMode: 'active-suction', cycleSeconds: 0.5,
        reachForDirection: () => s.reach, isBlocked, plume })!
      integrateQuadSniffEvent(event, s.start + 0.25, plume); integrateQuadSniffEvent(event, end, plume)
      const values = event.latentChannels.filter((r) => r.support >= 0.25).map((r) => r.latentConcentration)
      ;(end <= rows.cutoff ? trainValues : testValues).push(...values)
    }
    expect(trainValues).toHaveLength(rows.training.length); expect(testValues).toHaveLength(rows.testing.length)
    for (const [i, r] of rows.training.entries()) expect(dot(r.x, coefficients)).toBeCloseTo(trainValues[i]!, 12)
    for (const [i, r] of rows.testing.entries()) expect(dot(r.x, coefficients)).toBeCloseTo(testValues[i]!, 12)
  }
})
it('verifies operator reconstruction and tight bounded-noise propagation', () => {
  const plan = base(); const rows = m18Rows(plan, 8); const d = m18Inverse(rows.training.map((r) => r.x), plan.model)
  const ops = m18Operators(plan.model); const screen = screenM18Epoch(plan, 8)
  for (const op of [...ops.required, ops.nominalResidual, ...ops.corners]) {
    expect(d.estimable(op)).toBe(true)
    const w = d.weights(op)
    for (const [j, value] of op.entries()) expect(w.reduce((s, v, i) => s + v * rows.training[i]!.x[j]!, 0)).toBeCloseTo(value, 5)
  }
  const weights = d.weights(ops.nominalResidual)
  const perturbation = weights.map((w, i) => 3 * Math.sign(w) * rows.training[i]!.sigma)
  expect(dot(weights, perturbation)).toBeCloseTo(screen.nominalResidualAllowance!, 12)
  const doubled = screenM18Epoch(plan, 8, M18_DESIGN.noise * 2)
  expect(doubled.maxResidualAllowance).toBeCloseTo(2 * screen.maxResidualAllowance!, 12)
  expect(doubled.maxPredictionAllowance! - 1e-4).toBeCloseTo(2 * (screen.maxPredictionAllowance! - 1e-4), 12)
})
it('fails closed on clipped validation channels and preserves unavailable operators', () => {
  const plan = { ...base(), map: 'corridor' as const, reach: 0.0975 }
  const e = screenM18Epoch(plan, 8)
  expect(e.testRows).toBeLessThan(e.expectedTestChannels)
  expect(e.gates.testIdentifiable).toBe(false); expect(e.maxPredictionAllowance).toBeNull(); expect(e.feasible).toBe(false)
})
