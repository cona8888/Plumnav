import { estimateCurtainBearing, type CurtainWind } from '../../src/sim/curtainBearing'
import type { GeographicPoint } from './measured-peak'

/** Fixed tangent-plane convention for local flight tracks. No source coordinate enters the estimate. */
const toEn = (point: GeographicPoint, origin: GeographicPoint) => {
  const metresPerDegree = 6_371_008.8 * Math.PI / 180
  return { eastMetres: (((point.longitude - origin.longitude + 540) % 360) - 180) *
      metresPerDegree * Math.cos(origin.latitude * Math.PI / 180),
    northMetres: (point.latitude - origin.latitude) * metresPerDegree }
}

export function replayCurtain(rows: readonly (GeographicPoint & { methanePpm: number })[], wind: CurtainWind) {
  if (!rows.length) throw new RangeError('Empty flight')
  const origin = { latitude: rows[0]!.latitude, longitude: rows[0]!.longitude }
  const samples = rows.map(row => ({ ...toEn(row, origin), methanePpm: row.methanePpm }))
  const estimate = estimateCurtainBearing(samples, wind)
  return { origin, wind, estimate }
}

/** Crosswind distance to the infinite line, plus signed along-ray distance to disambiguate opposite bearings. */
export function scoreCurtain(replay: ReturnType<typeof replayCurtain>, source: GeographicPoint,
  rows: readonly GeographicPoint[], peak: GeographicPoint) {
  const result = replay.estimate
  if (result.status === 'abstain') return null
  const truth = toEn(source, replay.origin)
  const east = truth.eastMetres - result.crossing.eastMetres, north = truth.northMetres - result.crossing.northMetres
  const angle = result.upwindBearingDegrees * Math.PI / 180
  const signedAlongRayMetres = east * Math.sin(angle) + north * Math.cos(angle)
  const cross = (p: { eastMetres: number; northMetres: number }) => p.eastMetres * Math.cos(angle) - p.northMetres * Math.sin(angle)
  const crosswindOffsetMetres = Math.abs(cross(truth) - cross(result.crossing))
  let low = Infinity, high = -Infinity
  for (const row of rows) {
    const x = cross(toEn(row, replay.origin))
    low = Math.min(low, x)
    high = Math.max(high, x)
  }
  return { signedAlongRayMetres, crosswindOffsetMetres,
    // Matched bearing-only comparators using exactly the same measured wind.
    trackMidpointLineErrorMetres: Math.abs(cross(truth) - (low + high) / 2),
    peakLineErrorMetres: Math.abs(cross(truth) - cross(toEn(peak, replay.origin))),
    distanceToRayMetres: signedAlongRayMetres >= 0 ? crosswindOffsetMetres : Math.hypot(east, north) }
}
