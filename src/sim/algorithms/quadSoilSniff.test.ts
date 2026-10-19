import { describe, expect, it } from 'vitest'
import { distance } from '../math'
import type {
  AlgorithmEnvironment,
  AlgorithmStepInput,
  Observation,
  QuadSniffChannelReading,
  Vec2,
} from '../types'
import {
  QuadSoilSniffController,
  buildAdaptiveConfirmationWaypoints,
  evaluateQuadCandidateFormation,
  evaluateQuadDeclarationEvidence,
  estimateQuadGradient,
  intersectGradientRays,
  inferSourceRangeAlongBearing,
  inferSourceCorridorBelief,
  evaluateQuadSpatialBracket,
  retainStrongestGeometryRay,
  selectAdaptiveQuadViewpoint,
  selectGeometryConditionedQuadViewpoint,
  windConstrainedSourceDirection,
  type GradientRay,
} from './quadSoilSniff'

describe('wind-constrained source bearing', () => {
  it('always retains an upwind component while using crosswind gradient sign', () => {
    const direction = windConstrainedSourceDirection({ x: 0, y: 1 }, { x: -2, y: 0 })
    expect(direction.x).toBeGreaterThan(0)
    expect(direction.y).toBeGreaterThan(0)
    expect(Math.hypot(direction.x, direction.y)).toBeCloseTo(1, 12)
  })

  it('reduces to upwind when the gradient has no transverse component', () => {
    expect(windConstrainedSourceDirection({ x: -1, y: 0 }, { x: -2, y: 0 }))
      .toEqual({ x: 1, y: 0 })
  })

  it('recovers range from a manufactured truth-blind encounter likelihood', () => {
    const environment = {
      isBlocked: () => false,
      expectedHitRate: (candidate: Vec2) =>
        4 * Math.exp(-(((candidate.x - 0.8) / 0.045) ** 2)),
    } as unknown as AlgorithmEnvironment
    const observations = Array.from({ length: 8 }, (_, index) => ({
      time: index,
      position: { x: 0.2, y: 0.5 },
      concentration: 1,
      hit: true,
      wind: { x: -1, y: 0 },
      valid: true,
      sampleMode: 'passive',
    })) as Observation[]
    const belief = inferSourceRangeAlongBearing(
      environment, observations, { x: 0.1, y: 0.5 }, { x: 1, y: 0 },
    )
    expect(belief).not.toBeNull()
    expect(belief!.estimate.x).toBeCloseTo(0.8, 1)
    expect(belief!.hits).toBe(8)
  })

  it('recovers a 2-D mode from intersecting uncertain bearing corridors', () => {
    const target = { x: 0.82, y: 0.38 }
    const environment = {
      isBlocked: () => false,
      expectedHitRate: (candidate: Vec2) =>
        5 * Math.exp(-((distance(candidate, target) / 0.055) ** 2)),
    } as unknown as AlgorithmEnvironment
    const observations = Array.from({ length: 16 }, (_, index) => ({
      time: index,
      position: { x: 0.25 + index * 0.01, y: 0.55 },
      concentration: 1,
      hit: true,
      wind: { x: -1, y: 0 },
      valid: true,
      sampleMode: 'passive',
    })) as Observation[]
    const rays: GradientRay[] = [
      { time: 1, origin: { x: 0.22, y: 0.55 }, direction: { x: 0.95, y: -0.20 }, weight: 0.7 },
      { time: 2, origin: { x: 0.40, y: 0.70 }, direction: { x: 0.78, y: -0.63 }, weight: 0.8 },
      { time: 3, origin: { x: 0.52, y: 0.25 }, direction: { x: 0.93, y: 0.37 }, weight: 0.75 },
    ]
    const belief = inferSourceCorridorBelief(environment, observations, rays)
    expect(belief).not.toBeNull()
    expect(distance(belief!.estimate, target)).toBeLessThan(0.06)
    expect(belief!.accepted).toBe(true)
    expect(belief!.rays).toBe(3)
  })

  it('does not form a corridor posterior from one bearing', () => {
    const environment = {
      isBlocked: () => false,
      expectedHitRate: () => 1,
    } as unknown as AlgorithmEnvironment
    expect(inferSourceCorridorBelief(environment, [], [
      { time: 1, origin: { x: 0.2, y: 0.5 }, direction: { x: 1, y: 0 }, weight: 1 },
    ])).toBeNull()
  })
})

