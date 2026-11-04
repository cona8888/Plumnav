import { expect, describe, it } from 'vitest'
import { estimateCurtainBearing } from './curtainBearing'

const wind = { eastMetresPerSecond: 2, northMetresPerSecond: 0, angularSpreadDegrees: 12 }
const sample = (profile: (north: number) => number) => Array.from({ length: 97 }, (_, i) => {
  const northMetres = i / 2 - 24
  return { eastMetres: 20, northMetres, methanePpm: profile(northMetres) }
})
const plume = (offset: number) => (y: number) => 2 + Math.exp(-0.5 * ((y - offset) / 3) ** 2)

describe('wind-aware curtain crossing', () => {
  it('recovers the crosswind coordinate within one bin and reports an upwind ray without a range', () => {
    const result = estimateCurtainBearing(sample(plume(3)), wind)
    expect(result.status).toBe('bearing')
    if (result.status !== 'bearing') throw new Error(result.reason)
    expect(result.sourcePoint).toBeNull()
    expect(result.upwindBearingDegrees).toBe(270)
    expect(result.crossing.eastMetres).toBeCloseTo(20)
    expect(Math.abs(result.crossing.northMetres - 3)).toBeLessThan(2)
    expect(result.windSpreadDegrees).toBe(12)
    expect(result.crosswindWidthMetres).toBeGreaterThanOrEqual(8)
  })

  it('rotates the upwind direction with the geographic coordinates and wind', () => {
    const points = sample(plume(3)).map(p => ({ ...p, eastMetres: p.northMetres, northMetres: -p.eastMetres }))
    const result = estimateCurtainBearing(points, { ...wind, eastMetresPerSecond: 0, northMetresPerSecond: -2 })
    expect(result.status).toBe('bearing')
    if (result.status !== 'bearing') throw new Error(result.reason)
    expect(result.upwindBearingDegrees).toBe(0)
    expect(Math.abs(result.crossing.eastMetres - 3)).toBeLessThan(2)
  })

  it('abstains in a flat, edge-only, disconnected, gapped or alongwind section', () => {
    const rows = sample(plume(0))
    for (const samples of [
      sample(() => 2), sample(plume(-22)), sample(y => Math.abs(Math.abs(y) - 10) < 2 ? 3 : 2),
      rows.filter(p => Math.abs(p.northMetres) > 5),
      rows.map(p => ({...p, eastMetres: p.northMetres, northMetres: 0})),
    ]) expect(estimateCurtainBearing(samples, wind)).toMatchObject({ status: 'abstain', sourcePoint: null })
  })

  it('rejects missing or unreliable winds and invalid sensor inputs', () => {
    const rows = sample(plume(0))
    expect(estimateCurtainBearing(rows, { ...wind, eastMetresPerSecond: 0.1 }).status).toBe('abstain')
    expect(estimateCurtainBearing(rows, { ...wind, angularSpreadDegrees: 45 }).status).toBe('abstain')
    expect(() => estimateCurtainBearing(rows, { ...wind, northMetresPerSecond: NaN })).toThrow()
    expect(() => estimateCurtainBearing([{ ...rows[0]!, methanePpm: Infinity }], wind)).toThrow()
    expect(() => estimateCurtainBearing(rows, wind, 0)).toThrow()
  })
})

describe('field operator data quality', () => {
  const track = sample(plume(3)).map((p,i) => ({ ...p, time: i * 0.1 }))
  it('removes invalid and clipped readings before assessing traverse support', () => {
    const r = estimateCurtainBearing(track.map(p => ({ ...p, clipped: Math.abs(p.northMetres) < 10 })), wind)
    expect(r).toMatchObject({ status: 'abstain', sourcePoint: null })
    expect(estimateCurtainBearing(track.map(p => ({ ...p, valid: false })), wind).status).toBe('abstain')
    expect(() => estimateCurtainBearing([{ ...track[0]!, clipped: 'false' as unknown as boolean }], wind)).toThrow(/quality/)
  })
  it('does not count repeated packets as independent acquisitions', () => {
    const coarse = track.filter((_,i) => i % 8 === 0)
    expect(estimateCurtainBearing(coarse.flatMap(p => [p,p]), wind)).toMatchObject({ status: 'abstain' })
    const unclocked = coarse.map(({time: _time, ...p}) => p)
    expect(estimateCurtainBearing(unclocked.flatMap(p => [p,p]), wind)).toMatchObject({ status: 'abstain' })
    expect(estimateCurtainBearing(track.flatMap(p => [p,p]), wind)).toEqual(estimateCurtainBearing(track, wind))
    expect(() => estimateCurtainBearing([{ ...track[0]! }, { ...track[0]!, methanePpm: 99 }], wind)).toThrow(/Conflicting/)
    expect(() => estimateCurtainBearing([track[1]!, track[0]!], wind)).toThrow(/clock/)
    expect(() => estimateCurtainBearing([track[0]!, { ...track[1]!, time: undefined }], wind)).toThrow(/clock/)
  })
})
