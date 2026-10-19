import { add, clamp, dot, magnitude, normalize, rotate, scale, sub } from './math'
import { hashNumbers } from './rng'
import { terrainGasDrift, terrainNearSurfaceLossRate } from './terrain'
import type { Scenario, Vec2 } from './types'

/** Version of the deliberately reduced controller-side observation model. */
export const CONTROLLER_OBSERVATION_MODEL_VERSION = 'controller-observation-v1' as const

/** The public scenario contract: source placement is not part of the input. */
export type PublicScenario = Omit<Scenario, 'source' | 'targetStatus'>

export type ControllerObservationModel = {
  readonly version: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  /** The independent seed declared for this model, not a world/source seed. */
  readonly modelSeed: number
  readonly scenario: PublicScenario
  windAt: (point: Vec2, time: number) => Vec2
  expectedHitRate: (candidateSource: Vec2, samplePoint: Vec2, time: number) => number
}

// Frozen planning-prior parameters. These deliberately differ from both truth
// solvers: the model uses mean-flow advection and one Gaussian crosswind width,
// with no puff realization, grid state, wake field, or truth-source access.
export const CONTROLLER_OBSERVATION_MODEL_PARAMETERS = Object.freeze({
  backgroundRate: 0.006,
  amplitude: 1.1,
  minimumRate: 0.0015,
  maximumRate: 4,
  initialSpread: 0.018,
  diffusivityMultiplier: 1.35,
  turbulenceSpreadPerDistance: 0.045,
  decayLength: 0.68,
  obstacleTransmission: 0.65,
  meanderRadians: 0.08,
  gustFraction: 0.5,
})
const clonePublicScenario = (input: PublicScenario): PublicScenario => {
  if (Object.prototype.hasOwnProperty.call(input as object, 'source')) {
    throw new TypeError('ControllerObservationModel accepts a public scenario without source')
  }
  if (Object.prototype.hasOwnProperty.call(input as object, 'targetStatus')) {
    throw new TypeError('ControllerObservationModel cannot accept target-presence truth')
  }

  const clone: PublicScenario = {
    ...input,
    robotStart: { ...input.robotStart },
    baseWind: { ...input.baseWind },
    obstacles: input.obstacles.map((obstacle) => ({ ...obstacle })),
  }
  Object.freeze(clone.robotStart)
  Object.freeze(clone.baseWind)
  for (const obstacle of clone.obstacles) Object.freeze(obstacle)
  Object.freeze(clone.obstacles)
  return Object.freeze(clone)
}

const finiteWind = (wind: Vec2): Vec2 => ({
  x: Number.isFinite(wind.x) ? wind.x : 0,
  y: Number.isFinite(wind.y) ? wind.y : 0,
})

const finiteRate = (rate: number): number => (Number.isFinite(rate) ? Math.max(0, rate) : 0)

const segmentIntersectsObstacle = (a: Vec2, b: Vec2, obstacle: PublicScenario['obstacles'][number]) => {
  let lo = 0; let hi = 1
  for (const [origin, delta, minimum, maximum] of [[a.x, b.x - a.x, obstacle.x, obstacle.x + obstacle.width], [a.y, b.y - a.y, obstacle.y, obstacle.y + obstacle.height]] as const) {
    if (Math.abs(delta) <= 1e-12) { if (origin < minimum || origin > maximum) return false; continue }
    let entry = (minimum - origin) / delta; let exit = (maximum - origin) / delta
    if (entry > exit) [entry, exit] = [exit, entry]
    lo = Math.max(lo, entry); hi = Math.min(hi, exit); if (lo > hi) return false
  }
  return true
}

const windEquation = (scenario: PublicScenario, seed: number, point: Vec2, time: number): Vec2 => {
  const phase = hashNumbers(seed, 0x4f42_534d) / 4_294_967_296 * Math.PI * 2
  const meander =
    CONTROLLER_OBSERVATION_MODEL_PARAMETERS.meanderRadians *
    scenario.turbulence *
    Math.sin(time * 0.079 + point.y * 2.7 + phase)
  const gust = 1 +
    CONTROLLER_OBSERVATION_MODEL_PARAMETERS.gustFraction *
    scenario.gustStrength *
    Math.sin(time * 0.137 + point.x * 3.1 + phase * 0.63)
  return scale(rotate(scenario.baseWind, meander), Math.max(0.2, gust))
}

/**
 * Construct the versioned model used by controllers for wind and inverse hit
 * likelihoods. It makes no claim to reproduce the numerical truth plume: it
 * is a reduced analytical assumption based only on public flow parameters.
 */
export const createControllerObservationModel = (
  input: PublicScenario,
  modelSeed: number,
): ControllerObservationModel => {
  if (!Number.isInteger(modelSeed)) throw new RangeError('modelSeed must be an integer')
  const scenario = clonePublicScenario(input)
  const expectedHitRate = (candidateSource: Vec2, samplePoint: Vec2, time: number) => {
    const transport = add(windEquation(scenario, modelSeed, samplePoint, time), terrainGasDrift(scenario))
    const downwind = normalize(transport, normalize(scenario.baseWind)); const relative = sub(samplePoint, candidateSource)
    const along = dot(relative, downwind); const cross = Math.abs(dot(relative, { x: -downwind.y, y: downwind.x }))
    const model = CONTROLLER_OBSERVATION_MODEL_PARAMETERS
    if (along < -0.02) return model.minimumRate
    const effectiveAlong = Math.max(0.006, along)
    const travelTime = effectiveAlong / Math.max(0.006, magnitude(transport))
    const spread =
      model.initialSpread +
      Math.sqrt(
        2 * scenario.diffusivity * model.diffusivityMultiplier * (travelTime + 0.25),
      ) +
      effectiveAlong * scenario.turbulence * model.turbulenceSpreadPerDistance
    const lateral = Math.exp(-(cross * cross) / (2 * spread * spread))
    const decay =
      Math.exp(-effectiveAlong / model.decayLength) /
      (1 + effectiveAlong / 0.25)
    const retention = Math.exp(-terrainNearSurfaceLossRate(scenario) * travelTime)
    let signal = model.amplitude * lateral * decay * retention
    if (scenario.kind === 'obstructed') {
      for (const obstacle of scenario.obstacles) {
        if (segmentIntersectsObstacle(candidateSource, samplePoint, obstacle)) {
          signal *= model.obstacleTransmission
        }
      }
    }
    return clamp(
      (model.backgroundRate + signal) * scenario.emissionRateScale,
      model.minimumRate,
      model.maximumRate,
    )
  }

  return Object.freeze({
    version: CONTROLLER_OBSERVATION_MODEL_VERSION,
    modelSeed,
    scenario,
    windAt: (point: Vec2, time: number) => finiteWind(windEquation(scenario, modelSeed, point, time)),
    expectedHitRate: (candidateSource: Vec2, samplePoint: Vec2, time: number) => finiteRate(expectedHitRate(candidateSource, samplePoint, time)),
  })
}