describe('dimensionless paired spatial bracket', () => {
  const candidate = { x: 0.5, y: 0.5 }
  const positions = [
    { x: 0.445, y: 0.5 },
    { x: 0.555, y: 0.5 },
    { x: 0.5, y: 0.445 },
    { x: 0.5, y: 0.555 },
  ]
  const makeSamples = (scale = 1, localMaximum = true) => {
    const samples: Array<{ time: number; position: Vec2; concentration: number; hit: boolean }> = []
    let time = 0
    positions.forEach((position) => {
      samples.push({ time, position: candidate, concentration: scale, hit: true })
      time += 1
      samples.push({ time, position, concentration: scale * (localMaximum ? 0.4 : 1), hit: true })
      time += 1
      samples.push({ time, position: candidate, concentration: scale, hit: true })
      time += 1
      samples.push({ time, position, concentration: scale * (localMaximum ? 0.45 : 1), hit: true })
      time += 1
    })
    return samples
  }

  it('accepts replicated centre-over-flank ranks independent of signal scale', () => {
    const strong = evaluateQuadSpatialBracket(makeSamples(1), candidate, { x: 1, y: 0 }, 0)
    const weak = evaluateQuadSpatialBracket(makeSamples(0.08), candidate, { x: 1, y: 0 }, 0)
    expect(strong.ready).toBe(true)
    expect(weak.ready).toBe(true)
    expect(strong.directionalWins).toBe(4)
    expect(strong.pairCount).toBeGreaterThanOrEqual(8)
  })

  it('rejects a spatially flat field despite hits at every pose', () => {
    const evidence = evaluateQuadSpatialBracket(
      makeSamples(1, false), candidate, { x: 1, y: 0 }, 0,
    )
    expect(evidence.ready).toBe(false)
    expect(evidence.directionalWins).toBe(0)
  })
})

describe('uncensored Quad candidate-formation evidence', () => {
  const ray = {
    point: { x: 0.4, y: 0.6 },
    residual: 0.04,
    geometryQuality: 0.8,
    forwardFraction: 0.75,
    poseSpan: 0.12,
    quality: 0.31,
    rayCount: 4,
  }

  it('distinguishes no provisional intersection from every downstream rejection', () => {
    const status = evaluateQuadCandidateFormation({
      gradientRayPoolCount: 2,
      ray: null,
      surfaceSupportCount: 9,
    })
    expect(status.provisionalCandidate).toBeNull()
    expect(status.gradientRayPoolCount).toBe(2)
    expect(status.surfaceSupportCount).toBe(0)
    expect(status.gatesPassed).toBe(0)
    expect(Object.values(status.gates).every((gate) => !gate)).toBe(true)
  })

  it('reports simultaneous count, quality, residual, and support failures without censoring values', () => {
    const status = evaluateQuadCandidateFormation({
      gradientRayPoolCount: 3,
      ray: { ...ray, rayCount: 3, quality: 0.2, residual: 0.08 },
      surfaceSupportCount: 0,
    })
    expect(status.provisionalCandidate).toEqual(ray.point)
    expect(status.provisionalRayCount).toBe(3)
    expect(status.provisionalRayQuality).toBe(0.2)
    expect(status.provisionalRayResidual).toBe(0.08)
    expect(status.gates).toEqual({
      'provisional-ray': true,
      'ray-count': true,
      'ray-quality': false,
      'ray-residual': false,
      'surface-support': false,
    })
    expect(status.trustedCandidate).toBe(false)
  })

  it('reports all five formation gates when geometry and surface support pass', () => {
    const status = evaluateQuadCandidateFormation({
      gradientRayPoolCount: 6,
      ray,
      surfaceSupportCount: 1,
    })
    expect(status.gatesPassed).toBe(5)
    expect(status.trustedCandidate).toBe(true)
  })

  it('uses a sound three-ray candidate for navigation without weakening the surface declaration safeguard', () => {
    const status = evaluateQuadCandidateFormation({
      gradientRayPoolCount: 3,
      ray: { ...ray, rayCount: 3 },
      surfaceSupportCount: 0,
    })
    expect(status.gates).toMatchObject({
      'provisional-ray': true,
      'ray-count': true,
      'ray-quality': true,
      'ray-residual': true,
      'surface-support': false,
    })
    expect(status.gatesPassed).toBe(4)
    expect(status.trustedCandidate).toBe(true)
  })

  it('preserves the frozen M7 candidate rule for the paired legacy comparator', () => {
    const status = evaluateQuadCandidateFormation({
      gradientRayPoolCount: 3,
      ray: { ...ray, rayCount: 3 },
      surfaceSupportCount: 0,
      policy: 'legacy-four-ray-surface',
    })
    expect(status.gates['ray-count']).toBe(false)
    expect(status.gates['surface-support']).toBe(false)
    expect(status.trustedCandidate).toBe(false)
  })
})

