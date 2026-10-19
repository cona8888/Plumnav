import { describe, expect, it } from 'vitest'
import { activeSniffKernel } from '../src/sim/activeSniff'
import { quadSniffChannelDirections } from '../src/sim/quadSniff'
import { evaluateFlowSourceEvidence } from './lib/flow-source-evidence'
import type { QuadSamplingMode, QuadSniffStatus, Vec2 } from '../src/sim/types'

const position = { x: 0.5, y: 0.5 }
const manufactured = (mode: QuadSamplingMode, field: (p: Vec2, t: number) => number, angle = 0) => {
  const forward = { x: Math.cos(angle), y: Math.sin(angle) }
  const reach = mode === 'passive-array' ? 0.0125 : 0.065
  const time = 10.75; const midpoint = 10.375; const strength = mode === 'passive-array' ? 0 : 0.78
  const readings = quadSniffChannelDirections(forward).map(({ channel, direction }) => {
    const head = { x: position.x + direction.x * reach, y: position.y + direction.y * reach }
    const kernel = activeSniffKernel(position, direction, reach, () => false)
    const remote = kernel.reduce((s, k) => s + k.weight * field(k.point, midpoint), 0)
    return { channel, direction, reach, support: 1,
      effectiveOffset: { x: head.x - position.x, y: head.y - position.y },
      concentration: mode === 'passive-array' ? field(head, midpoint)
        : (1 - 0.67 * strength) * field(position, midpoint) + 0.67 * strength * remote,
      hit: true, saturated: false, integrationSamples: 4, effectiveIntegrationSamples: 3.6 }
  })
  const quad: QuadSniffStatus = { scanId: 1, phase: 'return', forward, strength, samplingMode: mode,
    progress: 1, channels: readings, readings }
  return { position, time, cycleSeconds: 0.75, quad,
    central: Array.from({ length: 20 }, (_, i) => ({ time: 5 + i * 0.25, concentration: field(position, 5 + i * 0.25) })),
    wind: { x: 0.05, y: 0 }, diffusivity: 0.001, sensorNoise: 0, sensorSaturation: 1.5,
    isBlocked: () => false }
}
describe('M13 research-only flow-aware source evidence', () => {
  for (const mode of ['active-suction', 'passive-array'] as const) {
    it(`${mode}: reconstructs known quadratic curvature at either body orientation`, () => {
      for (const angle of [0, 0.71]) {
        const result = evaluateFlowSourceEvidence(manufactured(mode,
          (p) => 0.8 - 40 * ((p.x - 0.5) ** 2 + (p.y - 0.5) ** 2), angle))
        expect(result.usable).toBe(true)
        expect(result.laplacian).toBeCloseTo(-160, 7)
        expect(result.nominalResidual).toBeCloseTo(0.16, 8)
        expect(result.positive).toBe(true)
      }
    })
    it(`${mode}: cancels pure translating advection rather than calling it a source`, () => {
      const result = evaluateFlowSourceEvidence(manufactured(mode, (p, t) => 0.8 + 0.2 * (p.x - 0.5) - 0.01 * (t - 10)))
      expect(result.usable).toBe(true)
      expect(result.nominalResidual).toBeCloseTo(0, 8)
      expect(result.positive).toBe(false)
    })
  }
  it('fails closed on absence, saturation, occlusion, missing geometry and stale baseline', () => {
    const flat = manufactured('active-suction', () => 0.8)
    expect(evaluateFlowSourceEvidence(manufactured('active-suction', () => 0)).positive).toBe(false)
    expect(evaluateFlowSourceEvidence({ ...flat, sensorNoise: 0.025 }).positive).toBe(false)
    for (const patch of [{ saturated: true }, { support: 0.5 }]) {
      const quad = { ...flat.quad, readings: flat.quad.readings!.map((r, i) => i === 0 ? { ...r, ...patch } : r) }
      expect(evaluateFlowSourceEvidence({ ...flat, quad }).usable).toBe(false)
    }
    expect(evaluateFlowSourceEvidence({ ...flat, central: [] }).usable).toBe(false)
    expect(evaluateFlowSourceEvidence({ ...flat, time: 20 }).usable).toBe(false)
    expect(evaluateFlowSourceEvidence({ ...flat, quad: { ...flat.quad, strength: 0 } }).usable).toBe(false)
  })
  it('does not mutate the measured evidence', () => {
    const input = manufactured('active-suction', () => 0.8)
    const before = JSON.stringify(input)
    evaluateFlowSourceEvidence(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})
