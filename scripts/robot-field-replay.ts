/** Untuned peak-estimator validation on physical EPFL Crazyflie ethanol flights.
 * Usage: vite-node scripts/robot-field-replay.ts [raw-flight-folder] [--commissioning-flight=N | --legacy-retrospective] */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { BlankBaseline, baselineHit } from '../src/sim/baseline'
import { createDefaultConfig } from '../src/sim/config'
import { percentile } from '../src/sim/math'
import { getScenarioFlowBaseline } from '../src/sim/scenarios'
import { SimulationEngine } from '../src/sim/engine'
import type { AlgorithmDecision, Observation, Vec2 } from '../src/sim/types'

type Scan = { time: number; position: Vec2; voltage: number }
const args = process.argv.slice(2)
const legacy = args.at(-1) === '--legacy-retrospective'
const commissioningFlag = /^--commissioning-flight=([1-9]|10)$/.exec(args.at(-1) ?? '')
const commissioningFlight = commissioningFlag ? Number(commissioningFlag[1]) : 1
if (legacy || commissioningFlag) args.pop()
if (args.length > 1 || args[0]?.startsWith('--')) {
  throw new Error('Usage: robot-field-replay.ts [raw-flight-folder] [--commissioning-flight=1..10 | --legacy-retrospective]')
}
const useBundledData = args.length === 0
const folder = args[0] ?? fileURLToPath(new URL('../validation/data/epfl/', import.meta.url))
const flightCount = 10
const publishedDelay = 2 // seconds, fixed by the authors before this replay
const side = 6 // isotropic map scale in metres; embed the 6 x 2 m flight area in a square.
const config = { ...createDefaultConfig('coverage', 'open'), domainMeters: side, targetStatus: 'absent' as const }

function parseScan(data: string, baseline?: BlankBaseline): Scan[] {
  const [header, ...rows] = data.trim().split(/\r?\n/)
  if (header?.trim() !== '# cf_odor_time, cf_x, cf_y, cf_z, cf_odor') throw new Error('Unexpected EPFL scan schema')
  const scans: Scan[] = []
  for (const row of rows) {
    const values = row.split(',').map(v => Number(v.trim()))
    if (values.length !== 5 || !values.every(Number.isFinite)) throw new Error('Invalid pose or MOX record')
    const [time, x, y, z, voltage] = values as [number, number, number, number, number]
    // Authors' published physical-GSL bounds followed by first-row timestamp deduplication.
    const valid = x >= 3 && x <= 9 && y >= 1 && y <= 3 && z >= 0.7 && z <= 0.8 && voltage >= 0 && voltage <= 1000
    baseline?.observe({ time, value: voltage, valid, inReference: x > 8.75 })
    if (!valid) continue
    const last = scans.at(-1)
    if (last && time < last.time) throw new Error('Non-monotonic flight log')
    if (last && time === last.time) continue
    scans.push({ time, position: { x, y }, voltage })
  }
  if (scans.length < 2 || scans.at(-1)!.time < scans[0]!.time + publishedDelay) throw new Error('Incomplete flight')
  return scans
}

function alignedSamples(scans: Scan[], lag: number): Scan[] {
  const samples: Scan[] = []
  let poseIndex = 0
  for (const scan of scans) {
    // Match observation support across delay assumptions.
    if (scan.time < scans[0]!.time + publishedDelay) continue
    const poseTime = scan.time - lag
    while (poseIndex + 1 < scans.length && scans[poseIndex + 1]!.time <= poseTime) poseIndex++
    const a = scans[poseIndex]!, b = scans[poseIndex + 1] ?? a
    const fraction = b.time === a.time ? 0 : (poseTime - a.time) / (b.time - a.time)
    const x = a.position.x + fraction * (b.position.x - a.position.x)
    const y = a.position.y + fraction * (b.position.y - a.position.y)
    samples.push({ time: scan.time - scans[0]!.time, position: { x: (x - 3) / side, y: (y + 1) / side }, voltage: scan.voltage })
  }
  return samples
}

const toMetres = (p: Vec2): Vec2 => ({ x: 3 + side * p.x, y: side * p.y - 1 })
const wind = { x: -0.7 / side, y: 0 } // reported tunnel setting; normalized domain lengths / s

function replay(samples: Scan[], algorithmId: 'infotaxis' | 'coverage', classify: (value: number) => boolean = () => false) {
  const engine = new SimulationEngine({ ...config, algorithmId, windDirectionDegrees: 270,
    windSpeedScale: Math.abs(wind.x) / getScenarioFlowBaseline('open').windSpeed,
    turbulenceScale: 0, gustStrength: 0 })
  const { controller, environment } = engine
  // Restrict possible hypotheses to the known flight rectangle in the 6 m square.
  // The open-flow likelihood remains obstacle-free. Motion commands are ignored.
  if (algorithmId === 'infotaxis') {
    controller.reset({ ...environment, isBlocked: (p, clearance) =>
      p.y < 2 / side || p.y > 4 / side || environment.isBlocked(p, clearance) })
  }
  const history: Observation[] = []
  let previousTime = 0
  let decision: AlgorithmDecision | null = null
  for (const s of samples) {
    // V is used as a monotonic signal. No conversion to gas concentration is available.
    const measurement = { time: s.time, concentration: s.voltage / 1000, hit: classify(s.voltage),
      valid: true, sampleMode: 'passive' as const, wind }
    history.push({ ...measurement, position: s.position })
    decision = controller.step({ time: s.time, dt: s.time - previousTime, position: s.position,
      measurement, heading: 0, observations: history, distance: 0 })
    if (decision.nativeTerminated || decision.nativeAbstained) break
    previousTime = s.time
  }
  if (!decision?.estimate) throw new Error('No final controller estimate')
  const grid = decision.debug?.grid
  let map: Vec2 | null = null
  if (grid) {
    const k = grid.values.indexOf(Math.max(...grid.values))
    map = toMetres({ x: ((k % grid.width) + 0.5) / grid.width, y: (Math.floor(k / grid.width) + 0.5) / grid.height })
  }
  return { position: toMetres(decision.estimate), map, declared: Boolean(decision.nativeTerminated), usedSamples: history.length }
}