const reading = (
  channel: QuadSniffChannelReading['channel'],
  direction: Vec2,
  concentration: number,
  support = 1,
): QuadSniffChannelReading => ({
  channel,
  direction,
  concentration,
  hit: concentration >= 0.1,
  reach: 0.06,
  support,
  effectiveOffset: { x: direction.x * 0.06, y: direction.y * 0.06 },
  integrationSamples: 4,
  effectiveIntegrationSamples: 3.6,
})

const cardinalReadings = (common = 0) => [
  reading('front', { x: 1, y: 0 }, common + 0.8),
  reading('left', { x: 0, y: 1 }, common + 0.6),
  reading('aft', { x: -1, y: 0 }, common + 0.2),
  reading('right', { x: 0, y: -1 }, common + 0.4),
]

describe('quadrature gradient estimator', () => {
  it('recovers opposing-pair direction and rejects a common-mode offset', () => {
    const baseline = estimateQuadGradient(cardinalReadings())
    const shifted = estimateQuadGradient(cardinalReadings(3.7))

    expect(baseline.validDirection).toBe(true)
    expect(baseline.direction.x).toBeCloseTo(3 / Math.sqrt(10), 6)
    expect(baseline.direction.y).toBeCloseTo(1 / Math.sqrt(10), 6)
    expect(shifted.direction.x).toBeCloseTo(baseline.direction.x, 8)
    expect(shifted.direction.y).toBeCloseTo(baseline.direction.y, 8)
    expect(shifted.gradient.x).toBeCloseTo(baseline.gradient.x, 8)
    expect(shifted.gradient.y).toBeCloseTo(baseline.gradient.y, 8)
  })

  it('abstains when obstacle support leaves only a one-dimensional baseline', () => {
    const estimate = estimateQuadGradient([
      reading('front', { x: 1, y: 0 }, 0.8),
      reading('left', { x: 0, y: 1 }, 0.6, 0.02),
      reading('aft', { x: -1, y: 0 }, 0.2),
      reading('right', { x: 0, y: -1 }, 0.4, 0.02),
    ])

    expect(estimate.usableChannels).toBe(2)
    expect(estimate.validDirection).toBe(false)
    expect(estimate.geometryQuality).toBe(0)
  })

  it('treats a strong symmetric return as common signal, not a direction', () => {
    const estimate = estimateQuadGradient([
      reading('front', { x: 1, y: 0 }, 0.75),
      reading('left', { x: 0, y: 1 }, 0.75),
      reading('aft', { x: -1, y: 0 }, 0.75),
      reading('right', { x: 0, y: -1 }, 0.75),
    ])

    expect(estimate.commonMean).toBeCloseTo(0.75)
    expect(estimate.normalizedContrast).toBe(0)
    expect(estimate.validDirection).toBe(false)
  })

  it('recovers a linear field with unequal support and clipped-kernel centroids', () => {
    const gradient = { x: 1.8, y: -0.7 }
    const channel = (
      id: QuadSniffChannelReading['channel'],
      direction: Vec2,
      effectiveOffset: Vec2,
      support: number,
    ): QuadSniffChannelReading => ({
      channel: id,
      direction,
      reach: 0.06,
      support,
      effectiveOffset,
      concentration:
        0.55 + gradient.x * effectiveOffset.x + gradient.y * effectiveOffset.y,
      hit: true,
      integrationSamples: 4,
      effectiveIntegrationSamples: 3.6,
    })
    const estimate = estimateQuadGradient([
      channel('front', { x: 1, y: 0 }, { x: 0.045, y: 0.006 }, 0.62),
      channel('left', { x: 0, y: 1 }, { x: -0.004, y: 0.052 }, 0.84),
      channel('aft', { x: -1, y: 0 }, { x: -0.058, y: -0.002 }, 1),
      channel('right', { x: 0, y: -1 }, { x: 0.008, y: -0.031 }, 0.44),
    ])

    expect(estimate.validDirection).toBe(true)
    expect(estimate.direction.x).toBeCloseTo(gradient.x / Math.hypot(gradient.x, gradient.y), 8)
    expect(estimate.direction.y).toBeCloseTo(gradient.y / Math.hypot(gradient.x, gradient.y), 8)
  })

  it('does not infer a direction from saturated channels', () => {
    const saturated = cardinalReadings().map((item) => ({ ...item, saturated: true }))
    const estimate = estimateQuadGradient(saturated)
    expect(estimate.validDirection).toBe(false)
    expect(estimate.usableChannels).toBe(0)
  })

  it('abstains when contrast is weak relative to configured channel noise', () => {
    const weak = estimateQuadGradient([
      reading('front', { x: 1, y: 0 }, 0.204),
      reading('left', { x: 0, y: 1 }, 0.202),
      reading('aft', { x: -1, y: 0 }, 0.196),
      reading('right', { x: 0, y: -1 }, 0.198),
    ], 0.025)
    expect(weak.gradientSnr).toBeLessThan(3.03)
    expect(weak.validDirection).toBe(false)
  })
})

