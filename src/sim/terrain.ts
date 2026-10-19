import { clamp, dot, normalize } from './math'
import type { Scenario, Vec2 } from './types'

/** Reference horizontal speed for the reduced-order gravity-current drift. */
export const TERRAIN_REFERENCE_GAS_DRIFT_SPEED = 0.04
export const TERRAIN_MODEL_VERSION = 'planar-2p5d-v1'
export const ROBOT_ROLLING_RESISTANCE_COEFFICIENT = 0.03
export const ROBOT_SPEED_AT_REFERENCE_GRADE = 0.35

const radians = (degrees: number) => (degrees * Math.PI) / 180

/** Unit vector in the horizontal map pointing toward increasing elevation. */
export const terrainUphillUnit = (
  terrainUphillDirectionDegrees: number,
): Vec2 => {
  const heading = radians(terrainUphillDirectionDegrees)
  return { x: Math.sin(heading), y: -Math.cos(heading) }
}

/** Gradient of z=h(x,y), expressed as rise per horizontal map distance. */
export const terrainGradient = (
  terrainSlopeDegrees: number,
  terrainUphillDirectionDegrees: number,
): Vec2 => {
  if (terrainSlopeDegrees === 0) return { x: 0, y: 0 }
  const uphill = terrainUphillUnit(terrainUphillDirectionDegrees)
  const grade = Math.tan(radians(terrainSlopeDegrees))
  return { x: uphill.x * grade, y: uphill.y * grade }
}

/** Elevation relative to the centre of the unit-square horizontal projection. */
export const terrainHeightAt = (
  scenario: Pick<Scenario, 'terrainSlopeDegrees' | 'terrainUphillDirectionDegrees'>,
  point: Vec2,
) => {
  const gradient = terrainGradient(
    scenario.terrainSlopeDegrees,
    scenario.terrainUphillDirectionDegrees,
  )
  return gradient.x * (point.x - 0.5) + gradient.y * (point.y - 0.5)
}

/** Exact length of a straight segment constrained to the planar height field. */
export const terrainSurfaceDistance = (
  scenario: Pick<Scenario, 'terrainSlopeDegrees' | 'terrainUphillDirectionDegrees'>,
  from: Vec2,
  to: Vec2,
) => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = terrainHeightAt(scenario, to) - terrainHeightAt(scenario, from)
  return Math.hypot(dx, dy, dz)
}

/**
 * Horizontal speed ratio for a robot commanded at constant nominal surface speed.
 *
 * The exact surface-projection factor is combined with a constant-specific-power
 * closure. Required uphill force per unit weight is Crr*cos(alpha)+sin(alpha),
 * while the available power is calibrated so surface speed is 35% of nominal at
 * robotSlopeLimitDegrees. Downhill speed is capped at nominal under active braking;
 * cross-slope travel receives a bounded roll-stability derating. This is not a
 * wheel-slip or deformable-soil model.
 */
export const terrainMobilityScale = (
  scenario: Pick<
    Scenario,
    | 'terrainSlopeDegrees'
    | 'terrainUphillDirectionDegrees'
    | 'robotSlopeLimitDegrees'
  >,
  desiredDirection: Vec2,
) => {
  if (scenario.terrainSlopeDegrees === 0) return 1
  const direction = normalize(desiredDirection, { x: 0, y: 0 })
  if (Math.hypot(direction.x, direction.y) <= 1e-12) return 1
  const gradient = terrainGradient(
    scenario.terrainSlopeDegrees,
    scenario.terrainUphillDirectionDegrees,
  )
  const crossDirection = { x: -direction.y, y: direction.x }
  const longitudinalGrade = dot(gradient, direction)
  const lateralGrade = dot(gradient, crossDirection)
  const longitudinalAngle = Math.atan(longitudinalGrade)
  const lateralAngle = Math.atan(
    lateralGrade / Math.sqrt(1 + longitudinalGrade * longitudinalGrade),
  )
  const limit = Math.max(radians(scenario.robotSlopeLimitDegrees), 1e-6)
  const lateralRatio = clamp(Math.abs(lateralAngle) / limit, 0, 1.5)
  const projection = 1 / Math.sqrt(1 + longitudinalGrade * longitudinalGrade)
  const referenceForce =
    ROBOT_ROLLING_RESISTANCE_COEFFICIENT * Math.cos(limit) + Math.sin(limit)
  const availableSpecificPower = ROBOT_SPEED_AT_REFERENCE_GRADE * referenceForce
  const requiredUphillForce =
    ROBOT_ROLLING_RESISTANCE_COEFFICIENT * Math.cos(longitudinalAngle) +
    Math.max(0, Math.sin(longitudinalAngle))
  const traction = longitudinalAngle > 0
    ? Math.min(1, availableSpecificPower / Math.max(requiredUphillForce, 1e-9))
    : 1
  const stability = 1 - 0.22 * Math.min(1, lateralRatio ** 1.5)
  return clamp(projection * traction * stability, 0.08, 1)
}

/** Horizontal distance reached by a fixed surface-distance command. */
export const horizontalReachForSurfaceDistance = (
  scenario: Pick<Scenario, 'terrainSlopeDegrees' | 'terrainUphillDirectionDegrees'>,
  direction: Vec2,
  surfaceDistance: number,
) => {
  if (scenario.terrainSlopeDegrees === 0) return surfaceDistance
  const gradient = terrainGradient(
    scenario.terrainSlopeDegrees,
    scenario.terrainUphillDirectionDegrees,
  )
  const unit = normalize(direction, { x: 0, y: 0 })
  return surfaceDistance / Math.sqrt(1 + dot(gradient, unit) ** 2)
}

/** Signed near-surface gas velocity relative to the ambient air. */
export const terrainGasDrift = (
  scenario: Pick<
    Scenario,
    | 'terrainSlopeDegrees'
    | 'terrainUphillDirectionDegrees'
    | 'gasBuoyancy'
    | 'terrainGasDriftScale'
  >,
): Vec2 => {
  if (
    scenario.terrainSlopeDegrees === 0 ||
    scenario.gasBuoyancy === 'neutral' ||
    scenario.terrainGasDriftScale === 0
  ) return { x: 0, y: 0 }
  const uphill = terrainUphillUnit(scenario.terrainUphillDirectionDegrees)
  // Dense gas can form a terrain-following gravity current. The selected light
  // class uses only an additional slope-coupled near-surface depletion
  // sensitivity, not fictitious uphill flow or a general buoyancy closure.
  if (scenario.gasBuoyancy !== 'dense') return { x: 0, y: 0 }
  const speed =
    TERRAIN_REFERENCE_GAS_DRIFT_SPEED *
    scenario.terrainGasDriftScale *
    Math.sin(radians(scenario.terrainSlopeDegrees))
  return { x: -uphill.x * speed, y: -uphill.y * speed }
}

/** Heuristic additional slope-coupled loss from the represented near-surface layer. */
export const terrainNearSurfaceLossRate = (
  scenario: Pick<
    Scenario,
    'terrainSlopeDegrees' | 'gasBuoyancy' | 'terrainGasDriftScale'
  >,
) => scenario.gasBuoyancy === 'light'
  ? 0.06 * scenario.terrainGasDriftScale *
    Math.sin(radians(scenario.terrainSlopeDegrees))
  : 0
