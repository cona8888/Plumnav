import { describe, expect, it } from 'vitest'
import { evaluateMultiView, geometrySample, quadMomentRows, selectSniffTurnPlan } from './lib/multiview-source-evidence'
import type { Vec2 } from '../src/sim/types'

const anchor = { x: 0.5, y: 0.5 }
const fixture = (bearings: number[], isBlocked = (_p: Vec2, _c?: number) => false,
  coefficients = [0.8, 0.01, -0.02, -0.2, 0.03, -0.16, 0]) => {
  const referenceTime = 10.75
  const value = (p: Vec2, t: number) => {
    const x = (p.x - anchor.x) / 0.065; const y = (p.y - anchor.y) / 0.065
    return [1, x, y, x * x / 2, x * y, y * y / 2, (t - referenceTime) / 6]
      .reduce((s, v, i) => s + v * coefficients[i]!, 0)
  }
  const scans = bearings.map((bearing, i) => {
    const sample = geometrySample(anchor, bearing, 'active-suction', 0.065, 0.78, isBlocked, 8.25 + i * 2.5)
    const rows = quadMomentRows(sample, anchor, referenceTime, isBlocked)
    let usableIndex = 0
    sample.quad.readings = sample.quad.readings!.map((r) => {
      if (r.support < 0.25) return r
      const row = rows[usableIndex++]!
      return { ...r, concentration: row.x.reduce((s, v, j) => s + v * coefficients[j]!, 0) }
    })
    return sample
  })
  const central = Array.from({ length: 23 }, (_, i) => ({ time: 5 + i * 0.25, position: anchor,
    concentration: value(anchor, 5 + i * 0.25) }))
  return { anchor, time: referenceTime, central, scans, wind: { x: 0.05, y: 0 }, diffusivity: 0.001,
    sensorNoise: 0, sensorSaturation: 1.5, isBlocked }
}
describe('M14 multi-view source reconstruction', () => {
  it('recovers a general quadratic including mixed curvature from two orientations', () => {
    const result = evaluateMultiView(fixture([0, Math.PI / 4]))
    expect(result.rank).toBe(7)
    expect(result.usable).toBe(true)
    expect(result.gradient!.x).toBeCloseTo(0.01 / 0.065, 6)
    expect(result.laplacian).toBeCloseTo(-0.36 / 0.065 ** 2, 5)
    expect(result.positive).toBe(true)
  })
  it('does not unfairly reject fixed cardinal views when only irrelevant mixed curvature is missing', () => {
    const result = evaluateMultiView(fixture([0, 0]))
    expect(result.rank).toBe(6)
    expect(result.operatorIdentifiable).toBe(true)
    expect(result.usable).toBe(true)
    expect(result.laplacian).toBeCloseTo(-0.36 / 0.065 ** 2, 5)
    const rotated = evaluateMultiView(fixture([0.71, 0.71]))
    expect(rotated.operatorIdentifiable).toBe(true)
    expect(rotated.laplacian).toBeCloseTo(-0.36 / 0.065 ** 2, 5)
  })
  it('identifies the transport operator after turning when a cardinal nozzle is fully blocked', () => {
    const map = (p: Vec2) => p.y < 0.495 && Math.abs(p.x - 0.5) < 0.015
    const fixed = evaluateMultiView(fixture([0, 0], map))
    const turned = evaluateMultiView(fixture([0, Math.PI / 4], map))
    expect(fixed.operatorIdentifiable).toBe(false)
    expect(fixed.positive).toBe(false)
    expect(turned.operatorIdentifiable).toBe(true)
    // Algebraic identifiability alone is insufficient: this narrow slot still
    // amplifies noise too strongly and must not produce a positive decision.
    expect(turned.reason).toBe('ill-conditioned geometry')
    expect(turned.positive).toBe(false)
  })
  it('cancels a translating gradient and rejects absent or nonfinite evidence', () => {
    const translating = [0.8, 0.01, 0, 0, 0, 0, -0.05 * 0.01 / 0.065 * 6]
    const result = evaluateMultiView(fixture([0, Math.PI / 4], undefined, translating))
    expect(result.nominalResidual).toBeCloseTo(0, 8)
    expect(result.positive).toBe(false)
    expect(evaluateMultiView(fixture([0, Math.PI / 4], undefined, [0, 0, 0, 0, 0, 0, 0])).positive).toBe(false)
    expect(evaluateMultiView({ ...fixture([0, Math.PI / 4]), sensorNoise: NaN }).usable).toBe(false)
  })
  it('prefers turning in open space and uses a collision-free fallback near a domain corner', () => {
    expect(selectSniffTurnPlan(anchor, 'active-suction', 0.065, 0.78, () => false, 0.05).mode).toBe('turn-only')
    const map = (p: Vec2, c = 0.014) => p.x < c || p.y < c || p.x > 1 - c || p.y > 1 - c
    const plan = selectSniffTurnPlan({ x: 0.018, y: 0.018 }, 'active-suction', 0.065, 0.78, map, 0.05)
    expect(plan.mode, JSON.stringify(plan)).toBe('turn-and-reposition')
    expect(plan.identifiable).toBe(true)
    expect(map(plan.secondPosition)).toBe(false)
  })
  it('does not mutate raw observations', () => {
    const input = fixture([0, Math.PI / 4]); const before = JSON.stringify(input)
    evaluateMultiView(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})