describe('multi-pose gradient-ray estimate', () => {
  it('intersects separated forward rays at the surface candidate', () => {
    const target = { x: 0.72, y: 0.31 }
    const origins = [
      { x: 0.2, y: 0.2 },
      { x: 0.35, y: 0.62 },
      { x: 0.62, y: 0.72 },
      { x: 0.82, y: 0.55 },
    ]
    const rays: GradientRay[] = origins.map((origin, index) => ({
      time: index,
      origin,
      direction: { x: target.x - origin.x, y: target.y - origin.y },
      weight: 0.8,
    }))

    const estimate = intersectGradientRays(rays)
    expect(estimate).not.toBeNull()
    expect(estimate!.point.x).toBeCloseTo(target.x, 8)
    expect(estimate!.point.y).toBeCloseTo(target.y, 8)
    expect(estimate!.forwardFraction).toBe(1)
    expect(estimate!.rayCount).toBe(4)
  })

  it('does not claim a candidate from parallel gradients', () => {
    const rays: GradientRay[] = [0.2, 0.4, 0.6].map((y, index) => ({
      time: index,
      origin: { x: 0.1, y },
      direction: { x: 1, y: 0 },
      weight: 1,
    }))
    expect(intersectGradientRays(rays)).toBeNull()
  })
})

describe('M9 adaptive public-viewpoint geometry', () => {
  const environment = {
    scenario: {
      robotStart: { x: 0.5, y: 0.5 },
      baseWind: { x: 0.2, y: 0 },
      obstacles: [],
    },
    controllerSeed: 2,
    observationModelVersion: 'test',
    observationModelSeed: 7,
    maxSpeed: 0.08,
    durationSeconds: 180,
    activeSniffEnabled: true,
    activeSniffCycleSeconds: 0.75,
    activeSniffReach: 0.06,
    sensorNoise: 0.025,
    isBlocked: (point: Vec2) => point.y < 0.49,
    windAt: (point: Vec2) => ({ x: 0.12 + point.y * 0.16, y: 0 }),
    expectedHitRate: () => 0,
    safeDirection: (_from: Vec2, desired: Vec2) => desired,
    terrainMobilityScale: () => 1,
    horizontalReachForSurfaceDistance: (_direction: Vec2, reach: number) => reach,
  } as unknown as AlgorithmEnvironment

  it('selects a separated, ventilated, unblocked viewpoint without target truth', () => {
    const anchor = { x: 0.5, y: 0.5 }
    const selection = selectAdaptiveQuadViewpoint({
      environment,
      currentPosition: anchor,
      anchor,
      cueDirection: { x: 1, y: 0 },
      measuredWind: { x: 0.2, y: 0 },
      rays: [{ time: 1, origin: anchor, direction: { x: 1, y: 0 }, weight: 0.7 }],
      preferredSide: 1,
    })
    expect(selection).not.toBeNull()
    expect(environment.isBlocked(selection!.target)).toBe(false)
    expect(distance(selection!.target, anchor)).toBeGreaterThanOrEqual(0.049)
    expect(selection!.target.y).toBeGreaterThan(0.5)
    expect(selection!.localClearanceFraction).toBeGreaterThan(0)
    expect(selection!.windCorridorFraction).toBeGreaterThan(0)
  })

  it('alternates passive core and ring confirmation poses', () => {
    const candidate = { x: 0.52, y: 0.48 }
    const waypoints = buildAdaptiveConfirmationWaypoints(candidate, { x: 0.2, y: 0 }, 1)
    expect(waypoints).toHaveLength(9)
    expect(waypoints[0]).toEqual(candidate)
    expect(waypoints[2]).toEqual(candidate)
    expect(waypoints[4]).toEqual(candidate)
    expect(distance(waypoints[1]!, candidate)).toBeCloseTo(0.055, 10)
    expect(distance(waypoints[3]!, candidate)).toBeCloseTo(0.055, 10)
    expect(distance(waypoints[5]!, candidate)).toBeCloseTo(0.055, 10)
    expect(distance(waypoints[7]!, candidate)).toBeCloseTo(0.055, 10)
  })
})

