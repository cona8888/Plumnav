import { expect, it } from 'vitest'
import { replayCurtain, scoreCurtain } from './lib/curtain-replay'

it('scores transverse and along-ray distances separately without using truth to infer range', () => {
  const degrees = 180 / (Math.PI * 6371008.8)
  const track = Array.from({ length: 121 }, (_, i) => {
    const north = (i - 60) / 2
    return { latitude: north * degrees, longitude: 0, methanePpm: 2 + Math.exp(-0.5 * (north / 3) ** 2) }
  })
  const flight = replayCurtain(track, { eastMetresPerSecond: 1, northMetresPerSecond: 0, angularSpreadDegrees: 5 })
  expect(flight.estimate.status).toBe('bearing')
  const upwind = scoreCurtain(flight, { latitude: 3 * degrees, longitude: -80 * degrees }, track, track[60]!)!
  const downwind = scoreCurtain(flight, { latitude: 3 * degrees, longitude: 80 * degrees }, track, track[60]!)!
  expect(upwind.signedAlongRayMetres).toBeCloseTo(80, 5)
  expect(downwind.signedAlongRayMetres).toBeCloseTo(-80, 5)
  expect(upwind.distanceToRayMetres).toBeCloseTo(upwind.crosswindOffsetMetres)
  expect(downwind.crosswindOffsetMetres).toBeCloseTo(upwind.crosswindOffsetMetres)
  expect(downwind.distanceToRayMetres).toBeGreaterThan(80)
  expect(upwind.trackMidpointLineErrorMetres).toBeCloseTo(3, 7)
  expect(upwind.peakLineErrorMetres).toBeCloseTo(3, 7)
  expect(flight.estimate.sourcePoint).toBeNull()
})
