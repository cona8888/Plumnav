/** Replay the three controlled-release passes in the EPA workbook through the
 * production coverage estimator. Commands are ignored on this recorded path.
 * The input is from scripts/inspect-public-methane-workbook.py. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createDefaultConfig, effectiveSensorThreshold } from '../src/sim/config'
import { SimulationEngine } from '../src/sim/engine'
import type { Observation, Vec2 } from '../src/sim/types'

type Row = { row: number; cells: { cell: string; value: unknown }[] }
type Sheet = { name: string; rows: Row[] }
type Sample = { row: number; lat: number; lon: number; ppm: number; position: Vec2 }

const file = process.argv[2]
const sha256 = 'd408f8d7b9b0630132720ad069095230f442a6d24a8be159a8558bdb4b9e1b4d'
type Unprojected = Omit<Sample, 'position'>
const domainMetres = 500
const metresPerDegree = 6371008.8 * Math.PI / 180
const config = { ...createDefaultConfig('coverage', 'open'), domainMeters: domainMetres,
  targetStatus: 'absent' as const, sensorPpmPerNormalizedUnit: 100 }

function extractWorkbook(file: string): Unprojected[][] {
  const input = JSON.parse(readFileSync(file, 'utf8'))
  if (input.sha256 !== sha256 || input.schemaVersion !== 'public-methane-workbook-structure-v1') {
    throw new Error('Expected the cell-addressed extraction from the EPA methane transect workbook')
  }
  const sheet: Sheet | undefined = input.sheets.find((s: Sheet) => s.name === 'Methane Transects Data Set')
  if (!sheet) throw new Error('Missing controlled-release worksheet')
  return [['A', 'B', 'C'], ['E', 'F', 'G'], ['I', 'J', 'K']].map(columns => {
    const pass: Unprojected[] = []
    for (const row of sheet.rows.filter(r => r.row >= 3)) {
      const cells = columns.map(column => row.cells.find(c => c.cell === column + row.row)?.value)
      if (cells.every(v => v === undefined)) continue
      if (cells.some(v => typeof v !== 'number')) throw new Error('Invalid EPA cell')
      const [lat, lon, ppm] = cells as number[]
      pass.push({ row: row.row, lat: lat!, lon: lon!, ppm: ppm! })
    }
    return pass
  })
}

function bundledRecords(): Unprojected[][] {
  const [header, ...lines] = readFileSync(new URL('../validation/data/epa/controlled-release.csv', import.meta.url), 'utf8').trimEnd().split(/\r?\n/)
  if (header !== 'pass,worksheet_row,latitude_deg,longitude_deg,methane_ppm') throw new Error('Unexpected EPA CSV columns')
  const passes: Unprojected[][] = [[], [], []]
  for (const line of lines) {
    const cells = line.split(',')
    const [pass, row, lat, lon, ppm] = cells.map(Number)
    if (cells.length !== 5 || cells.some(c => !c.trim()) || !Number.isInteger(pass) || !passes[pass! - 1]) throw new Error('Invalid EPA CSV record')
    passes[pass! - 1]!.push({ row: row!, lat: lat!, lon: lon!, ppm: ppm! })
  }
  return passes
}

function project(pass: Unprojected[]): Sample[] {
  return pass.map((s, index) => {
    if (s.row !== index + 3 || ![s.lat, s.lon, s.ppm].every(Number.isFinite)) throw new Error('Incomplete or discontinuous controlled-release record')
    const origin = pass[0]!
    const x = 0.5 + (s.lon - origin.lon) * metresPerDegree * Math.cos(origin.lat * Math.PI / 180) / domainMetres
    const y = 0.5 - (s.lat - origin.lat) * metresPerDegree / domainMetres
    if (Math.min(x, y) < 0 || Math.max(x, y) > 1) throw new Error('GPS exceeds local map')
    return { ...s, position: { x, y } }
  })
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

const passes = (file ? extractWorkbook(file) : bundledRecords()).map(project)
// The workbook digest in an extraction is only a label. Pin the actual values that enter the replay,
// preserving pass order and worksheet row identities while ignoring export paths and timestamps.
const records = passes.map(pass => pass.map(s => [s.row, s.lat, s.lon, s.ppm]))
const cellsDigest = createHash('sha256').update(JSON.stringify(records)).digest('hex')
if (cellsDigest !== '85d8fc4e48a513a23827c4f2e87dd9a0af5b416941b9430802576bbc56fa3acd') {
  throw new Error('Controlled-release cells differ from the verified EPA workbook')
}
const results = passes.map((samples, i) => {
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
