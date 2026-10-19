import { describe, expect, it } from 'vitest'
import { estimateQuadGradient } from './quadSoilSniff'
import { quadSniffChannelDirections } from '../quadSniff'
import type { QuadSniffChannelReading } from '../types'

function readings(domain: number, gx = 0.4, gy = 0.3): QuadSniffChannelReading[] {
  return quadSniffChannelDirections({ x: 1, y: 0 }).map(({ channel, direction }) => ({
    channel, direction, reach: 0.05 / domain, support: 1,
    effectiveOffset: { x: direction.x * 0.05 / domain, y: direction.y * 0.05 / domain },
    concentration: 0.5 + 0.05 * (direction.x * gx + direction.y * gy), hit: true,
    integrationSamples: 1, effectiveIntegrationSamples: 1,
  }))
}
describe('head-relative gradient solve', () => {
  it('retains a witness of the legacy domain-dependent numerical cutoff', () => {
    expect(estimateQuadGradient(readings(100), 0.001).validDirection).toBe(true)
    expect(estimateQuadGradient(readings(1000), 0.001).validDirection).toBe(false)
    expect(estimateQuadGradient(readings(100_000), 0.001).usableChannels).toBe(0)
  })
  it.each([1, 100, 1000, 100_000])('preserves physical gradient, direction, SNR and confidence on domain %s', domain => {
    const result = estimateQuadGradient(readings(domain), 0.001, 'relative-geometry-v1')
    const reference = estimateQuadGradient(readings(1), 0.001, 'relative-geometry-v1')
    expect(result.validDirection).toBe(true)
    expect(result.gradient.x / domain).toBeCloseTo(0.4, 12)
    expect(result.gradient.y / domain).toBeCloseTo(0.3, 12)
    expect(result.direction.x).toBeCloseTo(0.8, 12)
    expect(result.direction.y).toBeCloseTo(0.6, 12)
    expect(result.gradientSnr).toBeCloseTo(reference.gradientSnr, 12)
    expect(result.quality).toBeCloseTo(reference.quality, 12)
  })
  it('does not turn a weak signal or a uniform field into a valid direction', () => {
    expect(estimateQuadGradient(readings(1000), 0.1, 'relative-geometry-v1').validDirection).toBe(false)
    expect(estimateQuadGradient(readings(1000, 0, 0), 0.001, 'relative-geometry-v1').validDirection).toBe(false)
  })
  it('rejects collinear geometry and excludes saturated channels', () => {
    const line = readings(1000).map(r => ({ ...r, effectiveOffset: { x: r.effectiveOffset.x, y: 0 } }))
    expect(estimateQuadGradient(line, 0.001, 'relative-geometry-v1').validDirection).toBe(false)
    const clipped = readings(1000).map(r => ({ ...r, saturated: true }))
    expect(estimateQuadGradient(clipped, 0.001, 'relative-geometry-v1').usableChannels).toBe(0)
  })
  it('does not mutate input geometry', () => {
    const data = readings(1000), before = structuredClone(data)
    estimateQuadGradient(data, 0.001, 'relative-geometry-v1')
    expect(data).toEqual(before)
  })
})
