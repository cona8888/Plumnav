/** Replay the three controlled-release passes in the EPA workbook through the
 * production coverage estimator. Commands are ignored on this recorded path.
 * The input is from scripts/inspect-public-methane-workbook.py. */
import { readFileSync } from 'node:fs'
import { createDefaultConfig, effectiveSensorThreshold } from '../src/sim/config'
import { SimulationEngine } from '../src/sim/engine'
import type { Observation, Vec2 } from '../src/sim/types'

type Row = { row: number; cells: { cell: string; value: unknown }[] }
type Sheet = { name: string; rows: Row[] }
type Sample = { row: number; lat: number; lon: number; ppm: number; position: Vec2 }

const file = process.argv[2]
if (!file) throw new Error('Usage: vite-node scripts/empirical-epa-replay.ts workbook-structure.json')
const input = JSON.parse(readFileSync(file, 'utf8'))
const sha256 = 'd408f8d7b9b0630132720ad069095230f442a6d24a8be159a8558bdb4b9e1b4d'
if (input.sha256 !== sha256 || input.schemaVersion !== 'public-methane-workbook-structure-v1') {
  throw new Error('Expected the cell-addressed extraction from the EPA methane transect workbook')
}
const sheet: Sheet | undefined = input.sheets.find((s: Sheet) => s.name === 'Methane Transects Data Set')
if (!sheet) throw new Error('Missing controlled-release worksheet')
const domainMetres = 500
const metresPerDegree = 6371008.8 * Math.PI / 180
const config = { ...createDefaultConfig('coverage', 'open'), domainMeters: domainMetres,
  targetStatus: 'absent' as const, sensorPpmPerNormalizedUnit: 100 }

function extract(rows: Row[], columns: string[]): Sample[] {
  const samples: Sample[] = []
  for (const row of rows.filter(r => r.row >= 3)) {
    const values = columns.map(column => row.cells.find(c => c.cell === column + row.row)?.value)
    if (values.every(v => v === undefined)) continue
    if (row.row !== 3 + samples.length || values.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error('Incomplete or discontinuous controlled-release record')
    }
    const [lat, lon, ppm] = values as number[]
    const origin = samples[0] ?? { lat, lon }
    const x = 0.5 + (lon - origin.lon) * metresPerDegree * Math.cos(origin.lat * Math.PI / 180) / domainMetres
    const y = 0.5 - (lat - origin.lat) * metresPerDegree / domainMetres
    if (Math.min(x, y) < 0 || Math.max(x, y) > 1) throw new Error('GPS exceeds local map')
    samples.push({ row: row.row, lat, lon, ppm, position: { x, y } })
  }
  return samples
}

function replay(samples: Sample[], stride: number, phase: number): Sample {
  const { controller } = new SimulationEngine(config)
  const observations: Observation[] = []
  let estimate: Vec2 | null = null
  const selected = samples.filter((_, i) => i % stride === phase)
  for (const sample of selected) {
    // Nominal 10 Hz from the EPA dictionary. The peak estimator only needs ordering.
    const time = (sample.row - 3) / 10
    const concentration = sample.ppm / config.sensorPpmPerNormalizedUnit
    const measurement = { time, concentration, hit: concentration >= effectiveSensorThreshold(config),
      valid: true, sampleMode: 'passive' as const, wind: { x: 0, y: 0 } }
    observations.push({ ...measurement, position: sample.position })
    estimate = controller.step({ time, dt: stride / 10, heading: 0, position: sample.position,
      measurement, observations, distance: 0 }).estimate
  }
  // Cross-check the controller's reported coordinates against the independent,
  // earliest measured maximum. Works also when several rows share a GPS fix.
  const peak = selected.reduce((best, sample) => sample.ppm > best.ppm ? sample : best)
  if (!estimate || estimate.x !== peak.position.x || estimate.y !== peak.position.y) {
    throw new Error('Coverage estimate disagrees with independent measured-peak coordinate')
  }
  return peak
}

const results = [['A', 'B', 'C'], ['E', 'F', 'G'], ['I', 'J', 'K']].map((cols, i) => {
  const samples = extract(sheet.rows, cols)
  const peak = replay(samples, 1, 0)
  const phases = Array.from({ length: 10 }, (_, phase) => {
    const selected = replay(samples, 10, phase)
    return { phase, peakRow: selected.row, peakPpm: selected.ppm, shiftMetres: domainMetres *
      Math.hypot(selected.position.x - peak.position.x, selected.position.y - peak.position.y) }
  })
  return { pass: i + 1, readings: samples.length, peakRow: peak.row, peakPpm: peak.ppm,
    minimumDecimatedPeakPpm: Math.min(...phases.map(p => p.peakPpm)),
    maximumShiftMetres: Math.max(...phases.map(p => p.shiftMetres)), phases }
})
console.log(JSON.stringify({ doi: '10.23719/1390071', sha256, results }, null, 2))
