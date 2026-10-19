import {DESIGN, HalfspaceField, lawnmowerPlatform, worldSettings, normalNoise,
  sensorModels, sensorReadings, firstAlarm, ppmFactor} from './outdoor-detectability'
import type {TraceSpec} from './outdoor-detectability'

export const BUDGET = {
  version: 'outdoor-mission-budget-development-v1', pilotWorlds: [200, 201, 202, 203],
  reservedWorldRange: [2000, 2127], reservedWitnessWorlds: [2000, 2042, 2085, 2127],
  shortSeconds: 600, ratesKgPerSecond: [0, 1e-4], noisePpm: 0.2, k: 5,
  backgroundDriftDenominatorSeconds: 600, workers: 4, maxRuntimeSeconds: 1800,
  campaignEnabled: false, paidLaunchAuthorized: false,
} as const

export function duration(speed: number) {
  if (speed !== 0.5 && speed !== 1) throw new RangeError('Unsupported speed')
  return 990 / speed + 18 * 2
}
export const budgetSensors = () => sensorModels().filter(s => s.noisePpm === BUDGET.noisePpm)
export function budgetSpecs(): TraceSpec[] {
  return BUDGET.pilotWorlds.flatMap(world => DESIGN.windSpeeds.flatMap(wind => DESIGN.robotSpeeds.flatMap(speed =>
    (world === 200 ? [0, 1, 2] : [0]).map(resolution => ({world, wind, speed, resolution})))))
}
export function scoreBudgets(readings: number[], end: number, speed: number) {
  if (readings.length !== end || end !== duration(speed)) throw new RangeError('Incomplete mission')
  return [600, end].map(budgetSeconds => {
    const alarmSeconds = firstAlarm(readings.slice(0, budgetSeconds), 1,
      {referencePpm: 2, thresholdExcessPpm: BUDGET.k * BUDGET.noisePpm, consecutiveSamples: 3})
    return {budgetSeconds, alarmSeconds, restrictedTimeSeconds: alarmSeconds ?? budgetSeconds,
      distanceMetres: lawnmowerPlatform(speed).distanceAt(budgetSeconds)}
  })
}
export function makeBudgetTrace(spec: TraceSpec) {
  if (!BUDGET.pilotWorlds.includes(spec.world as 200) || !DESIGN.windSpeeds.includes(spec.wind as 0.5) ||
    !Number.isInteger(spec.resolution) || !DESIGN.resolutions[spec.resolution]) throw new RangeError('Not a development case')
  const r = DESIGN.resolutions[spec.resolution]!, end = duration(spec.speed), w = worldSettings(spec.world)
  const platform = lawnmowerPlatform(spec.speed)
  const fieldSettings = {source: w.source, wind: {x: spec.wind, y: 0}, diffusivity: DESIGN.diffusivity,
    sigma: DESIGN.sourceSigmaMetres, rateKgPerSecond: DESIGN.referenceRateKgPerSecond, panelSeconds: r.panel}
  const field = new HalfspaceField(fieldSettings), factor = ppmFactor(DESIGN.temperatureKelvin, DESIGN.pressurePascal)
  const inlet = Array.from({length: end / r.dt}, (_, i) => {
    const t = (i + .5) * r.dt, pose = platform.poseAt(t)
    return {t, ...pose, referenceExcessPpm: factor * field.concentrationAt(pose, t + DESIGN.sourceAgeSeconds),
      backgroundPpm: DESIGN.backgroundPpm + w.backgroundOffsetPpm + w.backgroundDriftPpm * t / 600}
  })
  const noise = normalNoise(spec.world, end)
  const measurements = BUDGET.ratesKgPerSecond.flatMap(rate => {
    const input = inlet.map(p => p.backgroundPpm + p.referenceExcessPpm * rate / DESIGN.referenceRateKgPerSecond)
    return budgetSensors().map(sensor => {
      const readings = sensorReadings(input, r.dt, sensor, noise, DESIGN.backgroundPpm)
      return {rateKgPerSecond: rate, sensor, readings, outcomes: scoreBudgets(readings, end, spec.speed)}
    })
  })
  const sourceProbes = [.125, 600.125, end + .125].flatMap(t => [[0, 0], [.25, 0], [1, 0], [0, .25]].map(([dx, dy]) => {
    const point = {x: w.source.x + dx!, y: w.source.y + dy!, z: DESIGN.inletHeightMetres}
    return {t, ...point, referenceExcessPpm: factor * field.concentrationAt(point, DESIGN.sourceAgeSeconds + t)}
  }))
  return {schemaVersion: BUDGET.version, spec, world: w, resolution: r, durationSeconds: end,
    fieldSettings, ppmPerKgM3: factor, inlet, noise, measurements, sourceProbes,
    endpoint: platform.poseAt(end), distanceMetres: platform.distanceAt(end), routeLengthMetres: platform.routeLengthMetres}
}