describe('M10 geometry-conditioned public viewpoints', () => {
  const environment = {
    scenario: {
      robotStart: { x: 0.4, y: 0.5 },
      baseWind: { x: -0.2, y: 0 },
      obstacles: [],
    },
    controllerSeed: 2,
    observationModelVersion: 'test',
    observationModelSeed: 7,
    maxSpeed: 0.08,
    durationSeconds: 180,
    activeSniffEnabled: true,
    activeSniffCycleSeconds: 0.75,
    activeSniffReach: 0.06,
    sensorNoise: 0.025,
    isBlocked: () => false,
    windAt: () => ({ x: -0.2, y: 0 }),
    expectedHitRate: () => 0,
    safeDirection: (_from: Vec2, desired: Vec2) => desired,
    terrainMobilityScale: () => 1,
    horizontalReachForSurfaceDistance: (_direction: Vec2, reach: number) => reach,
  } as unknown as AlgorithmEnvironment

  it('selects a plume-retaining pose with predicted angular conditioning', () => {
    const anchor = { x: 0.4, y: 0.5 }
    const rays: GradientRay[] = [
      { time: 1, origin: anchor, direction: { x: 1, y: 0 }, weight: 0.8 },
    ]
    const selection = selectGeometryConditionedQuadViewpoint({
      environment,
      currentPosition: anchor,
      anchor,
      cueDirection: { x: 1, y: 0 },
      measuredWind: { x: -0.2, y: 0 },
      rays,
      visitedViewpoints: [anchor],
      preferredSide: 1,
    })
    expect(selection).not.toBeNull()
    expect(selection!.predictedGeometryQuality).toBeGreaterThan(0.15)
    expect(selection!.predictedIntersectionAngleDegrees).toBeGreaterThan(10)
    expect(selection!.plumeCorridorScore).toBeGreaterThan(0.1)
    expect(distance(selection!.target, anchor)).toBeGreaterThan(0.022)

    const alternative = selectGeometryConditionedQuadViewpoint({
      environment,
      currentPosition: anchor,
      anchor,
      cueDirection: { x: 1, y: 0 },
      measuredWind: { x: -0.2, y: 0 },
      rays,
      visitedViewpoints: [anchor, selection!.target],
      preferredSide: 1,
    })
    expect(alternative).not.toBeNull()
    expect(distance(alternative!.target, selection!.target)).toBeGreaterThanOrEqual(0.022)
  })

  it('retains only the strongest measured ray after failed confirmation', () => {
    const retained = retainStrongestGeometryRay([
      { time: 1, origin: { x: 0.2, y: 0.2 }, direction: { x: 1, y: 0 }, weight: 0.3 },
      { time: 2, origin: { x: 0.3, y: 0.3 }, direction: { x: 0, y: 1 }, weight: 0.8 },
      { time: 3, origin: { x: 0.4, y: 0.4 }, direction: { x: -1, y: 0 }, weight: 0.5 },
    ])
    expect(retained).toHaveLength(1)
    expect(retained[0]?.weight).toBe(0.8)
    expect(retained[0]?.time).toBe(2)
  })
})

