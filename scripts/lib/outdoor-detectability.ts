import {HalfspaceTransport} from '../../src/sim/halfspaceTransport'
import type {HalfspaceSettings, Point3} from '../../src/sim/halfspaceTransport'

export interface ConcentrationField {
  readonly measurement: 'local-mass-concentration-kg-m3'
  concentrationAt(pointMetres: Point3, seconds: number): number
}
export interface SurveyPlatform {
  readonly id: string
  poseAt(seconds: number): Point3
  distanceAt(seconds: number): number
  readonly routeLengthMetres: number
}
export interface SensorModel {
  id: string
  evidence: 'hypothetical-factorial-not-product-calibrated'
  noisePpm: number
  riseSeconds: number
  recoverySeconds: number
  delaySeconds: number
  sampleSeconds: number
  saturationPpm: number
}
export interface DetectorConfig {referencePpm: number; thresholdExcessPpm: number; consecutiveSamples: number}
export const DESIGN = {
  version: 'outdoor-detectability-pilot-v2', domainMetres: 100, durationSeconds: 600,
  sourceAgeSeconds: 600, diffusivity: 0.2, sourceSigmaMetres: 0.25,
  releaseHeightMetres: 0.025, inletHeightMetres: 0.05,
  temperatureKelvin: 298.15, pressurePascal: 101325, backgroundPpm: 2,
  referenceRateKgPerSecond: 1e-5, ratesKgPerSecond: [0, 1e-5, 1e-4, 1e-3],
  windSpeeds: [0.5, 2], robotSpeeds: [0.5, 1], thresholdMultipliers: [3, 5, 7],
  primaryThresholdMultiplier: 5, consecutiveSamples: 3,
  turnSeconds: 2, pilotWorlds: [0, 1, 2, 3], reservedTestWorldRange: [1000, 1127],
  seedBase: 927001, backgroundOffsetBoundPpm: 0.05, backgroundDriftBoundPpm: 0.05,
  resolutions: [{dt: 0.25, panel: 0.25}, {dt: 0.125, panel: 0.125}, {dt: 0.0625, panel: 0.0625}],
} as const

function positive(x: number, name: string, zero = false) {
  if (!Number.isFinite(x) || (zero ? x < 0 : x <= 0)) throw new RangeError(name)
}
export function ppmFactor(temperatureKelvin: number, pressurePascal: number) {
  positive(temperatureKelvin, 'temperature'); positive(pressurePascal, 'pressure')
  return 1e6 * 8.314462618 * temperatureKelvin / (pressurePascal * 0.01604)
}
export class HalfspaceField implements ConcentrationField {
  readonly measurement = 'local-mass-concentration-kg-m3' as const
  #kernel: HalfspaceTransport
  constructor(settings: HalfspaceSettings) {this.#kernel = new HalfspaceTransport(settings)}
  concentrationAt(p: Point3, seconds: number) {return this.#kernel.evaluate(p, seconds).concentration}
}

/** Prescribed route; concentration and source position are deliberately absent. */
export function lawnmowerPlatform(speed: number, height = DESIGN.inletHeightMetres,
  turnSeconds: number = DESIGN.turnSeconds): SurveyPlatform {
  positive(speed, 'speed'); positive(height, 'height', true); positive(turnSeconds, 'turn time', true)
  const points: Point3[] = []
  for (let i = 0; i < 10; i++) {
    const xs = i % 2 ? [95, 5] : [5, 95]
    points.push(...xs.map(x => ({x, y: 5 + 10 * i, z: height})))
  }
  const segments = points.slice(1).map((p, i) => ({from: points[i]!, to: p,
    length: Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y)}))
  const total = segments.reduce((s, x) => s + x.length, 0)
  function state(seconds: number) {
    positive(seconds, 'survey time', true)
    let left = seconds, distance = 0
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]!, duration = s.length / speed
      if (left <= duration) {
        const f = left / duration
        return {pose: {x: s.from.x + f * (s.to.x - s.from.x), y: s.from.y + f * (s.to.y - s.from.y), z: height},
          distance: distance + speed * left}
      }
      left -= duration; distance += s.length
      if (i < segments.length - 1) {
        if (left <= turnSeconds) return {pose: {...s.to}, distance}
        left -= turnSeconds
      }
    }
    return {pose: {...points[points.length - 1]!}, distance}
  }
  return {id: `prescribed-ground-${speed}mps`, routeLengthMetres: total,
    poseAt: t => state(t).pose, distanceAt: t => state(t).distance}
}

