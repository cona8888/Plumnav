import {DESIGN, HalfspaceField, lawnmowerPlatform, worldSettings, normalNoise, sensorReadings, ppmFactor} from './outdoor-detectability'
import type {TraceSpec} from './outdoor-detectability'
import {BUDGET, duration, budgetSensors, scoreBudgets} from './outdoor-budget'

export const CAMPAIGN = {
  version: 'outdoor-mission-budget-campaign-v1', worlds: [2000, 2127],
  witnessWorlds: [2000, 2042, 2085, 2127], primaryHistories: 512, totalHistories: 544,
  primaryOutcomes: 4096, independentWorlds: 128, workers: 4, maxRuntimeSeconds: 3600,
  primary: {wind: .5, speed: 1, sensor: 'generic-sigma0.2-tau0.5', rateKgPerSecond: 1e-4,
    endpoints: ['additional-detection', 'additional-blank-alarm'], direction: 'full-minus-600s',
    interval: 'Clopper-Pearson-97.5-percent-per-endpoint', familyCoverage: .95},
  paidLaunchAuthorized: false, physicalValidation: false,
} as const
export type Mode = 'smoke' | 'campaign'
export function campaignSpecs(mode: Mode): TraceSpec[] {
  if (mode !== 'smoke' && mode !== 'campaign') throw Error('Unknown mode')
  const worlds = mode === 'smoke' ? [200] : Array.from({length: 128}, (_, i) => i + 2000)
  return worlds.flatMap(world => DESIGN.windSpeeds.flatMap(wind => DESIGN.robotSpeeds.flatMap(speed =>
    (mode === 'campaign' && CAMPAIGN.witnessWorlds.includes(world as 2000) ? [0,1,2] : [0])
      .map(resolution => ({world, wind, speed, resolution})))))
}
/** Scientific body copied verbatim from the frozen development implementation.
 * Only case admission and the schema version differ; smoke verifies every field. */
export function makeCampaignTrace(spec: TraceSpec, mode: Mode) {
  if (!campaignSpecs(mode).some(s => s.world === spec.world && s.wind === spec.wind &&
    s.speed === spec.speed && s.resolution === spec.resolution)) throw Error('Unregistered campaign case')
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
  return {schemaVersion: CAMPAIGN.version, spec, world: w, resolution: r, durationSeconds: end,
    fieldSettings, ppmPerKgM3: factor, inlet, noise, measurements, sourceProbes,
    endpoint: platform.poseAt(end), distanceMetres: platform.distanceAt(end), routeLengthMetres: platform.routeLengthMetres}
}