describe('truth-blind Quad declaration evidence', () => {
  const supported = {
    ray: { quality: 0.7, residual: 0.012 },
    stability: { count: 4, span: 4, radius: 0.012 },
    surface: { count: 2, meanScore: 0.5 },
    passive: {
      coreCount: 8,
      coreHits: 4,
      ringCount: 7,
      coreMean: 0.72,
      contrast: 0.18,
    },
    secondsSincePassiveHit: 1,
    distanceToCandidate: 0.025,
  }

  it('accepts convergent independent evidence without source truth', () => {
    const result = evaluateQuadDeclarationEvidence(supported)
    expect(result.ready).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(0.58)
    expect(result.gatesPassed).toBe(14)
    expect(Object.values(result.gates).every(Boolean)).toBe(true)
    expect(result.raw.passiveCoreHits).toBe(4)
  })

  it('does not let a high aggregate score bypass a missing evidence stream', () => {
    const missingRing = evaluateQuadDeclarationEvidence({
      ...supported,
      passive: { ...supported.passive, ringCount: 0 },
    })
    expect(missingRing.ready).toBe(false)
    expect(missingRing.gates['passive-ring-count']).toBe(false)
    expect(missingRing.gatesPassed).toBe(13)
    const staleContact = evaluateQuadDeclarationEvidence({
      ...supported,
      secondsSincePassiveHit: 8,
    })
    expect(staleContact.ready).toBe(false)
    expect(staleContact.gates['recent-passive-hit']).toBe(false)
  })
})

