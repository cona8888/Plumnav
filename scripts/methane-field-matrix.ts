/** Replay published QCLAS flight windows against release coordinates in the source-file headers. */
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { horizontalDistanceMetres, replayMeasuredPeak } from './lib/measured-peak'

const directory = process.argv[2]
if (!directory || process.argv.length !== 3) throw new Error('Usage: vite-node scripts/methane-field-matrix.ts path/to/MATRIX_Dataset')
const flightIds = readdirSync(directory).filter(s => /^\d{3}_\d{2}$/.test(s)).sort()
if (flightIds.length !== 18) throw new Error('Expected all 18 flight directories in MATRIX_Dataset.zip')

const datasetHash = createHash('sha256')
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
  const independent = samples.reduce((best, sample, i) => sample.methanePpm > samples[best]!.methanePpm ? i : best, 0)
  if (peak.index !== independent) throw new Error(`${flight}: estimator failed to reproduce measured peak`)
  const closestTrackMetres = Math.min(...samples.map(sample => horizontalDistanceMetres(source, sample)))
  results.push({ flight, file: files[0], source, windowUtc: window.slice(1), totalRows: records.length,
    outsideWindow, invalid, validReadings: samples.length, peakUtc: samples[peak.index]!.utc,
    peakLatitude: peak.latitude, peakLongitude: peak.longitude, peakSignalPpm: peak.methanePpm,
    sourceErrorMetres: horizontalDistanceMetres(source, peak), closestTrackMetres })
}
if (results.length !== 8) throw new Error('Expected eight flights with explicitly labelled release positions in the published archive')
const orderedErrors = results.map(r => r.sourceErrorMetres).sort((a, b) => a - b)
if (datasetHash.digest('hex') !== 'c6a674ecdc72061961d46772aaaeae8b949945e49ab3c27a3f5cf4db1b2baeec') throw new Error('Methane source files differ from the published MATRIX archive')
console.log(JSON.stringify({ doi: '10.5281/zenodo.6335359', results, excluded,
  medianSourceErrorMetres: (orderedErrors[3]! + orderedErrors[4]!) / 2 }, null, 2))
