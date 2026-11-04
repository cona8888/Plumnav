/** Replay every analysed 2018 Blackpool survey on the published, time-aligned flight paths. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { horizontalDistanceMetres, replayMeasuredPeak, type GeographicPoint } from './lib/measured-peak'
import { replayCurtain, scoreCurtain } from './lib/curtain-replay'
import type { CurtainWind } from '../src/sim/curtainBearing'
import { percentile } from '../src/sim/math'

const archive = process.argv[2]
if (process.argv.length > 3) throw new Error('Usage: vite-node scripts/blackpool-field-replay.ts [path/to/Testing_Data.zip]')

function readBundledSurveys() {
  const records: Buffer[] = []
  for (const [uav, count] of [[1, 7], [2, 15]] as const) {
    for (let i = 1; i <= count; i++) {
      const url = new URL(`../validation/data/blackpool/T${uav}.${i}.json.gz`, import.meta.url)
      records.push(gunzipSync(readFileSync(url)))
    }
  }
  const bytes = Buffer.concat(records)
  if (createHash('sha256').update(bytes).digest('hex') !== '616a543fa8d4cc2c1ceb7be58c6637a6f5eff5c6b6ed89b9b2962407ff237d54') {
    throw new Error('Bundled Blackpool observations differ from the verified 22-survey extraction')
  }
  return bytes.toString('utf8')
}

const extractor = fileURLToPath(new URL('./read-blackpool-surveys.py', import.meta.url))
const decoded = archive
  ? execFileSync(process.env.PYTHON ?? 'python3', [extractor, archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  : readBundledSurveys()
type Flight = { survey: string; rows: [number, number, number, number][]; truth: GeographicPoint; wind: CurtainWind }
const flights = decoded.trimEnd().split('\n').map((line): Flight => JSON.parse(line))
const results = flights.map(flight => {
  const readings = flight.rows.map(([timeSeconds, latitude, longitude, methanePpm]) => ({ timeSeconds, latitude, longitude, methanePpm }))
  const peak = replayMeasuredPeak(readings)
  const curtain = replayCurtain(readings, flight.wind)
  // Source location is first used here, after the controller has returned its estimate.
  const distances = readings.map(row => horizontalDistanceMetres(row, flight.truth))
  return { survey: flight.survey, samples: readings.length, curtain, curtainScore: scoreCurtain(curtain, flight.truth, readings, peak), peakPpm: peak.methanePpm,
    peakLatitude: peak.latitude, peakLongitude: peak.longitude, sourceLatitude: flight.truth.latitude, sourceLongitude: flight.truth.longitude,
    closestSampleM: Math.min(...distances), typicalSampleM: percentile(distances, 0.5), peakErrorM: horizontalDistanceMetres(peak, flight.truth) }
})
const errors = results.map(r => r.peakErrorM)
console.log(JSON.stringify({ study: '10.5281/zenodo.3708518', results, surveys: results.length,
  samples: results.reduce((n, r) => n + r.samples, 0), medianPeakErrorM: percentile(errors, 0.5),
  minimumPeakErrorM: Math.min(...errors), maximumPeakErrorM: Math.max(...errors),
  medianClosestSampleM: percentile(results.map(r => r.closestSampleM), 0.5) }, null, 2))