describe('QuadSoilSniffController acquisition boundary', () => {
  const environment = {
    scenario: {
      robotStart: { x: 0.1, y: 0.1 },
      baseWind: { x: 0.2, y: 0 },
      obstacles: [],
    },
    controllerSeed: 4,
    maxSpeed: 0.08,
    durationSeconds: 180,
    activeSniffEnabled: true,
    activeSniffCycleSeconds: 0.75,
    activeSniffReach: 0.06,
    sensorNoise: 0.025,
    isBlocked: () => false,
    windAt: () => {
      throw new Error('controller must not query the private plume through windAt')
    },
    expectedHitRate: () => {
      throw new Error('controller must not query candidate-source plume likelihoods')
    },
    safeDirection: (_from: Vec2, desired: Vec2) => desired,
    terrainMobilityScale: () => 1,
    horizontalReachForSurfaceDistance: (_direction: Vec2, reach: number) => reach,
  } as unknown as AlgorithmEnvironment

  const input = (time: number, hit: boolean): AlgorithmStepInput => ({
    time,
    dt: 0.25,
    position: { x: 0.1, y: 0.1 },
    heading: 0,
    measurement: {
      time,
      concentration: hit ? 0.2 : 0.01,
      hit,
      wind: { x: 0.2, y: 0 },
      valid: true,
      sampleMode: 'passive',
    },
    observations: [],
    distance: 0,
  })

  const quadReturn = (
    time: number,
    strength: number,
    samplingMode: 'active-suction' | 'passive-array' = 'active-suction',
    scanId = 1,
    position: Vec2 = { x: 0.1, y: 0.1 },
  ): AlgorithmStepInput => {
    const readings = cardinalReadings()
    return {
      ...input(time, false),
      position,
      measurement: {
        time,
        concentration: 0.5,
        hit: true,
        wind: { x: 0.2, y: 0 },
        valid: true,
        sampleMode: samplingMode === 'passive-array'
          ? 'quad-passive-return'
          : 'quad-return',
        quadSniff: {
          scanId,
          phase: 'return',
          forward: { x: -1, y: 0 },
          strength,
          samplingMode,
          progress: 1,
          channels: readings.map(({ channel, direction, reach, support, effectiveOffset }) => ({
            channel,
            direction,
            reach,
            support,
            effectiveOffset,
          })),
          readings,
        },
      },
    }
  }

  const uniformQuadReturn = (
    time: number,
    concentration: number,
    hit: boolean,
  ): AlgorithmStepInput => {
    const base = quadReturn(time, 1)
    const quadSniff = base.measurement.quadSniff!
    const readings = quadSniff.readings!.map((item) => ({
      ...item,
      concentration,
      hit,
    }))
    return {
      ...base,
      measurement: {
        ...base.measurement,
        concentration,
        hit,
        quadSniff: { ...quadSniff, readings },
      },
    }
  }

  it('uses low-duty reconnaissance before issuing a contact-triggered scan', () => {
    const controller = new QuadSoilSniffController()
    controller.reset(environment)

    const beforeEvidence = controller.step(input(1, false))
    expect(beforeEvidence.phase).toBe('BROAD PASSIVE ACQUISITION')
    expect(beforeEvidence.quadSniff).toBeUndefined()

    const heading = 0.73
    const firstEvidence = controller.step({ ...input(2, true), heading })
    expect(firstEvidence.phase).toBe('SIMULTANEOUS QUAD ASPIRATION')
    expect(firstEvidence.quadSniff).toEqual(expect.objectContaining({ scanId: 1 }))
    expect(firstEvidence.quadSniff?.forward.x).toBeCloseTo(Math.cos(heading), 12)
    expect(firstEvidence.quadSniff?.forward.y).toBeCloseTo(Math.sin(heading), 12)

    const waiting = controller.step(input(2.25, true))
    expect(waiting.phase).toBe('AWAITING FOUR CHANNELS')
    expect(waiting.quadSniff).toBeUndefined()
  })

  it('can actively reconnoitre before the first passive threshold crossing', () => {
    const controller = new QuadSoilSniffController()
    controller.reset(environment)
    controller.step(input(1, false))

    const reconnaissance = controller.step(input(2, false))
    expect(reconnaissance.phase).toBe('SIMULTANEOUS QUAD ASPIRATION')
    expect(reconnaissance.quadSniff?.scanId).toBe(1)
  })

  it('uses adaptive public viewpoints after the first qualified ray', () => {
    const adaptiveEnvironment = {
      ...environment,
      windAt: () => ({ x: 0.2, y: 0 }),
    } as unknown as AlgorithmEnvironment
    const controller = new QuadSoilSniffController('active-suction', 'adaptive-viewpoint')
    controller.reset(adaptiveEnvironment)
    controller.step(input(2, false))
    const decision = controller.step(quadReturn(2.75, 1))
    expect(decision.phase).toMatch(/^ADAPTIVE /)
    expect(decision.debug?.candidates).toHaveLength(1)
    expect(decision.direction).not.toEqual({ x: 0, y: 0 })
  })

  it('rejects a completed unsupported M10 candidate and reacquires from its strongest ray', () => {
    const candidate = { x: 0.3, y: 0.3 }
    const rays: GradientRay[] = [
      { time: 1, origin: { x: 0.1, y: 0.1 }, direction: { x: 1, y: 1 }, weight: 0.55 },
      { time: 2, origin: { x: 0.1, y: 0.3 }, direction: { x: 1, y: 0 }, weight: 0.9 },
      { time: 3, origin: { x: 0.3, y: 0.1 }, direction: { x: 0, y: 1 }, weight: 0.7 },
    ]
    const rayEstimate = intersectGradientRays(rays)
    expect(rayEstimate?.quality).toBeGreaterThan(0.26)
    const controller = new QuadSoilSniffController('active-suction', 'geometry-conditioned')
    controller.reset(environment)
    const mutable = controller as unknown as {
      gradientRays: GradientRay[]
      rayEstimate: ReturnType<typeof intersectGradientRays>
      everPassiveHit: boolean
      lastPassiveHitTime: number
      confirmationCandidate: Vec2
      confirmationCompletedAt: number
      mode: string
    }
    Object.assign(mutable, {
      gradientRays: rays,
      rayEstimate,
      everPassiveHit: true,
      lastPassiveHitTime: 9,
      confirmationCandidate: candidate,
      confirmationCompletedAt: 9,
      mode: 'advance',
    })

    const decision = controller.step(input(10, true))
    expect(decision.phase).toBe('GEOMETRY-CONDITIONED VIEWPOINT')
    expect(decision.debug?.candidates).toHaveLength(1)
    expect(mutable.gradientRays).toHaveLength(1)
    expect(mutable.gradientRays[0]?.weight).toBe(0.9)
  })

  it('lets the first passive hit override a negative reconnaissance cooldown', () => {
    const controller = new QuadSoilSniffController()
    controller.reset(environment)
    controller.step(input(2, false))
    controller.step(uniformQuadReturn(2.75, 0.01, false))

    const contact = controller.step(input(5, true))
    expect(contact.phase).toBe('SIMULTANEOUS QUAD ASPIRATION')
    expect(contact.quadSniff?.scanId).toBe(2)
  })

  it('alternates active-only casts and expires unsupported reconnaissance evidence', () => {
    const controller = new QuadSoilSniffController()
    controller.reset(environment)
    controller.step(input(2, false))
    controller.step(uniformQuadReturn(2.75, 0.2, true))

    const firstCast = controller.step(input(6, false))
    const secondCast = controller.step(input(7, false))
    expect(firstCast.phase).toBe('PASSIVE REACQUISITION CAST')
    expect(secondCast.phase).toBe('PASSIVE REACQUISITION CAST')
    expect(firstCast.direction.y * secondCast.direction.y).toBeLessThan(0)

    const expired = controller.step(input(15, false))
    expect(expired.phase).toBe('BROAD PASSIVE ACQUISITION')
  })

  it('clears stale active-only gradient geometry when its support expires', () => {
    const controller = new QuadSoilSniffController()
    controller.reset(environment)
    controller.step(input(2, false))
    const guided = controller.step(quadReturn(2.75, 1))
    expect(guided.debug?.candidates?.length).toBeGreaterThan(0)

    const expired = controller.step(input(15, false))
    expect(expired.phase).toBe('BROAD PASSIVE ACQUISITION')
    expect(expired.debug?.candidates).toEqual([])
  })

  it('gives a zero-strength sham no active directional benefit', () => {
    const active = new QuadSoilSniffController()
    active.reset(environment)
    active.step(input(1, true))
    expect(active.step(quadReturn(1.75, 1)).phase).toBe('STAGED CROSSWIND TRIANGULATION')

    const sham = new QuadSoilSniffController()
    sham.reset(environment)
    sham.step(input(1, true))
    expect(sham.step(quadReturn(1.75, 0)).phase).not.toBe('STAGED CROSSWIND TRIANGULATION')
  })

  it('deliberately samples opposite crosswind sides after the first two separated rays', () => {
    const controller = new QuadSoilSniffController()
    controller.reset(environment)
    controller.step(input(1, true))
    const firstRay = controller.step(quadReturn(1.75, 1))
    expect(firstRay.phase).toBe('STAGED CROSSWIND TRIANGULATION')
    expect(firstRay.direction.y).toBeLessThan(0)

    const secondScanPosition = { x: 0.1, y: 0.06 }
    const secondScan = controller.step({ ...input(4, true), position: secondScanPosition })
    expect(secondScan.quadSniff?.scanId).toBe(2)
    const secondRay = controller.step(quadReturn(4.75, 1, 'active-suction', 2, secondScanPosition))
    expect(secondRay.phase).toBe('STAGED CROSSWIND TRIANGULATION')
    expect(secondRay.quadDeclarationEvidence?.candidateFormation.gradientRayPoolCount).toBe(2)
    expect(secondRay.direction.y).toBeGreaterThan(0)
  })

  it('keeps the M7 comparator on its original reactive gradient advance', () => {
    const legacy = new QuadSoilSniffController('active-suction', 'legacy-four-ray-surface')
    legacy.reset(environment)
    legacy.step(input(1, true))
    expect(legacy.step(quadReturn(1.75, 1)).phase).toBe('QUADRATURE GRADIENT ADVANCE')
  })

  it('uses spatial passive-array contrasts without attributing suction strength', () => {
    const passive = new QuadSoilSniffController('passive-array')
    passive.reset({ ...environment, activeSniffEnabled: false })
    const issued = passive.step(input(2, true))
    expect(issued.phase).toBe('SIMULTANEOUS PASSIVE ARRAY INTEGRATION')
    const guided = passive.step(quadReturn(2.75, 0, 'passive-array'))
    expect(guided.phase).toBe('STAGED CROSSWIND TRIANGULATION')
  })

  it('makes a truth-blind explicit abstention only after broad no-evidence survey', () => {
    const controller = new QuadSoilSniffController()
    controller.reset({ ...environment, activeSniffEnabled: false, durationSeconds: 40 })
    const early = controller.step({ ...input(35, false), distance: 3.3 })
    expect(early.nativeAbstained).toBeUndefined()
    const terminal = controller.step({ ...input(36, false), distance: 3.3 })
    expect(terminal.nativeAbstained).toBe(true)
    expect(terminal.estimate).toBeNull()
    expect(terminal.terminationReason).toMatch(/without access to target truth/i)
  })

  it('does not issue or wait for pseudo-scans when active sampling is off', () => {
    const controller = new QuadSoilSniffController()
    controller.reset({ ...environment, activeSniffEnabled: false })

    const decision = controller.step(input(2, true))
    expect(decision.quadSniff).toBeUndefined()
    expect(decision.phase).not.toMatch(/ASPIRATION|AWAITING/)
    expect(controller.step(input(2.25, true)).phase).not.toMatch(/ASPIRATION|AWAITING/)
  })
})
