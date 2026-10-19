import { add, clamp, distance, dot, normalize, pointInObstacle, rotate, scale } from './math'
import type { ControllerObservationModel } from './controllerObservationModel'
import { horizontalReachForSurfaceDistance, terrainMobilityScale } from './terrain'
import type { AlgorithmEnvironment, InspectionContract, LocalScanPolicy, Scenario, Vec2 } from './types'

export const ROBOT_CLEARANCE = 0.014

export const createEnvironment = (
  scenario: Scenario,
  controllerSeed: number,
  observationModel: ControllerObservationModel,
  maxSpeed: number,
  durationSeconds = 180,
  activeSniffEnabled = true,
  activeSniffCycleSeconds = 0.75,
  activeSniffReach = 0.065,
  sensorNoise = 0.025,
  physical?: { clearance: number; inspection: InspectionContract; scanPolicy?: LocalScanPolicy;
    gradientEstimator?: 'relative-geometry-v1'; candidateLifecycle?: AlgorithmEnvironment['candidateLifecycle'];
    acquisitionPolicy?: AlgorithmEnvironment['acquisitionPolicy']; bearingGeometry?: AlgorithmEnvironment['bearingGeometry'];
    bearingAblation?: AlgorithmEnvironment['bearingAblation']; rayWindowPolicy?: AlgorithmEnvironment['rayWindowPolicy'];
    localGradientPolicy?: AlgorithmEnvironment['localGradientPolicy']; localMaximum?: AlgorithmEnvironment['localMaximum'] },
): AlgorithmEnvironment => {
  const robotClearance = physical?.clearance ?? ROBOT_CLEARANCE
  const {
    source: _hiddenSource,
    targetStatus: _hiddenTargetStatus,
    ...publicScenario
  } = scenario
  const observableScenario: Omit<Scenario, 'source' | 'targetStatus'> = {
    ...publicScenario,
    robotStart: { ...publicScenario.robotStart },
    baseWind: { ...publicScenario.baseWind },
    obstacles: publicScenario.obstacles.map((obstacle) => ({ ...obstacle })),
  }
  Object.freeze(observableScenario.robotStart)
  Object.freeze(observableScenario.baseWind)
  for (const obstacle of observableScenario.obstacles) Object.freeze(obstacle)
  Object.freeze(observableScenario.obstacles)
  Object.freeze(observableScenario)
  const isBlocked = (point: Vec2, clearance = robotClearance) => {
    if (
      point.x < clearance ||
      point.x > 1 - clearance ||
      point.y < clearance ||
      point.y > 1 - clearance
    ) {
      return true
    }
    return scenario.obstacles.some((obstacle) => pointInObstacle(point, obstacle, clearance))
  }

  const safeDirection = (from: Vec2, desired: Vec2) => {
    const preferred = normalize(desired)
    const lookAhead = 0.034
    if (!isBlocked(add(from, scale(preferred, lookAhead)))) return preferred

    // A purely reactive left/right deflection can chatter against a long wall:
    // the preferred direction is recomputed every sample and the robot keeps
    // swapping sides. When the near probe falls inside a known obstacle, steer
    // first to the nearer inflated corner on the approach face. Re-evaluating
    // this stateless rule each step gives stable wall following without doing
    // any source-aware path planning for the localization algorithm.
    const probe = add(from, scale(preferred, lookAhead))
    const bypassClearance = robotClearance + 0.012
    const blockingObstacle = scenario.obstacles
      .filter((obstacle) => pointInObstacle(probe, obstacle, robotClearance))
      .sort((first, second) => {
        const firstCenter = {
          x: first.x + first.width / 2,
          y: first.y + first.height / 2,
        }
        const secondCenter = {
          x: second.x + second.width / 2,
          y: second.y + second.height / 2,
        }
        return distance(probe, firstCenter) - distance(probe, secondCenter) ||
          first.id.localeCompare(second.id)
      })[0]
    if (blockingObstacle) {
      const left = blockingObstacle.x - bypassClearance
      const right = blockingObstacle.x + blockingObstacle.width + bypassClearance
      const top = blockingObstacle.y - bypassClearance
      const bottom = blockingObstacle.y + blockingObstacle.height + bypassClearance
      const horizontallyApproaching = Math.abs(preferred.x) >= Math.abs(preferred.y)
      const approachX = preferred.x >= 0 ? left : right
      const approachY = preferred.y >= 0 ? top : bottom
      const cornerCandidates: Vec2[] = horizontallyApproaching
        ? [
            { x: approachX, y: top },
            { x: approachX, y: bottom },
          ]
        : [
            { x: left, y: approachY },
            { x: right, y: approachY },
          ]

      let bestBypass: Vec2 | null = null
      let bestBypassScore = Number.POSITIVE_INFINITY
      for (const candidate of cornerCandidates) {
        const bounded = {
          x: clamp(candidate.x, bypassClearance, 1 - bypassClearance),
          y: clamp(candidate.y, bypassClearance, 1 - bypassClearance),
        }
        if (isBlocked(bounded, ROBOT_CLEARANCE * 0.5)) continue
        const candidateDirection = normalize({ x: bounded.x - from.x, y: bounded.y - from.y })
        const nextProbe = add(from, scale(candidateDirection, lookAhead))
        if (isBlocked(nextProbe)) continue
        const alignmentPenalty = (1 - dot(preferred, candidateDirection)) * 0.045
        const score = distance(from, bounded) + alignmentPenalty
        if (score < bestBypassScore) {
          bestBypassScore = score
          bestBypass = candidateDirection
        }
      }
      if (bestBypass) return bestBypass
    }

    let bestDirection: Vec2 = { x: 0, y: 0 }
    let bestScore = -Infinity
    const rotations = [Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3, Math.PI / 2, -Math.PI / 2, Math.PI]
    for (const angle of rotations) {
      const candidate = rotate(preferred, angle)
      if (isBlocked(add(from, scale(candidate, lookAhead)))) continue
      const clearanceProbe = add(from, scale(candidate, lookAhead * 1.8))
      const score = dot(preferred, candidate) + (isBlocked(clearanceProbe) ? -0.35 : 0.1)
      if (score > bestScore) {
        bestScore = score
        bestDirection = candidate
      }
    }
    return bestDirection
  }

  return Object.freeze({
    ...(physical?.gradientEstimator ? { gradientEstimator: physical.gradientEstimator } : {}),
    ...(physical?.bearingAblation ? { bearingAblation: physical.bearingAblation } : {}),
    ...(physical?.bearingGeometry ? { bearingGeometry: physical.bearingGeometry } : {}),
    ...(physical?.acquisitionPolicy ? { acquisitionPolicy: physical.acquisitionPolicy } : {}),
    ...(physical?.rayWindowPolicy ? { rayWindowPolicy: physical.rayWindowPolicy } : {}),
    ...(physical?.localGradientPolicy ? { localGradientPolicy: physical.localGradientPolicy } : {}),
    ...(physical?.localMaximum ? {localMaximum:Object.freeze({...physical.localMaximum})} : {}),
    ...(physical?.candidateLifecycle ? { candidateLifecycle: Object.freeze({ ...physical.candidateLifecycle }) } : {}),
    ...(physical?.scanPolicy ? { localScanPolicy: Object.freeze({ ...physical.scanPolicy }) } : {}),
    ...(physical ? { inspectionContract: Object.freeze({ ...physical.inspection }) } : {}),
    scenario: observableScenario,
    controllerSeed,
    observationModelVersion: observationModel.version,
    observationModelSeed: observationModel.modelSeed,
    maxSpeed,
    durationSeconds,
    activeSniffEnabled,
    activeSniffCycleSeconds,
    activeSniffReach,
    sensorNoise,
    isBlocked,
    windAt: (point, time) => observationModel.windAt(point, time),
    expectedHitRate: (candidateSource, samplePoint, time) =>
      observationModel.expectedHitRate(candidateSource, samplePoint, time),
    safeDirection,
    terrainMobilityScale: (direction) => terrainMobilityScale(scenario, direction),
    horizontalReachForSurfaceDistance: (direction, surfaceDistance) =>
      horizontalReachForSurfaceDistance(scenario, direction, surfaceDistance),
  })
}

export const clampToDomain = (point: Vec2): Vec2 => ({
  x: clamp(point.x, ROBOT_CLEARANCE, 1 - ROBOT_CLEARANCE),
  y: clamp(point.y, ROBOT_CLEARANCE, 1 - ROBOT_CLEARANCE),
})
