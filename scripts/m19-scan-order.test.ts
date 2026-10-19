import { expect, it } from 'vitest'
import { createQuadSniffEvent, integrateQuadSniffEvent } from '../src/sim/quadSniff'
import type { PlumeModel } from '../src/sim/plume'
import type { Vec2 } from '../src/sim/types'
import { M18_DESIGN, m18Map, m18Plans, m18Rows, m18Schedule, screenM18Epoch } from './lib/m18-geometry-feasibility'
import { M19_DESIGN, M19_ORDERS, m19Settings, m19Contexts, m19Events, m19Rows, scoreM19Rows, chooseM19Order,
  selectM19Order, rolloutM19 } from './lib/m19-scan-order'

const base = () => m19Settings().find((s) => s.model === 'm14' && s.map === 'open' && s.reach === 0.0975)!
it('fixes balanced independent history/bearing contexts and unchanged calibration', () => {
  expect(m19Settings()).toHaveLength(18); expect(m19Contexts()).toHaveLength(34)
  expect(new Set(m19Settings().map((s) => s.id)).size).toBe(18)
  expect(new Set(m19Contexts().map((c) => c.id)).size).toBe(34)
  for (const order of M19_ORDERS) expect(m19Contexts().filter((c) => c.previousOrder === order)).toHaveLength(4)
  expect(m19Settings().length * m19Contexts().length * M19_ORDERS.length).toBe(4896)
  expect(M19_DESIGN.noise).toBe(M18_DESIGN.noise)
  expect(M19_DESIGN.predictionCap).toBe(M18_DESIGN.predictionCap)
  expect(M19_DESIGN.residualCap).toBe(M18_DESIGN.residualConcentrationBudget)
})
it('reproduces M18 triplet matrices, allowances and the corrected reach-order labels', () => {
  for (const model of ['m14', 'm16'] as const) {
    const setting = { ...base(), model }
    const plan = m18Plans().find((p) => p.profile === 'triplet-last' && p.window === 6 && p.reach === setting.reach && p.map === 'open' && p.model === model)!
    const schedule = m18Schedule(plan).map((e) => ({ ...e, duration: 0.5 as const }))
    for (const block of [3, 4, 5]) {
      const actualOrder = schedule.filter((s) => s.block === block).map((s) => s.reach === setting.reach ? 'B' : 'L').join('')
      expect(actualOrder).toBe(block % 2 ? 'LBL' : 'BLB')
      const before = m18Rows(plan, block); const after = m19Rows(setting, schedule, block)
      expect(after.training).toEqual(before.training); expect(after.testing).toEqual(before.testing)
      const a = screenM18Epoch(plan, block); const b = scoreM19Rows(setting, after)
      expect(b.maxPredictionAllowance).toBe(a.maxPredictionAllowance)
      expect(b.maxResidualAllowance).toBe(a.maxResidualAllowance)
      expect(b.gates).toEqual(a.gates)
    }
  }
})
it('has deterministic, finite, gate-preserving order selection and explicit abstention', () => {
  const rows = [
    { order: 'BLB' as const, switches: 2, feasible: true, score: 0.8 },
    { order: 'BBL' as const, switches: 1, feasible: true, score: 0.8 + 0.5e-10 },
    { order: 'LBB' as const, switches: 1, feasible: true, score: 0.8 + 0.5e-10 },
    { order: 'BBB' as const, switches: 0, feasible: false, score: 0.1 },
  ]
  expect(chooseM19Order(rows)).toBe('BBL'); expect(chooseM19Order([...rows].reverse())).toBe('BBL')
  expect(chooseM19Order([{ order: 'BBB', switches: 0, feasible: true, score: 1.01 }])).toBeNull()
  expect(chooseM19Order([{ order: 'BBB', switches: 0, feasible: true, score: NaN }])).toBeNull()
  expect(chooseM19Order([])).toBeNull()
})
it('keeps validation values out of selection and rejects future acquisition history', () => {
  const setting = base(); const history = m19Events('LBL', 30, 0, setting.reach, 0); const before = JSON.stringify(history)
  const decision = selectM19Order(setting, history, 35, 1, 1)
  expect(JSON.stringify(history)).toBe(before); expect(decision.candidates).toHaveLength(8)
  expect(JSON.stringify(decision)).not.toMatch(/concentration|sourcePosition|truth|fitRms|residualError/)
  const rows = m19Rows(setting, [...history, ...m19Events('BLB', 35, 1, setting.reach, 1)], 1)
  expect(rows.trainingTimes.every((t) => t <= 36)).toBe(true); expect(rows.testTimes).toEqual([36.5])
  for (const r of [...rows.training, ...rows.testing]) expect(Object.keys(r).sort()).toEqual(['sigma', 'x'])
  expect(() => selectM19Order(setting, history, 31, 0, 1)).toThrow('Future acquisition')
  expect(() => m19Events('BLB', NaN, 0, setting.reach, 0)).toThrow('Invalid scan recipe')
})
it('matches all current-order observation rows against independent forward integration in three maps', () => {
  const h = 0.065; const tau = 6; const anchor = { x: 0.5, y: 0.5 }
  const coefficients = [0.8, 0.2 * h, -0.1 * h, -30 * h ** 2, 2 * h ** 2, -40 * h ** 2,
    0.008 * tau, 0.03 * h * tau, -0.02 * h * tau, 0.001 * tau ** 2, 0.4 * h ** 2 * tau, 7200 * h ** 4]
  for (const map of ['open', 'wall', 'corridor'] as const) for (const order of M19_ORDERS) {
    const setting = { ...base(), map, model: 'm16' as const }
    const events = [...m19Events('BLL', 30, 0, setting.reach, 0), ...m19Events(order, 35, 1, setting.reach, 1)]
    const rows = m19Rows(setting, events, 1); const isBlocked = m18Map(map)
    const concentration = (p: Vec2, time: number) => {
      const x = p.x - 0.5; const y = p.y - 0.5; const t = time - rows.time; const r2 = x * x + y * y
      return 0.8 + 0.2 * x - 0.1 * y - 15 * x * x + 2 * x * y - 20 * y * y +
        0.008 * t + 0.03 * x * t - 0.02 * y * t + 0.0005 * t * t + 0.2 * r2 * t + 300 * r2 * r2
    }
    const plume = { concentrationAt: concentration } as PlumeModel
    const trainValues = rows.trainingTimes.slice(0, rows.centralCount).map((t) => concentration(anchor, t)); const testValues: number[] = []
    for (const [i, s] of events.entries()) {
      const event = createQuadSniffEvent({ command: { scanId: i, forward: { x: Math.cos(s.bearing), y: Math.sin(s.bearing) } },
        origin: anchor, time: s.start, strengthScale: 0.78, samplingMode: 'active-suction', cycleSeconds: 0.5,
        reachForDirection: () => s.reach, isBlocked, plume })!
      integrateQuadSniffEvent(event, s.start + 0.25, plume); integrateQuadSniffEvent(event, s.start + 0.5, plume)
      ;(s.start + 0.5 <= rows.cutoff ? trainValues : testValues).push(...event.latentChannels.filter((r) => r.support >= 0.25).map((r) => r.latentConcentration))
    }
    expect(rows.training).toHaveLength(trainValues.length); expect(rows.testing).toHaveLength(testValues.length)
    for (const [i, r] of rows.training.entries()) expect(r.x.reduce((s, v, j) => s + v * coefficients[j]!, 0)).toBeCloseTo(trainValues[i]!, 12)
    for (const [i, r] of rows.testing.entries()) expect(r.x.reduce((s, v, j) => s + v * coefficients[j]!, 0)).toBeCloseTo(testValues[i]!, 12)
  }
})
it('charges fixed warm-up, complete sensing and exploration fallbacks in a causal rollout', () => {
  for (const map of ['open', 'corridor'] as const) {
    const rollout = rolloutM19({ ...base(), map }, 1)
    expect(rollout.steps).toHaveLength(6); expect(rollout.events).toHaveLength(18)
    expect(rollout.steps.slice(0, 2).map((s) => s.acquisitionOrder)).toEqual(['BLB', 'LBL'])
    expect(rollout.steps.slice(0, 2).every((s) => s.decision === null)).toBe(true)
    expect(rollout.budget.samplingSeconds).toBe(rollout.events.reduce((s, e) => s + e.duration, 0))
    expect(rollout.budget.samplingSeconds).toBe(9); expect(rollout.budget.bootstrapSamplingSeconds).toBe(3)
    expect(rollout.budget.idealTurningSeconds).toBe(2.5); expect(rollout.budget.finalReturn).toBe(36.5)
    for (const step of rollout.steps.slice(2)) {
      expect(step.decision!.candidates).toHaveLength(8)
      const selected = step.decision!.selectedOrder
      if (selected === null) expect(step.acquisitionOrder).toBe(step.block % 2 ? 'LBL' : 'BLB')
      else expect(step.decision!.candidates.find((c) => c.order === selected)!.feasible).toBe(true)
    }
  }
})
