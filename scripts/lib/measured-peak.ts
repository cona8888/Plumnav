import { createDefaultConfig, effectiveSensorThreshold } from '../../src/sim/config'
import { SimulationEngine } from '../../src/sim/engine'
import type { Observation, Vec2 } from '../../src/sim/types'

export type GeographicPoint = { latitude: number; longitude: number }
type MethaneRow = GeographicPoint & { timeSeconds: number; methanePpm: number }
const earthRadius = 6_371_008.8
const rad = Math.PI / 180
const deltaLon = (a: number, b: number) => ((a - b + 540) % 360) - 180

export function horizontalDistanceMetres(a: GeographicPoint, b: GeographicPoint) {
  const h = Math.sin((b.latitude - a.latitude) * rad / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) *
    Math.sin(deltaLon(b.longitude, a.longitude) * rad / 2) ** 2
  return 2 * earthRadius * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))))
}

/** Run the actual coverage controller along recorded positions, bypassing simulated sensing and motion.
 * Truth is never an input. A common scale on both axes preserves track geometry. Ties use the first row. */
export function replayTrackPeak(rows: readonly { timeSeconds: number; xMetres: number; yMetres: number; value: number }[]) {
  if (!rows.length) throw new Error('Empty measured track')
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity, peak = 0
  rows.forEach((row, i) => {
    if (![row.timeSeconds, row.xMetres, row.yMetres, row.value].every(Number.isFinite) ||
        (i && row.timeSeconds < rows[i - 1]!.timeSeconds)) throw new Error(`Invalid or unordered measured row ${i}`)
    xMin = Math.min(xMin, row.xMetres); xMax = Math.max(xMax, row.xMetres)
    yMin = Math.min(yMin, row.yMetres); yMax = Math.max(yMax, row.yMetres)
    if (row.value > rows[peak]!.value) peak = i
  })
  const side = 1.25 * Math.max(1, xMax - xMin, yMax - yMin)
  const positionAt = (r: typeof rows[number]) => ({ x: 0.5 + (r.xMetres - (xMax + xMin) / 2) / side,
    y: 0.5 + (r.yMetres - (yMax + yMin) / 2) / side })
  const config = { ...createDefaultConfig('coverage', 'open'), domainMeters: side, targetStatus: 'absent' as const }
  const { controller } = new SimulationEngine(config)
  const observations: Observation[] = []
  let estimate: Vec2 | null = null, distance = 0
  let last = positionAt(rows[0]!)
  for (const [i, row] of rows.entries()) {
    const time = row.timeSeconds - rows[0]!.timeSeconds
    const position = positionAt(row)
    const dt = i ? row.timeSeconds - rows[i - 1]!.timeSeconds : 0
    distance += Math.hypot(position.x - last.x, position.y - last.y)
    // Uniform signal scaling leaves the passive concentration rank unchanged. Hit flags do not select the peak.
    const concentration = row.value / config.sensorPpmPerNormalizedUnit
    const measurement = { time, valid: true, sampleMode: 'passive' as const, wind: { x: 0, y: 0 }, concentration,
      hit: concentration >= effectiveSensorThreshold(config) }
    observations.push({ ...measurement, position })
    estimate = controller.step({ position, time, dt, distance, heading: 0, measurement, observations }).estimate
    last = position
  }
  const expected = positionAt(rows[peak]!)
  if (estimate?.x !== expected.x || estimate?.y !== expected.y) throw new Error('Coverage estimate differs from measured maximum')
  return peak
}

export function replayMeasuredPeak(rows: readonly MethaneRow[]) {
  if (!rows.length) throw new Error('Empty measured track')
  const origin = rows[0]!
  const track = rows.map(r => {
    if (Math.abs(r.latitude) > 90 || Math.abs(r.longitude) > 180) throw new Error('Invalid geographic position')
    return { timeSeconds: r.timeSeconds, xMetres: deltaLon(r.longitude, origin.longitude) * rad * earthRadius * Math.cos(origin.latitude * rad),
      yMetres: -(r.latitude - origin.latitude) * rad * earthRadius, value: r.methanePpm }
  })
  const index = replayTrackPeak(track)
  const { latitude, longitude, methanePpm } = rows[index]!
  return { index, latitude, longitude, methanePpm }
}
