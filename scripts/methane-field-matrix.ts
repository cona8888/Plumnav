/** Replay published QCLAS flight windows against release coordinates in the source-file headers. */
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { replayCurtain, scoreCurtain } from './lib/curtain-replay'
import { horizontalDistanceMetres, replayMeasuredPeak } from './lib/measured-peak'

const directory = process.argv[2]
if (!directory || process.argv.length !== 3) throw new Error('Usage: vite-node scripts/methane-field-matrix.ts path/to/MATRIX_Dataset')
const flightIds = readdirSync(directory).filter(s => /^\d{3}_\d{2}$/.test(s)).sort()
if (flightIds.length !== 18) throw new Error('Expected all 18 flight directories in MATRIX_Dataset.zip')

const datasetHash = createHash('sha256')
// The archive contains one-second horizontal ground-station wind components in the UTC flight frame.
const meteoFiles: Record<string, string> = {
  '20200313': 'd89485f5e753e3635687f2f2779198abba62a2d03b1a2d6042b380e9180b67f9',
  '20200314': 'b49a4dd7ecdc6aab25121e8a7b159cb7ac941303cef7999c45f9da84ceb87fe4',
}
function readWindowWind(date: string, start: number, end: number) {
  const bytes = readFileSync(join(directory!, 'MATRIX_Meteo', `agg_${date}.csv`))
  if (createHash('sha256').update(bytes).digest('hex') !== meteoFiles[date]) throw new Error('MATRIX wind file checksum mismatch')
  const [head, ...records] = bytes.toString('utf8').trim().split(/\r?\n/)
  const fields = head!.split(',')
  const ix = fields.indexOf('uu'), iy = fields.indexOf('vv'), it = fields.indexOf('year_month_day_hour_minute_second')
  if ([ix, iy, it].includes(-1)) throw new Error('Missing MATRIX wind components')
  let east = 0, north = 0, magnitude = 0, count = 0
  for (const row of records) {
    const c = row.split(',')
    const time = Date.parse(c[it]!.replace(' ', 'T') + 'Z') / 1000
    if (!Number.isFinite(time) || time < start || time > end) continue
    const u = Number(c[ix]), v = Number(c[iy])
    if (!c[ix] || !c[iy] || ![u, v].every(x => Number.isFinite(x) && x !== -999.99)) continue
    east += u; north += v; magnitude += Math.hypot(u, v); count++
  }
  if (count < 0.8 * (end - start + 1)) throw new Error('Too few time-matched MATRIX wind rows')
  const resultant = magnitude ? Math.min(1, Math.hypot(east, north) / magnitude) : 0
  const spread = resultant > 0 ? Math.min(180, Math.sqrt(-2 * Math.log(resultant)) * 180 / Math.PI) : 180
  return { count, wind: { eastMetresPerSecond: east / count, northMetresPerSecond: north / count, angularSpreadDegrees: spread } }
}
const results = []
const excluded = []
for (const flight of flightIds) {
  const files = readdirSync(join(directory, flight)).filter(s => /^EMP_.*_CH4_v2\.csv$/.test(s))
  if (files.length !== 1) throw new Error(`${flight}: expected one Empa methane file`)
  const bytes = readFileSync(join(directory, flight, files[0]!))
  datasetHash.update(`${flight}/${files[0]}\0`).update(bytes).update('\0')
  const lines = bytes.toString('utf8').trim().split(/\r?\n/)
  // The source wraps comments at a fixed width, sometimes in the middle of a coordinate.
  const notes = lines.filter(l => l.startsWith('#')).map(l => l.slice(1)).join('').replace(/\s/g, '')
  const sourceMatch = notes.match(/Locationofsourceis(\d+\.\d+),(\d+\.\d+)/i)
  if (!sourceMatch) {
    excluded.push({ flight, reason: 'no explicitly labelled source coordinate in methane file' })
    continue
  }
  const source = { latitude: Number(sourceMatch[1]), longitude: Number(sourceMatch[2]) }
  const window = notes.match(/from(\d\d:\d\d:\d\d)to(\d\d:\d\d:\d\d)UTC/i)
  if (!window || !notes.includes('Unit=ppb') || !notes.includes('Invalid_data=-999.99')) {
    throw new Error(`${flight}: unexpected units, missing flag or UTC window`)
  }
  const [header, ...records] = lines.filter(l => !l.startsWith('#'))
  const fields = header!.split(';')
  const indices = Object.fromEntries(['Date_UTC', 'Time_UTC', 'Latitude', 'Longitude', 'CH4_spec_corr', 'Flag'].map(k => {
    const index = fields.indexOf(k)
    if (index === -1) throw new Error(`${flight}: missing ${k}`)
    return [k, index]
  }))
  const samples = []
  let outsideWindow = 0
  let invalid = 0
  for (const record of records) {
    const values = record.split(';')
    const at = (key: string) => values[indices[key]!] ?? ''
    const utc = at('Time_UTC')
    if (utc < window[1]! || utc > window[2]!) { outsideWindow++; continue }
    const numeric = (key: string) => at(key).trim() === '' ? NaN : Number(at(key))
    const latitude = numeric('Latitude'), longitude = numeric('Longitude'), signal = numeric('CH4_spec_corr')
    const timeSeconds = Date.parse(at('Date_UTC') + 'T' + utc + 'Z') / 1000
    if (at('Flag') !== 'o' || !Number.isFinite(timeSeconds) ||
        ![latitude, longitude, signal].every(v => Number.isFinite(v) && v !== -999.99)) {
      invalid++
      continue
    }
    samples.push({ timeSeconds, latitude, longitude, methanePpm: signal / 1000, utc })
  }
  const peak = replayMeasuredPeak(samples)
  const date = new Date(samples[0]!.timeSeconds * 1000).toISOString().slice(0, 10).replaceAll('-', '')
  const {count: windReadings, wind} = readWindowWind(date, samples[0]!.timeSeconds, samples[samples.length - 1]!.timeSeconds)
  const curtain = replayCurtain(samples, wind)
  const independent = samples.reduce((best, sample, i) => sample.methanePpm > samples[best]!.methanePpm ? i : best, 0)
  if (peak.index !== independent) throw new Error(`${flight}: estimator failed to reproduce measured peak`)
  const closestTrackMetres = Math.min(...samples.map(sample => horizontalDistanceMetres(source, sample)))
  results.push({ flight, windReadings, curtain, curtainScore: scoreCurtain(curtain, source, samples, peak), file: files[0], source, windowUtc: window.slice(1), totalRows: records.length,
    outsideWindow, invalid, validReadings: samples.length, peakUtc: samples[peak.index]!.utc,
    peakLatitude: peak.latitude, peakLongitude: peak.longitude, peakSignalPpm: peak.methanePpm,
    sourceErrorMetres: horizontalDistanceMetres(source, peak), closestTrackMetres })
}
if (results.length !== 8) throw new Error('Expected eight flights with explicitly labelled release positions in the published archive')
const orderedErrors = results.map(r => r.sourceErrorMetres).sort((a, b) => a - b)
if (datasetHash.digest('hex') !== 'c6a674ecdc72061961d46772aaaeae8b949945e49ab3c27a3f5cf4db1b2baeec') throw new Error('Methane source files differ from the published MATRIX archive')
console.log(JSON.stringify({ doi: '10.5281/zenodo.6335359', results, excluded,
  medianSourceErrorMetres: (orderedErrors[3]! + orderedErrors[4]!) / 2 }, null, 2))
