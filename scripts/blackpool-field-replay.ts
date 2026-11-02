/** Replay every analysed 2018 Blackpool survey on the published, time-aligned flight paths. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { horizontalDistanceMetres, replayMeasuredPeak, type GeographicPoint } from './lib/measured-peak'
import { percentile } from '../src/sim/math'

const archive = process.argv[2]
if (!archive || process.argv.length !== 3) throw new Error('Usage: vite-node scripts/blackpool-field-replay.ts path/to/Testing_Data.zip')
const extractor = fileURLToPath(new URL('./read-blackpool-surveys.py', import.meta.url))
const decoded = execFileSync(process.env.PYTHON ?? 'python3', [extractor, archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
type Flight = { survey: string; rows: [number, number, number, number][]; truth: GeographicPoint }
const flights = decoded.trimEnd().split('\n').map((line): Flight => JSON.parse(line))
const results = flights.map(flight => {
  const readings = flight.rows.map(([timeSeconds, latitude, longitude, methanePpm]) => ({ timeSeconds, latitude, longitude, methanePpm }))
  const peak = replayMeasuredPeak(readings)
  // Source location is first used here, after the controller has returned its estimate.
  const distances = readings.map(row => horizontalDistanceMetres(row, flight.truth))
  return { survey: flight.survey, samples: readings.length, peakPpm: peak.methanePpm,
    peakLatitude: peak.latitude, peakLongitude: peak.longitude, sourceLatitude: flight.truth.latitude, sourceLongitude: flight.truth.longitude,
    closestSampleM: Math.min(...distances), typicalSampleM: percentile(distances, 0.5), peakErrorM: horizontalDistanceMetres(peak, flight.truth) }
})
const errors = results.map(r => r.peakErrorM)
console.log(JSON.stringify({ study: '10.5281/zenodo.3708518', results, surveys: results.length,
  samples: results.reduce((n, r) => n + r.samples, 0), medianPeakErrorM: percentile(errors, 0.5),
  minimumPeakErrorM: Math.min(...errors), maximumPeakErrorM: Math.max(...errors),
  medianClosestSampleM: percentile(results.map(r => r.closestSampleM), 0.5) }, null, 2))