const blankPolicy = { flushSeconds: 4, spacingSeconds: 2, maximumGapSeconds: 0.5, minimumSamples: 8,
  minimumSpan: 1, maximumSpan: 20, maximumDrift: 8, margin: 1 }
const hash = createHash('sha256')
const flightFile = (i: number) => {
  const csv = join(folder, 'ex' + i, 'scan_1.csv')
  return useBundledData ? gunzipSync(readFileSync(csv + '.gz')) : readFileSync(csv)
}
const frozen = legacy ? null : (() => {
  const blank = new BlankBaseline(blankPolicy)
  parseScan(flightFile(commissioningFlight).toString('utf8'), blank)
  return blank.finish()
})()
const skipped: { flight: number; reason: string }[] = []
type Prediction = { flight: number; readings: number; raw: Vec2; aligned: Vec2; binnedReadings: number;
  thresholdMv: number; hits: number; alignedCoverage1Hz: Vec2; infotaxisEstimate: Vec2; infotaxisMap: Vec2;
  infotaxisDeclared: boolean; coverageDeclared: boolean; infotaxisUsedSamples: number; allMissEstimate: Vec2 }
const predictions: Prediction[] = []
for (let flight = 1; flight <= flightCount; flight++) {
  const data = flightFile(flight)
  hash.update(data)
  if (!legacy && (flight === commissioningFlight || frozen?.threshold === null)) {
    skipped.push({ flight, reason: flight === commissioningFlight ? 'reserved-commissioning-flight' : frozen?.reason ?? 'uncalibrated' })
    continue
  }
  const scans = parseScan(data.toString('utf8'))
  const aligned = alignedSamples(scans, publishedDelay)
  const coverageRaw = replay(alignedSamples(scans, 0), 'coverage')
  const coverageAligned = replay(aligned, 'coverage')
  let thresholdMv: number
  if (frozen && frozen.threshold !== null) thresholdMv = frozen.threshold
  else {
    // Historical diagnostic; available only with --legacy-retrospective.
    const background = scans.filter(s => s.position.x > 8.75).map(s => s.voltage)
    if (!background.length) throw new Error('Missing upstream reference observations')
    thresholdMv = percentile(background, 0.99)
  }
  const classify = (value: number) => frozen ? baselineHit(frozen, value, true) === true : value > thresholdMv
  // One actual record at the start of each occupied second from flight origin.
  const bins = aligned.filter((s, j) => j === 0 || Math.floor(s.time) !== Math.floor(aligned[j - 1]!.time))
  const infotaxis = replay(bins, 'infotaxis', classify)
  if (!infotaxis.map) throw new Error('Missing public Infotaxis posterior grid')
  const coverage = replay(bins, 'coverage', classify)
  const allMiss = replay(bins.map(s => ({ ...s, voltage: 0 })), 'infotaxis')
  predictions.push({ flight, readings: aligned.length, raw: coverageRaw.position, aligned: coverageAligned.position,
    binnedReadings: bins.length, thresholdMv, hits: bins.filter(s => classify(s.voltage)).length,
    alignedCoverage1Hz: coverage.position, infotaxisEstimate: infotaxis.position, infotaxisMap: infotaxis.map,
    infotaxisDeclared: infotaxis.declared, coverageDeclared: coverage.declared, infotaxisUsedSamples: infotaxis.usedSamples, allMissEstimate: allMiss.position })
}
if (hash.digest('hex') !== 'cb75f804c7f3ebf76b8315c3f12dcb3cefc1abcadb57056eb235aa45b1afb84d') {
  throw new Error('Flights differ from the published dataset')
}
// Load independent source coordinates only after all flight predictions are complete.
const truthText = readFileSync(join(folder, 'readme.txt'))
if (createHash('sha256').update(truthText).digest('hex') !== 'f82badd6d82c860be76f04cd31b0bdd617d077d9c5ddf4ceda9b49ea5c1cd00b') {
  throw new Error('Source reference differs from the published dataset')
}
const references = [...truthText.toString('utf8').matchAll(/\[(\d+\.\d+)\s+(\d+\.\d+)\s*\]/g)]
if (references.length !== flightCount) throw new Error('Missing reference coordinates')
const results = predictions.map(p => {
  const i = p.flight - 1
  const source = { x: Number(references[i]![1]), y: Number(references[i]![2]) }
  const error = (v: Vec2) => Math.hypot(v.x - source.x, v.y - source.y)
  return { ...p, source, rawErrorM: error(p.raw), alignedErrorM: error(p.aligned),
    alignedCoverage1HzErrorM: error(p.alignedCoverage1Hz), infotaxisEstimateErrorM: error(p.infotaxisEstimate),
    infotaxisMapErrorM: error(p.infotaxisMap), allMissErrorM: error(p.allMissEstimate),
    encounterSupportedEstimate: p.hits ? p.infotaxisEstimate : null, centreErrorM: error({ x: 6, y: 2 }) }
})
console.log(JSON.stringify({ doi: '10.5281/zenodo.17189796', publishedDelaySeconds: publishedDelay,
  protocol: legacy ? 'upstream-retrospective-v1' : 'separate-flight-frozen-blank-v1',
  commissioning: legacy ? null : { flight: commissioningFlight, policy: blankPolicy, result: frozen }, skipped, results }, null, 2))