export function randomStream(seed: number) {
  if (!Number.isSafeInteger(seed) || seed <= 0 || seed > 0xffffffff) throw new RangeError('seed')
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), s | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296
  }
}
export function worldSettings(world: number) {
  if (!Number.isSafeInteger(world) || world < 0) throw new RangeError('world')
  const draw = randomStream(DESIGN.seedBase + world * 17)
  return {world, seed: DESIGN.seedBase + world * 17,
    source: {x: 10 + 80 * draw(), y: 10 + 80 * draw(), z: DESIGN.releaseHeightMetres},
    backgroundOffsetPpm: (2 * draw() - 1) * DESIGN.backgroundOffsetBoundPpm,
    backgroundDriftPpm: (2 * draw() - 1) * DESIGN.backgroundDriftBoundPpm}
}
export function normalNoise(world: number, count: number) {
  const draw = randomStream(DESIGN.seedBase + 1000000 + world * 17)
  return Array.from({length: count}, () => Math.sqrt(-2 * Math.log(draw())) * Math.cos(2 * Math.PI * draw()))
}
export function sensorModels(): SensorModel[] {
  return [0.02, 0.2, 2].flatMap(noisePpm => [0.5, 5].map(riseSeconds => ({
    id: `generic-sigma${noisePpm}-tau${riseSeconds}`, evidence: 'hypothetical-factorial-not-product-calibrated' as const,
    noisePpm, riseSeconds, recoverySeconds: riseSeconds * 2,
    delaySeconds: 1, sampleSeconds: 1, saturationPpm: 10000,
  })))
}
export function sensorReadings(inletPpm: readonly number[], dt: number, sensor: SensorModel,
  noise: readonly number[], initialPpm: number): number[] {
  positive(dt, 'dt'); positive(initialPpm, 'initial', true)
  for (const k of ['riseSeconds', 'recoverySeconds', 'sampleSeconds', 'saturationPpm'] as const) positive(sensor[k], k)
  positive(sensor.noisePpm, 'noise', true); positive(sensor.delaySeconds, 'delay', true)
  const every = sensor.sampleSeconds / dt, delay = sensor.delaySeconds / dt
  if (!Number.isInteger(every) || every < 1 || !Number.isInteger(delay) || inletPpm.length % every ||
      noise.length !== inletPpm.length / every || initialPpm >= sensor.saturationPpm ||
      !noise.every(Number.isFinite) || !inletPpm.every(x => Number.isFinite(x) && x >= 0)) throw new RangeError('Invalid sensor clock/input')
  const readings: number[] = []; let state = initialPpm
  for (let i = 0; i < inletPpm.length; i++) {
    const input = i < delay ? initialPpm : inletPpm[i - delay]!
    const tau = input >= state ? sensor.riseSeconds : sensor.recoverySeconds
    state += (input - state) * -Math.expm1(-dt / tau)
    if ((i + 1) % every === 0) readings.push(Math.min(sensor.saturationPpm,
      Math.max(0, state + sensor.noisePpm * noise[readings.length]!)))
  }
  return readings
}
/** Only measured concentration and public calibration enter this decision. */
export function firstAlarm(readings: readonly number[], sampleSeconds: number, config: DetectorConfig): number | null {
  positive(sampleSeconds, 'sample period'); positive(config.referencePpm, 'reference', true)
  positive(config.thresholdExcessPpm, 'threshold')
  if (!Number.isInteger(config.consecutiveSamples) || config.consecutiveSamples < 1 || !readings.every(Number.isFinite)) throw new RangeError('Invalid detector')
  let streak = 0
  for (let i = 0; i < readings.length; i++) {
    streak = readings[i]! > config.referencePpm + config.thresholdExcessPpm ? streak + 1 : 0
    if (streak >= config.consecutiveSamples) return (i + 1) * sampleSeconds
  }
  return null
}

export type TraceSpec = {world: number; wind: number; speed: number; resolution: number}
export function pilotSpecs(): TraceSpec[] {
  return DESIGN.pilotWorlds.flatMap(world => DESIGN.windSpeeds.flatMap(wind => DESIGN.robotSpeeds.flatMap(speed =>
    (world === 0 ? [0, 1, 2] : [0]).map(resolution => ({world, wind, speed, resolution})))))
}
export function makeTrace(spec: TraceSpec) {
  const r = DESIGN.resolutions[spec.resolution]
  if (!r || !DESIGN.windSpeeds.includes(spec.wind as 0.5 | 2) || !DESIGN.robotSpeeds.includes(spec.speed as 0.5 | 1)) throw new RangeError('Unknown trace configuration')
  const w = worldSettings(spec.world), platform = lawnmowerPlatform(spec.speed)
  const fieldSettings: HalfspaceSettings = {source: w.source, wind: {x: spec.wind, y: 0},
    diffusivity: DESIGN.diffusivity, sigma: DESIGN.sourceSigmaMetres,
    rateKgPerSecond: DESIGN.referenceRateKgPerSecond, panelSeconds: r.panel}
  const field: ConcentrationField = new HalfspaceField(fieldSettings)
  const factor = ppmFactor(DESIGN.temperatureKelvin, DESIGN.pressurePascal)
  const inlet = Array.from({length: DESIGN.durationSeconds / r.dt}, (_, i) => {
    const t = (i + 0.5) * r.dt, pose = platform.poseAt(t)
    return {t, ...pose, referenceExcessPpm: factor * field.concentrationAt(pose, t + DESIGN.sourceAgeSeconds),
      backgroundPpm: DESIGN.backgroundPpm + w.backgroundOffsetPpm + w.backgroundDriftPpm * t / DESIGN.durationSeconds}
  })
  const noise = normalNoise(spec.world, DESIGN.durationSeconds)
  const measurements = DESIGN.ratesKgPerSecond.flatMap(rate => {
    const incoming = inlet.map(p => p.backgroundPpm + p.referenceExcessPpm * rate / DESIGN.referenceRateKgPerSecond)
    return sensorModels().map(sensor => {
      const readings = sensorReadings(incoming, r.dt, sensor, noise, DESIGN.backgroundPpm)
      return {rateKgPerSecond: rate, sensor, readings,
        outcomes: DESIGN.thresholdMultipliers.map(k => {
          const alarmSeconds = firstAlarm(readings, sensor.sampleSeconds, {referencePpm: DESIGN.backgroundPpm,
            thresholdExcessPpm: k * sensor.noisePpm, consecutiveSamples: DESIGN.consecutiveSamples})
          return {k, alarmSeconds, restrictedTimeSeconds: alarmSeconds ?? DESIGN.durationSeconds}
        })}
    })
  })
  return {schemaVersion: DESIGN.version, spec, world: w, resolution: r, fieldSettings,
    ppmPerKgM3: factor, distanceMetres: platform.distanceAt(DESIGN.durationSeconds),
    routeLengthMetres: platform.routeLengthMetres, inlet, noise, measurements}
}
