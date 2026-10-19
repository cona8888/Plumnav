import {
  add,
  clamp,
  distance,
  dot,
  magnitude,
  normalize,
  rotate,
  scale,
  sub,
} from '../math'
import type {
  AlgorithmController,
  AlgorithmDecision,
  AlgorithmEnvironment,
  AlgorithmStepInput,
  QuadCandidateFormationGateName,
  QuadCandidateFormationStatus,
  QuadBracketEvidenceStatus,
  QuadBracketGateName,
  QuadDeclarationEvidenceStatus,
  QuadDeclarationGateName,
  QuadSamplingMode,
  QuadSniffChannelReading,
  Observation,
  InspectionContract,
  Vec2,
} from '../types'
import { ALGORITHM_METADATA } from './metadata'
import { inspectionAttemptBudget } from './physicalCandidateLifecycle'
import { PHYSICAL_VIEWPOINT_SPEED, selectPhysicalAcquisitionTarget } from './physicalAcquisition'
import { physicalBearingIntersection } from './physicalBearingGeometry'
import { selectLocalGradientStep } from './localGradientStep'
import { LocalMaximumProbe } from './localMaximumProbe'

const ZERO: Vec2 = { x: 0, y: 0 }
const MAX_PASSIVE_SAMPLES = 1_600
const MAX_GRADIENT_RAYS = 14
const MAX_ESTIMATE_HISTORY = 12
export const QUAD_CONFIRMATION_PRIORITY_POLICY = {
  version: 'quad-confirmation-priority-v1',
  candidatePolicy: 'quad-geometry-conditioned-v1',
  trustedCandidateOverridesGradientBurst: true,
  stationaryWithinConfirmationArrivalRadius: true,
  declarationThresholdsChanged: false,
} as const
export const QUAD_STAGED_CROSSWIND_POLICY = {
  version: 'quad-staged-crosswind-v1',
  minimumRayCount: 3,
  minimumRayQuality: 0.26,
  maximumRayResidual: 0.055,
  rayRetentionSeconds: 60,
  lateralOffsetNormalized: 0.055,
  minimumOriginSeparationNormalized: 0.018,
  candidateRequiresSurfaceSupport: false,
  declarationRequiresSurfaceSupport: true,
} as const
export const QUAD_ADAPTIVE_VIEWPOINT_POLICY = {
  version: 'quad-adaptive-viewpoint-v1',
  minimumRayCount: 3,
  minimumRayQuality: 0.26,
  maximumRayResidual: 0.055,
  rayRetentionSeconds: 75,
  minimumOriginSeparationNormalized: 0.018,
  viewpointRadiiNormalized: [0.05, 0.08, 0.11],
  viewpointAnglesDegrees: [90, -90, 60, -60, 120, -120, 150, -150],
  obstacleProbeRadiusNormalized: 0.042,
  confirmationCoreRadiusNormalized: 0.018,
  confirmationRingRadiusNormalized: 0.055,
  confirmationArrivalRadiusNormalized: 0.014,
  confirmationDwellSeconds: 1.5,
  candidateRequiresSurfaceSupport: false,
  declarationRequiresSurfaceSupport: true,
} as const
export const QUAD_GEOMETRY_CONDITIONED_POLICY = {
  version: 'quad-geometry-conditioned-v1',
  minimumRayCount: 3,
  minimumRayQuality: 0.26,
  maximumRayResidual: 0.055,
  rayRetentionSeconds: 75,
  minimumOriginSeparationNormalized: 0.018,
  hypothesisLookAheadNormalized: 0.11,
  viewpointAdvanceNormalized: [0.035, 0.06, 0.085],
  viewpointLateralOffsetNormalized: [0.025, 0.045, 0.065],
  visitedPoseExclusionNormalized: 0.022,
  obstacleProbeRadiusNormalized: 0.042,
  confirmationCoreRadiusNormalized: 0.018,
  confirmationRingRadiusNormalized: 0.055,
  confirmationArrivalRadiusNormalized: 0.014,
  confirmationDwellSeconds: 1.5,
  retainedRaysAfterFailedConfirmation: 1,
  candidateRequiresSurfaceSupport: false,
  declarationRequiresSurfaceSupport: true,
} as const
// For ideal full-support cardinal geometry with independent Gaussian channel
// noise, 3.03 gives approximately a 1% Rayleigh-null false-direction rate.
// Partial support and plume correlation still require empirical calibration.
const MIN_GRADIENT_SNR = 3.03

export type PassiveSample = {
  time: number
  position: Vec2
  concentration: number
  hit: boolean
}

export type QuadGradientEstimate = {
  commonMean: number
  normalizedContrast: number
  gradient: Vec2
  direction: Vec2
  supportQuality: number
  geometryQuality: number
  quality: number
  /** Model-based gradient significance; heuristic under non-white plume noise. */
  gradientSnr: number
  usableChannels: number
  validDirection: boolean
}

export type GradientRay = {
  angularSigma?: number
  time: number
  origin: Vec2
  direction: Vec2
  weight: number
}

export type GradientRayEstimate = {
  physicalUncertainty?: { version: 'linearized-local-bearing-v1'; nominalRadius95: number;
    reducedChiSquare: number; acceptable: boolean }
  point: Vec2
  residual: number
  geometryQuality: number
  forwardFraction: number
  poseSpan: number
  quality: number
  rayCount: number
}

type SurfaceEvidence = {
  time: number
  position: Vec2
  score: number
  commonMean: number
  normalizedContrast: number
}

type SearchMode =
  | 'acquire'
  | 'await-quad'
  | 'triangulate'
  | 'advance'
  | 'cast'
  | 'surface-check'
  | 'declared'
  | 'abstained'

type DeclarationEvidence = QuadDeclarationEvidenceStatus
export type QuadCandidatePolicy =
  | 'legacy-four-ray-surface'
  | 'staged-three-ray'
  | 'adaptive-viewpoint'
  | 'geometry-conditioned'

export type QuadRayDirectionMode =
  | 'measured-gradient'
  | 'wind-constrained'
  | 'wind-constrained-range'
  | 'wind-constrained-corridor'
  | 'wind-constrained-bracket'
  | 'wind-constrained-refine'

export type QuadRangeBelief = {
  estimate: Vec2
  radius: number
  effectiveCandidates: number
  observations: number
  hits: number
}

export type QuadCorridorBelief = QuadRangeBelief & {
  normalizedEntropy: number
  accepted: boolean
  rays: number
}

/** Frozen before M64 execution; dimensionless values scale with the domain. */
export const QUAD_CORRIDOR_POLICY = {
  version: 'quad-corridor-v1',
  gridBinsPerAxis: 25,
  minimumRangeNormalized: 0.012,
  maximumRangeNormalized: 0.82,
  angularHalfWidthDegrees: 40,
  angularPriorSigmaDegrees: 20,
  localModeRadiusNormalized: 0.09,
  passiveDecorrelationSeconds: 1,
  maximumPassiveObservations: 180,
  minimumHits: 3,
  minimumObservations: 12,
  likelihoodTemperature: 0.28,
  maximumNormalizedEntropy: 0.92,
  maximumCredibleRadiusNormalized: 0.18,
  credibleMass: 0.68,
} as const

export const QUAD_BRACKET_POLICY = {
  version: 'quad-spatial-bracket-v1',
  offsetNormalized: 0.055,
  zoneRadiusNormalized: 0.018,
  sampleDecorrelationSeconds: 0.75,
  maximumPairSeparationSeconds: 8,
  minimumCoreSamples: 4,
  minimumFlankSamplesPerDirection: 2,
  minimumSampledFlankDirections: 3,
  minimumCoreHits: 3,
  minimumDirectionalWins: 3,
  minimumPairs: 6,
  minimumPairedWinFraction: 0.7,
  maximumCandidateDistanceNormalized: 0.025,
} as const

export const QUAD_BRACKET_GATE_NAMES: readonly QuadBracketGateName[] = [
  'confirmation-completed', 'accessible-flank-directions', 'core-samples',
  'sampled-flank-directions', 'core-hits', 'directional-wins', 'paired-samples',
  'paired-win-fraction', 'ray-quality', 'ray-residual', 'stability-count',
  'stability-span', 'stability-radius', 'candidate-distance',
]

export type QuadBracketEvidence = {
  ready: boolean
  coreCount: number
  coreHits: number
  flankCounts: [number, number, number, number]
  directionalWins: number
  pairCount: number
  pairedWinFraction: number
  coreMedian: number
  flankMedians: [number, number, number, number]
}

export const QUAD_REFINE_POLICY = {
  version: 'quad-coordinate-refine-v1',
  offsetNormalized: 0.025,
  zoneRadiusNormalized: 0.012,
  dwellSeconds: 0.75,
  maximumUpdates: 2,
  minimumFlankSamples: 2,
  minimumRelativeImprovement: 0.08,
} as const

/**
 * Reduced plume-centreline source bearing used only by the development arm.
 * Wind supplies the upstream component; the concentration gradient contributes
 * only its transverse component, avoiding the unsupported assumption that the
 * complete local gradient intersects the source in advective flow.
 */
export const windConstrainedSourceDirection = (
  gradientDirection: Vec2,
  wind: Vec2,
): Vec2 => {
  if (magnitude(wind) <= 1e-9) return normalize(gradientDirection, ZERO)
  const downwind = normalize(wind)
  const upwind = scale(downwind, -1)
  const transverse = sub(
    gradientDirection,
    scale(downwind, dot(gradientDirection, downwind)),
  )
  const crosswind = magnitude(transverse) > 1e-9 ? normalize(transverse) : ZERO
  return normalize(add(scale(upwind, 0.75), scale(crosswind, 0.5)), upwind)
}

/** Truth-blind one-dimensional source-range posterior along a supplied bearing. */
export const inferSourceRangeAlongBearing = (
  environment: AlgorithmEnvironment,
  observations: readonly Observation[],
  origin: Vec2,
  bearing: Vec2,
): QuadRangeBelief | null => {
  const direction = normalize(bearing, ZERO)
  if (magnitude(direction) <= 1e-9) return null
  const passive: Observation[] = []
  for (const sample of observations) {
    if (!sample.valid || sample.sampleMode !== 'passive') continue
    const previous = passive[passive.length - 1]
    if (!previous || sample.time - previous.time >= 1) passive.push(sample)
  }
  if (passive.length > 180) passive.splice(0, passive.length - 180)
  const hits = passive.filter((sample) => sample.hit).length
  if (hits < 2) return null
  const candidates = Array.from({ length: 56 }, (_, index) => {
    const range = 0.012 + index * (0.82 - 0.012) / 55
    return add(origin, scale(direction, range))
  }).filter((point) =>
    point.x >= 0.01 && point.x <= 0.99 && point.y >= 0.01 && point.y <= 0.99 &&
    !environment.isBlocked(point, 0.008))
  if (candidates.length < 3) return null
  const logWeights = candidates.map((candidate) => passive.reduce((total, sample) => {
    const rate = Math.max(0, environment.expectedHitRate(
      candidate, sample.position, sample.time,
    ))
    const probability = clamp(1 - Math.exp(-rate), 0.01, 0.99)
    return total + 0.28 * Math.log(sample.hit ? probability : 1 - probability)
  }, 0))
  const maximum = Math.max(...logWeights)
  const weights = logWeights.map((value) => Math.exp(value - maximum))
  const totalWeight = weights.reduce((sum, value) => sum + value, 0)
  if (!(totalWeight > 0) || !Number.isFinite(totalWeight)) return null
  const estimate = candidates.reduce((sum, point, index) =>
    add(sum, scale(point, weights[index]! / totalWeight)), ZERO)
  const radius = Math.sqrt(candidates.reduce((sum, point, index) =>
    sum + weights[index]! / totalWeight * distance(point, estimate) ** 2, 0))
  const squared = weights.reduce((sum, value) => sum + (value / totalWeight) ** 2, 0)
  return {
    estimate,
    radius,
    effectiveCandidates: 1 / Math.max(squared, 1e-12),
    observations: passive.length,
    hits,
  }
}

/**
 * Truth-blind 2-D posterior inside the union of recent bearing corridors.
 * A local posterior mean around the MAP avoids averaging separated modes.
 */
export const inferSourceCorridorBelief = (
  environment: AlgorithmEnvironment,
  observations: readonly Observation[],
  rays: readonly GradientRay[],
): QuadCorridorBelief | null => {
  const policy = QUAD_CORRIDOR_POLICY
  const usableRays = rays
    .filter((ray) => magnitude(ray.direction) > 1e-9 && ray.weight > 0)
    .slice(-MAX_GRADIENT_RAYS)
  if (usableRays.length < 2) return null
  const passive: Observation[] = []
  for (const sample of observations) {
    if (!sample.valid || sample.sampleMode !== 'passive') continue
    const previous = passive[passive.length - 1]
    if (!previous || sample.time - previous.time >= policy.passiveDecorrelationSeconds) {
      passive.push(sample)
    }
  }
  if (passive.length > policy.maximumPassiveObservations) {
    passive.splice(0, passive.length - policy.maximumPassiveObservations)
  }
  const hits = passive.filter((sample) => sample.hit).length
  if (hits < policy.minimumHits || passive.length < policy.minimumObservations) return null

  const halfWidth = policy.angularHalfWidthDegrees * Math.PI / 180
  const sigma = policy.angularPriorSigmaDegrees * Math.PI / 180
  const candidates: Array<{ point: Vec2; anglePenalty: number }> = []
  for (let yIndex = 0; yIndex < policy.gridBinsPerAxis; yIndex += 1) {
    for (let xIndex = 0; xIndex < policy.gridBinsPerAxis; xIndex += 1) {
      const point = {
        x: (xIndex + 0.5) / policy.gridBinsPerAxis,
        y: (yIndex + 0.5) / policy.gridBinsPerAxis,
      }
      if (environment.isBlocked(point, 0.008)) continue
      let weightedAngleSquared = 0
      let totalRayWeight = 0
      let withinAnyCorridor = false
      let withinRange = false
      for (const ray of usableRays) {
        const relative = sub(point, ray.origin)
        const range = magnitude(relative)
        if (range < policy.minimumRangeNormalized || range > policy.maximumRangeNormalized) continue
        withinRange = true
        const angle = Math.acos(clamp(
          dot(normalize(relative), normalize(ray.direction)), -1, 1,
        ))
        if (angle <= halfWidth) withinAnyCorridor = true
        weightedAngleSquared += ray.weight * angle * angle
        totalRayWeight += ray.weight
      }
      if (!withinRange || !withinAnyCorridor || totalRayWeight <= 0) continue
      candidates.push({
        point,
        anglePenalty: -0.5 * weightedAngleSquared / totalRayWeight / (sigma * sigma),
      })
    }
  }
  if (candidates.length < 8) return null

  const logWeights = candidates.map((candidate) =>
    candidate.anglePenalty + passive.reduce((total, sample) => {
      const rate = Math.max(0, environment.expectedHitRate(
        candidate.point, sample.position, sample.time,
      ))
      const probability = clamp(1 - Math.exp(-rate), 0.01, 0.99)
      return total + policy.likelihoodTemperature *
        Math.log(sample.hit ? probability : 1 - probability)
    }, 0))
  const maximum = Math.max(...logWeights)
  const weights = logWeights.map((value) => Math.exp(value - maximum))
  const totalWeight = weights.reduce((sum, value) => sum + value, 0)
  if (!(totalWeight > 0) || !Number.isFinite(totalWeight)) return null
  const probabilities = weights.map((weight) => weight / totalWeight)
  const mapIndex = probabilities.reduce(
    (best, value, index) => value > probabilities[best]! ? index : best, 0,
  )
  const mapPoint = candidates[mapIndex]!.point
  let localMass = 0
  let estimate = ZERO
  for (let index = 0; index < candidates.length; index += 1) {
    if (distance(candidates[index]!.point, mapPoint) > policy.localModeRadiusNormalized) continue
    localMass += probabilities[index]!
    estimate = add(estimate, scale(candidates[index]!.point, probabilities[index]!))
  }
  if (!(localMass > 0)) return null
  estimate = scale(estimate, 1 / localMass)
  const radialMass = candidates.map((candidate, index) => ({
    radius: distance(candidate.point, estimate), probability: probabilities[index]!,
  })).sort((a, b) => a.radius - b.radius)
  let cumulative = 0
  let credibleRadius = radialMass[radialMass.length - 1]!.radius
  for (const item of radialMass) {
    cumulative += item.probability
    if (cumulative >= policy.credibleMass) {
      credibleRadius = item.radius
      break
    }
  }
  const entropy = -probabilities.reduce(
    (sum, probability) => sum + (probability > 0 ? probability * Math.log(probability) : 0), 0,
  )
  const normalizedEntropy = entropy / Math.log(candidates.length)
  const squared = probabilities.reduce((sum, probability) => sum + probability ** 2, 0)
  return {
    estimate,
    radius: credibleRadius,
    effectiveCandidates: 1 / Math.max(squared, 1e-12),
    observations: passive.length,
    hits,
    normalizedEntropy,
    accepted:
      normalizedEntropy <= policy.maximumNormalizedEntropy &&
      credibleRadius <= policy.maximumCredibleRadiusNormalized,
    rays: usableRays.length,
  }
}

export const QUAD_DECLARATION_GATE_NAMES: readonly QuadDeclarationGateName[] = [
  'candidate',
  'stability-count',
  'stability-span',
  'stability-radius',
  'surface-count',
  'surface-score',
  'passive-core-count',
  'passive-core-hits',
  'passive-ring-count',
  'passive-core-mean',
  'passive-contrast',
  'recent-passive-hit',
  'candidate-distance',
  'aggregate-score',
]

export const QUAD_CANDIDATE_FORMATION_GATE_NAMES: readonly QuadCandidateFormationGateName[] = [
  'provisional-ray',
  'ray-count',
  'ray-quality',
  'ray-residual',
  'surface-support',
]

export const evaluateQuadCandidateFormation = ({
  gradientRayPoolCount,
  ray,
  surfaceSupportCount,
  policy = 'staged-three-ray',
}: {
  gradientRayPoolCount: number
  ray: GradientRayEstimate | null
  surfaceSupportCount: number
  policy?: QuadCandidatePolicy
}): QuadCandidateFormationStatus => {
  const gates: Record<QuadCandidateFormationGateName, boolean> = {
    'provisional-ray': Boolean(ray),
    'ray-count': Boolean(ray && ray.rayCount >= (policy === 'legacy-four-ray-surface'
      ? 4
      : QUAD_STAGED_CROSSWIND_POLICY.minimumRayCount)),
    'ray-quality': Boolean(ray && ray.quality >= QUAD_STAGED_CROSSWIND_POLICY.minimumRayQuality),
    'ray-residual': Boolean(ray && ray.residual <= QUAD_STAGED_CROSSWIND_POLICY.maximumRayResidual),
    'surface-support': Boolean(ray && surfaceSupportCount >= 1),
  }
  // M8 staged policy: surface evidence remains a mandatory declaration
  // safeguard, but is no longer a prerequisite for using a geometrically
  // supported candidate to navigate and collect that evidence.
  const trustedCandidate = policy === 'legacy-four-ray-surface'
    ? QUAD_CANDIDATE_FORMATION_GATE_NAMES.every((name) => gates[name])
    : gates['provisional-ray'] && gates['ray-count'] && gates['ray-quality'] && gates['ray-residual']
  return {
    provisionalCandidate: ray ? copyPoint(ray.point) : null,
    gradientRayPoolCount,
    provisionalRayCount: ray?.rayCount ?? null,
    provisionalRayQuality: ray?.quality ?? null,
    provisionalRayResidual: ray?.residual ?? null,
    surfaceSupportCount: ray ? surfaceSupportCount : 0,
    trustedCandidate,
    gatesPassed: QUAD_CANDIDATE_FORMATION_GATE_NAMES.filter((name) => gates[name]).length,
    gates,
  }
}

export type QuadDeclarationEvidenceInput = {
  ray: { quality: number; residual: number }
  stability: { count: number; span: number; radius: number }
  surface: { count: number; meanScore: number }
  passive: {
    coreCount: number
    coreHits: number
    ringCount: number
    coreMean: number
    contrast: number
  }
  secondsSincePassiveHit: number
  distanceToCandidate: number
}

/**
 * Frozen truth-blind declaration score used by both active and passive Quad
 * variants. Hard gates prevent a high score in one evidence stream from
 * compensating for absent independent support in another stream.
 */
export const evaluateQuadDeclarationEvidence = (
  evidence: QuadDeclarationEvidenceInput,
) => {
  const { ray, stability, surface, passive } = evidence
  const rayScore = clamp((ray.quality - 0.22) / 0.38) *
    clamp(1 - ray.residual / 0.065)
  const stabilityScore = clamp(stability.count / 4) *
    clamp(stability.span / 3) *
    clamp(1 - stability.radius / 0.05)
  const surfaceScore = clamp(surface.count / 2) *
    clamp(surface.meanScore / 0.42)
  const passiveScore = mean([
    clamp(passive.coreCount / 6),
    clamp(passive.coreHits / 3),
    clamp(passive.ringCount / 5),
    clamp((passive.coreMean - 0.28) / 0.42),
    clamp((passive.contrast - 0.02) / 0.16),
  ])
  const score =
    rayScore * 0.3 +
    stabilityScore * 0.25 +
    surfaceScore * 0.2 +
    passiveScore * 0.25
  const gates: Record<QuadDeclarationGateName, boolean> = {
    candidate: true,
    'stability-count': stability.count >= 3,
    'stability-span': stability.span >= 2,
    'stability-radius': stability.radius <= 0.035,
    'surface-count': surface.count >= 1,
    'surface-score': surface.meanScore >= 0.28,
    'passive-core-count': passive.coreCount >= 5,
    'passive-core-hits': passive.coreHits >= 2,
    'passive-ring-count': passive.ringCount >= 4,
    'passive-core-mean': passive.coreMean >= 0.4,
    'passive-contrast': passive.contrast >= 0.05,
    'recent-passive-hit': evidence.secondsSincePassiveHit <= 4.5,
    'candidate-distance': evidence.distanceToCandidate <= 0.075,
    'aggregate-score': score >= 0.58,
  }
  const gatesPassed = QUAD_DECLARATION_GATE_NAMES.filter((name) => gates[name]).length
  const ready = QUAD_DECLARATION_GATE_NAMES.every((name) => gates[name])
  return {
    ready,
    score,
    rayScore,
    stabilityScore,
    surfaceScore,
    passiveScore,
    gatesPassed,
    gates,
    raw: {
      rayQuality: ray.quality,
      rayResidual: ray.residual,
      stabilityCount: stability.count,
      stabilitySpan: stability.span,
      stabilityRadius: stability.radius,
      surfaceCount: surface.count,
      surfaceMeanScore: surface.meanScore,
      passiveCoreCount: passive.coreCount,
      passiveCoreHits: passive.coreHits,
      passiveRingCount: passive.ringCount,
      passiveCoreMean: passive.coreMean,
      passiveContrast: passive.contrast,
      secondsSincePassiveHit: Number.isFinite(evidence.secondsSincePassiveHit)
        ? evidence.secondsSincePassiveHit
        : null,
      distanceToCandidate: Number.isFinite(evidence.distanceToCandidate)
        ? evidence.distanceToCandidate
        : null,
    },
  }
}

const copyPoint = (point: Vec2): Vec2 => ({ x: point.x, y: point.y })

const mean = (values: readonly number[]) =>
  values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0

const median = (values: readonly number[]) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0
}

/** Rank-based, scale-free evidence from an alternating centre/cardinal traverse. */
export const evaluateQuadSpatialBracket = (
  samples: readonly PassiveSample[],
  candidate: Vec2,
  measuredWind: Vec2,
  startedAt: number,
  offsetNormalized: number = QUAD_BRACKET_POLICY.offsetNormalized,
  zoneRadiusNormalized: number = QUAD_BRACKET_POLICY.zoneRadiusNormalized,
  timing?: Pick<InspectionContract, 'sampleSpacingSeconds' | 'maximumPairSeparationSeconds'>,
): QuadBracketEvidence => {
  const policy = QUAD_BRACKET_POLICY
  const upwind = magnitude(measuredWind) > 1e-9
    ? scale(normalize(measuredWind), -1)
    : { x: -1, y: 0 }
  const crosswind = rotate(upwind, Math.PI / 2)
  const centers = [
    add(candidate, scale(upwind, offsetNormalized)),
    add(candidate, scale(upwind, -offsetNormalized)),
    add(candidate, scale(crosswind, offsetNormalized)),
    add(candidate, scale(crosswind, -offsetNormalized)),
  ]
  const core: PassiveSample[] = []
  const flanks: PassiveSample[][] = [[], [], [], []]
  const appendDecorrelated = (target: PassiveSample[], sample: PassiveSample) => {
    const previous = target[target.length - 1]
    if (!previous || sample.time - previous.time >= (timing?.sampleSpacingSeconds ?? policy.sampleDecorrelationSeconds)) {
      target.push(sample)
    }
  }
  for (const sample of samples) {
    if (sample.time < startedAt) continue
    if (distance(sample.position, candidate) <= zoneRadiusNormalized) {
      appendDecorrelated(core, sample)
      continue
    }
    let nearest = -1
    let nearestDistance = Infinity
    centers.forEach((center, index) => {
      const separation = distance(sample.position, center)
      if (separation < nearestDistance) {
        nearest = index
        nearestDistance = separation
      }
    })
    if (nearest >= 0 && nearestDistance <= zoneRadiusNormalized) {
      appendDecorrelated(flanks[nearest]!, sample)
    }
  }
  const coreMedian = median(core.map((sample) => sample.concentration))
  const flankMedians = flanks.map((flank) =>
    median(flank.map((sample) => sample.concentration)),
  ) as [number, number, number, number]
  const directionalWins = flanks.filter((flank, index) =>
    flank.length > 0 && coreMedian > flankMedians[index]!,
  ).length
  let pairCount = 0
  let pairWins = 0
  for (const flank of flanks) for (const sample of flank) {
    const nearestCore = core.reduce<PassiveSample | null>((nearest, item) =>
      !nearest || Math.abs(item.time - sample.time) < Math.abs(nearest.time - sample.time)
        ? item
        : nearest, null)
    if (!nearestCore || Math.abs(nearestCore.time - sample.time) >
        (timing?.maximumPairSeparationSeconds ?? policy.maximumPairSeparationSeconds)) continue
    pairCount += 1
    if (nearestCore.concentration > sample.concentration) pairWins += 1
  }
  const pairedWinFraction = pairCount > 0 ? pairWins / pairCount : 0
  const flankCounts = flanks.map((flank) => flank.length) as [number, number, number, number]
  const coreHits = core.filter((sample) => sample.hit).length
  return {
    ready:
      core.length >= policy.minimumCoreSamples &&
      flankCounts.filter((count) => count >= policy.minimumFlankSamplesPerDirection).length >=
        policy.minimumSampledFlankDirections &&
      coreHits >= policy.minimumCoreHits &&
      directionalWins >= policy.minimumDirectionalWins &&
      pairCount >= policy.minimumPairs &&
      pairedWinFraction >= policy.minimumPairedWinFraction,
    coreCount: core.length,
    coreHits,
    flankCounts,
    directionalWins,
    pairCount,
    pairedWinFraction,
    coreMedian,
    flankMedians,
  }
}

const safeDirection = (
  environment: AlgorithmEnvironment,
  position: Vec2,
  desired: Vec2,
) => {
  if (magnitude(desired) <= 1e-9) return ZERO
  return normalize(environment.safeDirection(position, desired), ZERO)
}

export type AdaptiveViewpointSelection = {
  target: Vec2
  score: number
  localClearanceFraction: number
  routeAlignment: number
  windCorridorFraction: number
  wakeEscape: boolean
}

const boundedPoint = (point: Vec2): Vec2 => ({
  x: clamp(point.x, 0.02, 0.98),
  y: clamp(point.y, 0.02, 0.98),
})

const localClearanceFraction = (
  environment: AlgorithmEnvironment,
  point: Vec2,
  reference: Vec2,
) => {
  const directions = Array.from({ length: 8 }, (_, index) =>
    rotate(reference, (index * Math.PI) / 4))
  const clear = directions.filter((direction) => !environment.isBlocked(add(
    point,
    scale(direction, QUAD_ADAPTIVE_VIEWPOINT_POLICY.obstacleProbeRadiusNormalized),
  ), 0.008)).length
  return clear / directions.length
}

/**
 * Selects the next public, truth-blind sampling pose after a qualified ray.
 * Candidates span both sides of the cue, are rejected when blocked or too
 * close to an existing ray, and are scored for local clearance, reachable
 * heading, transverse baseline and an obstacle-clear local-wind corridor.
 */
export const selectAdaptiveQuadViewpoint = ({
  environment,
  currentPosition,
  anchor,
  cueDirection,
  measuredWind,
  rays,
  preferredSide,
}: {
  environment: AlgorithmEnvironment
  currentPosition: Vec2
  anchor: Vec2
  cueDirection: Vec2
  measuredWind: Vec2
  rays: readonly GradientRay[]
  preferredSide: 1 | -1
}): AdaptiveViewpointSelection | null => {
  const cue = normalize(cueDirection, magnitude(measuredWind) > 1e-9
    ? scale(normalize(measuredWind), -1)
    : { x: -1, y: 0 })
  const transverse = rotate(cue, Math.PI / 2)
  const flowDirection = normalize(measuredWind, scale(cue, -1))
  let best: AdaptiveViewpointSelection | null = null

  for (const radius of QUAD_ADAPTIVE_VIEWPOINT_POLICY.viewpointRadiiNormalized) {
    for (const angleDegrees of QUAD_ADAPTIVE_VIEWPOINT_POLICY.viewpointAnglesDegrees) {
      const offsetDirection = rotate(cue, angleDegrees * Math.PI / 180)
      const target = boundedPoint(add(anchor, scale(offsetDirection, radius)))
      if (environment.isBlocked(target, 0.012)) continue
      const minimumSeparation = rays.length
        ? Math.min(...rays.map((ray) => distance(ray.origin, target)))
        : distance(anchor, target)
      if (minimumSeparation < QUAD_ADAPTIVE_VIEWPOINT_POLICY.minimumOriginSeparationNormalized) continue
      const desired = normalize(sub(target, currentPosition), ZERO)
      if (magnitude(desired) <= 1e-9) continue
      const routed = safeDirection(environment, currentPosition, desired)
      const routeAlignment = Math.max(0, dot(desired, routed))
      if (routeAlignment <= 0.05) continue
      const clearance = localClearanceFraction(environment, target, cue)
      const windCorridorFraction = [-0.06, -0.03, 0.03, 0.06]
        .filter((offset) => !environment.isBlocked(
          add(target, scale(flowDirection, offset)),
          0.008,
        )).length / 4
      const separationScore = clamp(minimumSeparation / 0.09)
      const transverseSpan = Math.abs(dot(sub(target, anchor), transverse))
      const transverseScore = clamp(transverseSpan / 0.075)
      const side = Math.sign(dot(sub(target, anchor), transverse)) || 1
      const sideScore = side === preferredSide ? 1 : 0.35
      const score =
        separationScore * 0.27 +
        clearance * 0.25 +
        windCorridorFraction * 0.2 +
        transverseScore * 0.16 +
        routeAlignment * 0.08 +
        sideScore * 0.04
      const selection: AdaptiveViewpointSelection = {
        target,
        score,
        localClearanceFraction: clearance,
        routeAlignment,
        windCorridorFraction,
        wakeEscape: clearance < 0.75 || windCorridorFraction < 0.75,
      }
      if (!best || selection.score > best.score + 1e-12) best = selection
    }
  }
  return best
}

export type GeometryConditionedViewpointSelection = AdaptiveViewpointSelection & {
  hypothesis: Vec2
  predictedGeometryQuality: number
  predictedIntersectionAngleDegrees: number
  plumeCorridorScore: number
}

const directionGeometryQuality = (directions: readonly Vec2[]) => {
  let xx = 0
  let xy = 0
  let yy = 0
  for (const item of directions) {
    const direction = normalize(item, ZERO)
    if (magnitude(direction) <= 1e-9) continue
    xx += direction.y * direction.y
    xy -= direction.x * direction.y
    yy += direction.x * direction.x
  }
  const determinant = xx * yy - xy * xy
  const trace = xx + yy
  return trace > 1e-9 ? clamp((4 * determinant) / (trace * trace)) : 0
}

const acuteAngle = (first: Vec2, second: Vec2) =>
  Math.acos(clamp(Math.abs(dot(normalize(first), normalize(second))), 0, 1))

/**
 * M10 truth-blind viewpoint policy. A short forward source hypothesis is
 * formed only from measured ray origins/directions. Candidate poses are kept
 * near that measured corridor and ranked by the predicted conditioning and
 * angular diversity of the next ray, while visited poses are excluded.
 */
export const selectGeometryConditionedQuadViewpoint = ({
  environment,
  currentPosition,
  anchor,
  cueDirection,
  measuredWind,
  rays,
  visitedViewpoints,
  preferredSide,
}: {
  environment: AlgorithmEnvironment
  currentPosition: Vec2
  anchor: Vec2
  cueDirection: Vec2
  measuredWind: Vec2
  rays: readonly GradientRay[]
  visitedViewpoints: readonly Vec2[]
  preferredSide: 1 | -1
}): GeometryConditionedViewpointSelection | null => {
  const fallbackCue = magnitude(measuredWind) > 1e-9
    ? scale(normalize(measuredWind), -1)
    : { x: -1, y: 0 }
  let weightedCue = ZERO
  let weightedHypothesis = ZERO
  let totalWeight = 0
  for (const ray of rays) {
    const weight = Math.max(0.05, clamp(ray.weight))
    const direction = normalize(ray.direction, fallbackCue)
    weightedCue = add(weightedCue, scale(direction, weight))
    weightedHypothesis = add(weightedHypothesis, scale(add(
      ray.origin,
      scale(direction, QUAD_GEOMETRY_CONDITIONED_POLICY.hypothesisLookAheadNormalized),
    ), weight))
    totalWeight += weight
  }
  const cue = normalize(
    totalWeight > 0 ? weightedCue : cueDirection,
    normalize(cueDirection, fallbackCue),
  )
  const hypothesis = boundedPoint(totalWeight > 0
    ? scale(weightedHypothesis, 1 / totalWeight)
    : add(anchor, scale(cue, QUAD_GEOMETRY_CONDITIONED_POLICY.hypothesisLookAheadNormalized)))
  const latestOrigin = rays.at(-1)?.origin ?? anchor
  const transverse = rotate(cue, Math.PI / 2)
  const flowDirection = normalize(measuredWind, scale(cue, -1))
  let best: GeometryConditionedViewpointSelection | null = null

  for (const advance of QUAD_GEOMETRY_CONDITIONED_POLICY.viewpointAdvanceNormalized) {
    for (const lateralMagnitude of QUAD_GEOMETRY_CONDITIONED_POLICY.viewpointLateralOffsetNormalized) {
      for (const side of [preferredSide, -preferredSide] as const) {
        const target = boundedPoint(add(
          add(latestOrigin, scale(cue, advance)),
          scale(transverse, lateralMagnitude * side),
        ))
        if (environment.isBlocked(target, 0.012)) continue
        if (visitedViewpoints.some((point) => distance(point, target) <
            QUAD_GEOMETRY_CONDITIONED_POLICY.visitedPoseExclusionNormalized)) continue
        const minimumSeparation = rays.length
          ? Math.min(...rays.map((ray) => distance(ray.origin, target)))
          : distance(anchor, target)
        if (minimumSeparation < QUAD_GEOMETRY_CONDITIONED_POLICY.minimumOriginSeparationNormalized) continue
        const desired = normalize(sub(target, currentPosition), ZERO)
        if (magnitude(desired) <= 1e-9) continue
        const routed = safeDirection(environment, currentPosition, desired)
        const routeAlignment = Math.max(0, dot(desired, routed))
        if (routeAlignment <= 0.05) continue
        const predictedDirection = normalize(sub(hypothesis, target), cue)
        const predictedGeometryQuality = directionGeometryQuality([
          ...rays.map((ray) => ray.direction),
          predictedDirection,
        ])
        const minimumAngle = rays.length
          ? Math.min(...rays.map((ray) => acuteAngle(ray.direction, predictedDirection)))
          : Math.PI / 2
        const predictedIntersectionAngleDegrees = minimumAngle * 180 / Math.PI
        const angleScore = Math.sin(Math.min(Math.PI / 2, minimumAngle)) ** 2
        const plumeCorridorScore = Math.exp(-((
          lateralMagnitude / QUAD_GEOMETRY_CONDITIONED_POLICY.viewpointLateralOffsetNormalized[1]
        ) ** 2))
        const clearance = localClearanceFraction(environment, target, cue)
        const windCorridorFraction = [-0.045, -0.0225, 0.0225, 0.045]
          .filter((offset) => !environment.isBlocked(
            add(target, scale(flowDirection, offset)),
            0.008,
          )).length / 4
        const separationScore = clamp(minimumSeparation / 0.07)
        const sideScore = side === preferredSide ? 1 : 0.35
        const score =
          predictedGeometryQuality * 0.32 +
          angleScore * 0.18 +
          plumeCorridorScore * 0.18 +
          clearance * 0.12 +
          separationScore * 0.08 +
          windCorridorFraction * 0.05 +
          routeAlignment * 0.04 +
          sideScore * 0.03
        const selection: GeometryConditionedViewpointSelection = {
          target,
          score,
          hypothesis,
          predictedGeometryQuality,
          predictedIntersectionAngleDegrees,
          plumeCorridorScore,
          localClearanceFraction: clearance,
          routeAlignment,
          windCorridorFraction,
          wakeEscape: clearance < 0.75 || windCorridorFraction < 0.75,
        }
        if (!best || selection.score > best.score + 1e-12) best = selection
      }
    }
  }
  return best
}

export const retainStrongestGeometryRay = (rays: readonly GradientRay[]) =>
  [...rays]
    .sort((first, second) => second.weight - first.weight || second.time - first.time)
    .slice(0, QUAD_GEOMETRY_CONDITIONED_POLICY.retainedRaysAfterFailedConfirmation)
    .map((ray) => ({ ...ray, origin: copyPoint(ray.origin), direction: copyPoint(ray.direction) }))

/** Alternates core and ring poses so passive confirmation samples both zones. */
export const buildAdaptiveConfirmationWaypoints = (
  candidate: Vec2,
  measuredWind: Vec2,
  side: 1 | -1,
) => {
  const upwind = magnitude(measuredWind) > 1e-9
    ? scale(normalize(measuredWind), -1)
    : { x: -1, y: 0 }
  const crosswind = scale(rotate(upwind, Math.PI / 2), side)
  const ring = QUAD_ADAPTIVE_VIEWPOINT_POLICY.confirmationRingRadiusNormalized
  const center = boundedPoint(candidate)
  return [
    center,
    boundedPoint(add(candidate, scale(crosswind, ring))),
    center,
    boundedPoint(add(candidate, scale(crosswind, -ring))),
    center,
    boundedPoint(add(candidate, scale(upwind, -ring))),
    center,
    boundedPoint(add(candidate, scale(upwind, ring))),
    center,
  ]
}

/** Short centre/flank loop used for coordinate refinement before confirmation. */
export const buildCoordinateRefinementWaypoints = (
  candidate: Vec2,
  measuredWind: Vec2,
  side: 1 | -1,
  offset: number = QUAD_REFINE_POLICY.offsetNormalized,
) => {
  const upwind = magnitude(measuredWind) > 1e-9
    ? scale(normalize(measuredWind), -1)
    : { x: -1, y: 0 }
  const crosswind = scale(rotate(upwind, Math.PI / 2), side)
  const center = boundedPoint(candidate)
  return [
    center,
    boundedPoint(add(candidate, scale(crosswind, offset))),
    center,
    boundedPoint(add(candidate, scale(crosswind, -offset))),
    center,
    boundedPoint(add(candidate, scale(upwind, offset))),
    center,
  ]
}

const buildAcquisitionWaypoints = (start: Vec2): Vec2[] => {
  const waypoints: Vec2[] = []
  const columns = 9
  const startNearTop = start.y <= 0.5
  for (let index = 0; index < columns; index += 1) {
    const x = 0.055 + (index / (columns - 1)) * 0.89
    const top = index % 2 === 0 ? startNearTop : !startNearTop
    waypoints.push({ x, y: top ? 0.055 : 0.945 })
  }
  return waypoints
}

/**
 * Fits a local concentration plane to one synchronized quadrature return.
 *
 * Centering both concentration and effective inlet displacement removes the
 * common mode. With four clear cardinal channels this is exactly the usual
 * front-minus-aft / left-minus-right estimator; the weighted form remains
 * well-defined when one inlet is partly occluded or has a shorter terrain-
 * projected reach.
 */
export const estimateQuadGradient = (
  readings: readonly QuadSniffChannelReading[],
  sensorNoise = 0.025,
  geometryMode?: 'relative-geometry-v1',
): QuadGradientEstimate => {
  const channels = readings
    .filter((reading) =>
      Number.isFinite(reading.concentration) &&
      Number.isFinite(reading.reach) &&
      Number.isFinite(reading.support) &&
      Number.isFinite(reading.effectiveOffset.x) &&
      Number.isFinite(reading.effectiveOffset.y) &&
      !reading.saturated &&
      magnitude(reading.direction) > 1e-9 &&
      reading.reach > (geometryMode ? 0 : 1e-6) &&
      reading.support >= 0.08,
    )
    .map((reading) => {
      const support = clamp(reading.support)
      const direction = normalize(reading.direction)
      return {
        concentration: Math.max(0, reading.concentration),
        support,
        // Squaring support prevents a nearly occluded channel from becoming a
        // confident directional vote while retaining it for common-mode data.
        weight: support * support,
        offset: copyPoint(reading.effectiveOffset),
      }
    })

  if (channels.length === 0) {
    return {
      commonMean: 0,
      normalizedContrast: 0,
      gradient: ZERO,
      direction: ZERO,
      supportQuality: 0,
      geometryQuality: 0,
      quality: 0,
      gradientSnr: 0,
      usableChannels: 0,
      validDirection: false,
    }
  }

  // Solve in head-relative coordinates to avoid determinant cutoffs that scale
  // with L^-4. Convert the gradient back to domain coordinates only on return.
  // Legacy arithmetic and thresholds remain unchanged when not opted in.
  const geometryScale = geometryMode
    ? Math.max(...channels.map(channel => Math.hypot(channel.offset.x, channel.offset.y))) || 1 : 1
  if (geometryMode) for (const channel of channels) channel.offset = {
    x: channel.offset.x / geometryScale, y: channel.offset.y / geometryScale,
  }

  const totalWeight = channels.reduce((sum, channel) => sum + channel.weight, 0)
  const commonMean = channels.reduce(
    (sum, channel) => sum + channel.weight * channel.concentration,
    0,
  ) / Math.max(1e-12, totalWeight)
  const center = channels.reduce(
    (sum, channel) => add(sum, scale(channel.offset, channel.weight / totalWeight)),
    ZERO,
  )

  let xx = 0
  let xy = 0
  let yy = 0
  let bx = 0
  let by = 0
  for (const channel of channels) {
    const offset = sub(channel.offset, center)
    const concentration = channel.concentration - commonMean
    xx += channel.weight * offset.x * offset.x
    xy += channel.weight * offset.x * offset.y
    yy += channel.weight * offset.y * offset.y
    bx += channel.weight * offset.x * concentration
    by += channel.weight * offset.y * concentration
  }

  const determinant = xx * yy - xy * xy
  const trace = xx + yy
  const geometryQuality = trace > (geometryMode ? 0 : 1e-12)
    ? clamp((4 * Math.max(0, determinant)) / (trace * trace), 0, 1)
    : 0
  const gradient = determinant > (geometryMode ? 64 * Number.EPSILON * trace * trace : 1e-14)
    ? {
        x: (yy * bx - xy * by) / determinant,
        y: (xx * by - xy * bx) / determinant,
      }
    : ZERO

  const concentrations = channels.map((channel) => channel.concentration)
  const concentrationRange = Math.max(...concentrations) - Math.min(...concentrations)
  const normalizedContrast = concentrationRange / Math.max(0.03, commonMean)
  const meanSupport = mean(channels.map((channel) => channel.support))
  const channelFraction = channels.length / 4
  const supportQuality = clamp(meanSupport * channelFraction)
  const contrastQuality = clamp((normalizedContrast - 0.012) / 0.2)
  const meanEffectiveSamples = mean(
    readings
      .filter((reading) => Number.isFinite(reading.effectiveIntegrationSamples))
      .map((reading) => Math.max(1, reading.effectiveIntegrationSamples)),
  ) || 1
  const effectiveNoise = Math.max(1e-6, Math.max(0, sensorNoise)) /
    Math.sqrt(meanEffectiveSamples)
  const gradientSnr = Math.sqrt(Math.max(
    0,
    gradient.x * (xx * gradient.x + xy * gradient.y) +
      gradient.y * (xy * gradient.x + yy * gradient.y),
  )) / effectiveNoise
  const snrQuality = clamp((gradientSnr - 2.5) / 4)
  const quality = clamp(
    Math.sqrt(contrastQuality * snrQuality) *
      Math.sqrt(geometryQuality) * supportQuality,
  )
  const direction = magnitude(gradient) > 1e-9 ? normalize(gradient) : ZERO
  const returnedGradient = geometryMode ? scale(gradient, 1 / geometryScale) : gradient
  const validDirection = Boolean(
    channels.length >= 3 &&
    geometryQuality >= 0.16 &&
    supportQuality >= 0.42 &&
    normalizedContrast >= 0.018 &&
    gradientSnr >= MIN_GRADIENT_SNR &&
    magnitude(gradient) > 1e-8 &&
    Number.isFinite(returnedGradient.x) &&
    Number.isFinite(returnedGradient.y),
  )

  return {
    commonMean,
    normalizedContrast,
    gradient: returnedGradient,
    direction,
    supportQuality,
    geometryQuality,
    quality,
    gradientSnr,
    usableChannels: channels.length,
    validDirection,
  }
}

const solveGradientLines = (rays: readonly GradientRay[]) => {
  let xx = 0
  let xy = 0
  let yy = 0
  let bx = 0
  let by = 0
  let totalWeight = 0

  for (const ray of rays) {
    const direction = normalize(ray.direction)
    const weight = clamp(ray.weight, 0, 1)
    // Orthogonal projector I - dd^T. Its distance residual is zero on
    // the complete line underlying the forward gradient ray.
    const pxx = direction.y * direction.y
    const pxy = -direction.x * direction.y
    const pyy = direction.x * direction.x
    xx += weight * pxx
    xy += weight * pxy
    yy += weight * pyy
    bx += weight * (pxx * ray.origin.x + pxy * ray.origin.y)
    by += weight * (pxy * ray.origin.x + pyy * ray.origin.y)
    totalWeight += weight
  }

  const determinant = xx * yy - xy * xy
  const trace = xx + yy
  if (determinant <= 1e-10 || trace <= 1e-10 || totalWeight <= 0) return null
  return {
    point: {
      x: (yy * bx - xy * by) / determinant,
      y: (xx * by - xy * bx) / determinant,
    },
    geometryQuality: clamp((4 * determinant) / (trace * trace), 0, 1),
    totalWeight,
  }
}

/** Robust least-squares intersection of directional gradients from many poses. */
export const intersectGradientRays = (
  candidateRays: readonly GradientRay[],
): GradientRayEstimate | null => {
  const rays = candidateRays.filter((ray) =>
    Number.isFinite(ray.origin.x) &&
    Number.isFinite(ray.origin.y) &&
    Number.isFinite(ray.weight) &&
    magnitude(ray.direction) > 1e-9 &&
    ray.weight > 0,
  )
  if (rays.length < 3) return null

  let solved = solveGradientLines(rays)
  if (!solved) return null

  // One trimming pass prevents a single turbulent filament edge from moving a
  // well-supported multi-pose intersection. At least three rays are retained.
  const residuals = rays
    .map((ray) => {
      const direction = normalize(ray.direction)
      return Math.abs(
        direction.y * (solved!.point.x - ray.origin.x) -
        direction.x * (solved!.point.y - ray.origin.y),
      )
    })
    .sort((first, second) => first - second)
  const residualMedian = residuals[Math.floor(residuals.length / 2)] ?? 0
  const trimThreshold = Math.max(0.028, residualMedian * 2.8)
  const retained = rays.filter((ray) => {
    const direction = normalize(ray.direction)
    const residual = Math.abs(
      direction.y * (solved!.point.x - ray.origin.x) -
      direction.x * (solved!.point.y - ray.origin.y),
    )
    return residual <= trimThreshold
  })
  if (retained.length >= 3 && retained.length < rays.length) {
    solved = solveGradientLines(retained)
    if (!solved) return null
  }
  const used = retained.length >= 3 ? retained : rays

  let weightedSquaredResidual = 0
  let forwardWeight = 0
  let totalWeight = 0
  let poseSpan = 0
  for (let index = 0; index < used.length; index += 1) {
    const ray = used[index]!
    const direction = normalize(ray.direction)
    const displacement = sub(solved.point, ray.origin)
    const perpendicular = direction.y * displacement.x - direction.x * displacement.y
    const weight = clamp(ray.weight, 0, 1)
    weightedSquaredResidual += weight * perpendicular * perpendicular
    totalWeight += weight
    if (dot(displacement, direction) >= -0.012) forwardWeight += weight
    for (let other = index + 1; other < used.length; other += 1) {
      poseSpan = Math.max(poseSpan, distance(ray.origin, used[other]!.origin))
    }
  }
  const residual = Math.sqrt(weightedSquaredResidual / Math.max(1e-12, totalWeight))
  const forwardFraction = forwardWeight / Math.max(1e-12, totalWeight)
  const bounded =
    solved.point.x >= -0.05 && solved.point.x <= 1.05 &&
    solved.point.y >= -0.05 && solved.point.y <= 1.05
  if (
    !bounded ||
    solved.geometryQuality < 0.012 ||
    forwardFraction < 0.62 ||
    poseSpan < 0.018 ||
    residual > 0.12
  ) {
    return null
  }

  const quality = clamp(
    Math.sqrt(solved.geometryQuality) *
    forwardFraction *
    clamp(poseSpan / 0.12) *
    Math.exp(-residual / 0.055),
  )
  return {
    point: {
      x: clamp(solved.point.x, 0.01, 0.99),
      y: clamp(solved.point.y, 0.01, 0.99),
    },
    residual,
    geometryQuality: solved.geometryQuality,
    forwardFraction,
    poseSpan,
    quality,
    rayCount: used.length,
  }
}

/**
 * Four-channel soil-emergence search controller.
 *
 * It never calls the plume likelihood or concentration field. Active returns
 * are used for movement and ray geometry only; terminal core/ring evidence is
 * computed exclusively from valid passive samples.
 */
export class QuadSoilSniffController implements AlgorithmController {
  readonly metadata

  constructor(
    private readonly samplingMode: QuadSamplingMode = 'active-suction',
    private readonly candidatePolicy: QuadCandidatePolicy = 'staged-three-ray',
    private readonly confirmationScheduling: 'frozen' | 'priority-dwell' = 'frozen',
    private readonly rayDirectionMode: QuadRayDirectionMode = 'measured-gradient',
  ) {
    this.metadata = ALGORITHM_METADATA[rayDirectionMode === 'wind-constrained-refine'
      ? 'quad-sniff-refine'
      : rayDirectionMode === 'wind-constrained-bracket'
        ? 'quad-sniff-bracket'
      : rayDirectionMode === 'wind-constrained-corridor'
        ? 'quad-sniff-corridor'
      : rayDirectionMode === 'wind-constrained-range'
        ? 'quad-sniff-range'
      : rayDirectionMode === 'wind-constrained'
        ? 'quad-sniff-wind'
      : confirmationScheduling === 'priority-dwell'
      ? 'quad-sniff-confirmation'
      : samplingMode === 'passive-array'
      ? 'quad-passive'
      : candidatePolicy === 'legacy-four-ray-surface'
        ? 'quad-sniff-legacy'
        : candidatePolicy === 'staged-three-ray'
          ? 'quad-sniff-staged'
          : candidatePolicy === 'adaptive-viewpoint' ? 'quad-sniff-adaptive' : 'quad-sniff']
  }

  private environment!: AlgorithmEnvironment
  private get inspection() {
    return this.rayDirectionMode === 'wind-constrained-refine' ? this.environment.inspectionContract : undefined
  }
  private mode: SearchMode = 'acquire'
  private passiveSamples: PassiveSample[] = []
  private confirmationSamples: PassiveSample[] = []
  private bestPassive: PassiveSample | null = null
  private lastPassiveHitTime = -Infinity
  private everPassiveHit = false
  private lastActiveSignalTime = -Infinity
  private acquisitionWaypoints: Vec2[] = []
  private acquisitionIndex = 0
  private castSide = 1

  private scanSequence = 0
  private physicalScanPose: Vec2 | null = null
  private physicalCompletedScansAtPose = 0
  private physicalRelocation: { target: Vec2 | null; startedAt: number; failed: boolean } | null = null
  private pendingScanId: number | null = null
  private scanIssuedAt = -Infinity
  private lastScanAt = -Infinity
  private nextScanAt = 0
  private lastScanPosition: Vec2 | null = null
  private forceStationaryRescan = false
  private contactScanDue = false
  private triangulationAnchor: Vec2 | null = null
  private adaptiveViewpoint: AdaptiveViewpointSelection | null = null
  private adaptiveViewpointRayCount = -1
  private adaptiveViewpointSequence = 0
  private viewpointHistory: Vec2[] = []
  private confirmationCandidate: Vec2 | null = null
  private confirmationWaypoints: Vec2[] = []
  private confirmationIndex = 0
  private confirmationWaypointReachedAt: number | null = null
  private confirmationCompletedAt: number | null = null
  private confirmationStartedAt: number | null = null
  private confirmationWind: Vec2 | null = null
  private inspectionPrior: { ray: GradientRayEstimate; stability: { count: number; span: number; radius: number };
    startedAt: number; deadline: number } | null = null
  private inspectionBudgetExhausted = false
  private inspectionOutcome = 'not-started'
  private lifecycleTime = 0
  private physicalViewpoint: { target: Vec2; arrivalRadius: number; deadline: number } | null = null
  private physicalViewpointSequence = 0
  private localGradientMove: {target:Vec2;arrivalRadius:number;deadline:number} | null = null
  private localGradientOutcome = 'not-started'
  private localMaximum: LocalMaximumProbe | null = null
  private bracketSkippedFlanks = new Set<number>()
  private lastBracketStatus: QuadBracketEvidenceStatus | null = null
  private refinementCandidate: Vec2 | null = null
  private refinementUpdates = 0
  private lastFailedConfirmationAt = -Infinity

  private gradientRays: GradientRay[] = []
  private rayEstimate: GradientRayEstimate | null = null
  private estimateHistory: Array<{ time: number; point: Vec2 }> = []
  private surfaceEvidence: SurfaceEvidence[] = []
  private rangeBelief: QuadRangeBelief | null = null
  private corridorBelief: QuadCorridorBelief | null = null
  private lastGradientDirection: Vec2 = ZERO
  private lastGradientQuality = 0
  private burstUntil = -Infinity

  private terminated = false
  private abstained = false
  private terminationReason: string | undefined

  reset(environment: AlgorithmEnvironment) {
    this.environment = environment
    this.inspectionPrior = null
    this.inspectionBudgetExhausted = false
    this.inspectionOutcome = 'not-started'
    this.lifecycleTime = 0
    this.physicalViewpoint = null
    this.physicalViewpointSequence = 0
    this.localGradientMove = null
    this.localGradientOutcome = 'not-started'
    this.localMaximum = environment.localMaximum ? new LocalMaximumProbe(environment) : null
    this.mode = 'acquire'
    this.passiveSamples = []
    this.confirmationSamples = []
    this.bestPassive = null
    this.lastPassiveHitTime = -Infinity
    this.everPassiveHit = false
    this.lastActiveSignalTime = -Infinity
    this.acquisitionWaypoints = buildAcquisitionWaypoints(environment.scenario.robotStart)
    this.acquisitionIndex = 0
    this.castSide = environment.controllerSeed % 2 === 0 ? 1 : -1
    this.scanSequence = 0
    this.physicalScanPose = null
    this.physicalCompletedScansAtPose = 0
    this.physicalRelocation = null
    this.pendingScanId = null
    this.scanIssuedAt = -Infinity
    this.lastScanAt = -Infinity
    this.nextScanAt = 0
    this.lastScanPosition = null
    this.forceStationaryRescan = false
    this.contactScanDue = false
    this.triangulationAnchor = null
    this.adaptiveViewpoint = null
    this.adaptiveViewpointRayCount = -1
    this.adaptiveViewpointSequence = 0
    this.viewpointHistory = []
    this.confirmationCandidate = null
    this.confirmationWaypoints = []
    this.confirmationIndex = 0
    this.confirmationWaypointReachedAt = null
    this.confirmationCompletedAt = null
    this.confirmationStartedAt = null
    this.confirmationWind = null
    this.bracketSkippedFlanks.clear()
    this.lastBracketStatus = null
    this.refinementCandidate = null
    this.refinementUpdates = 0
    this.lastFailedConfirmationAt = -Infinity
    this.gradientRays = []
    this.rayEstimate = null
    this.estimateHistory = []
    this.surfaceEvidence = []
    this.rangeBelief = null
    this.corridorBelief = null
    this.lastGradientDirection = ZERO
    this.lastGradientQuality = 0
    this.burstUntil = -Infinity
    this.terminated = false
    this.abstained = false
    this.terminationReason = undefined
  }

  private observePassive(input: AlgorithmStepInput) {
    if (!input.measurement.valid || input.measurement.sampleMode !== 'passive') return
    const sample: PassiveSample = {
      time: input.time,
      position: copyPoint(input.position),
      concentration: Math.max(0, input.measurement.concentration),
      hit: input.measurement.hit,
    }
    this.passiveSamples.push(sample)
    if (this.passiveSamples.length > MAX_PASSIVE_SAMPLES) this.passiveSamples.shift()
    const confirmationTarget = this.confirmationWaypoints[this.confirmationIndex]
    if (
      this.confirmationStartedAt !== null &&
      this.confirmationWaypointReachedAt !== null &&
      (!this.inspection || sample.time >= this.confirmationWaypointReachedAt + this.inspection.settlingSeconds) &&
      confirmationTarget &&
      distance(sample.position, confirmationTarget) <=
        (this.inspection?.arrivalRadiusNormalized ?? QUAD_GEOMETRY_CONDITIONED_POLICY.confirmationArrivalRadiusNormalized)
    ) this.confirmationSamples.push(sample)
    if (!this.bestPassive || sample.concentration > this.bestPassive.concentration) {
      this.bestPassive = sample
    }
    if (sample.hit) {
      if (!this.everPassiveHit) this.contactScanDue = true
      this.lastPassiveHitTime = input.time
      this.everPassiveHit = true
    }
  }

  private hasAcquisitionEvidence(time: number) {
    return this.everPassiveHit || time - this.lastActiveSignalTime <= 12
  }

  private expireUnsupportedActiveEvidence(time: number) {
    if (this.inspectionPrior) return
    if (
      this.everPassiveHit ||
      !Number.isFinite(this.lastActiveSignalTime) ||
      time - this.lastActiveSignalTime <= 12
    ) return
    this.lastActiveSignalTime = -Infinity
    this.lastGradientDirection = ZERO
    this.lastGradientQuality = 0
    this.gradientRays = []
    this.rayEstimate = null
    this.estimateHistory = []
    this.surfaceEvidence = []
    this.forceStationaryRescan = false
    this.burstUntil = -Infinity
    this.triangulationAnchor = null
    this.adaptiveViewpoint = null
    this.adaptiveViewpointRayCount = -1
    this.viewpointHistory = []
    this.confirmationCandidate = null
    this.confirmationWaypoints = []
    this.confirmationIndex = 0
    this.confirmationWaypointReachedAt = null
    this.confirmationCompletedAt = null
    this.confirmationStartedAt = null
    this.confirmationSamples = []
    this.confirmationWind = null
    this.bracketSkippedFlanks.clear()
    this.lastBracketStatus = null
    this.refinementCandidate = null
    this.refinementUpdates = 0
    if (this.mode !== 'await-quad') this.mode = 'acquire'
  }

  private usesAdaptiveViewpoints() {
    return this.candidatePolicy === 'adaptive-viewpoint' ||
      this.candidatePolicy === 'geometry-conditioned'
  }

  private usesCandidateConfirmation() {
    return this.usesAdaptiveViewpoints()
  }

  private rayRetentionSeconds() {
    if (this.candidatePolicy === 'legacy-four-ray-surface') return 28
    if (this.candidatePolicy === 'adaptive-viewpoint') {
      return QUAD_ADAPTIVE_VIEWPOINT_POLICY.rayRetentionSeconds
    }
    return this.candidatePolicy === 'geometry-conditioned'
      ? QUAD_GEOMETRY_CONDITIONED_POLICY.rayRetentionSeconds
      : QUAD_STAGED_CROSSWIND_POLICY.rayRetentionSeconds
  }

  private expireGradientRays(time: number) {
    const retained = this.gradientRays.filter(
        (ray) => ray.time >= time - this.rayRetentionSeconds(),
    )
    if (retained.length === this.gradientRays.length) return
    this.gradientRays = retained
    this.rayEstimate = this.intersectCurrentRays(retained)
    if (!this.rayEstimate) this.estimateHistory = []
    if (retained.length === 0 && !this.inspectionPrior) {
      // A bounded trip is not evidence: let it finish even if all old rays expire.
      if (!this.environment.rayWindowPolicy) this.physicalViewpoint = null
      this.triangulationAnchor = null
      this.adaptiveViewpoint = null
      this.adaptiveViewpointRayCount = -1
      this.viewpointHistory = []
      this.confirmationCandidate = null
      this.confirmationWaypoints = []
      this.confirmationIndex = 0
      this.confirmationWaypointReachedAt = null
      this.confirmationCompletedAt = null
      this.confirmationStartedAt = null
      this.confirmationSamples = []
      this.confirmationWind = null
      this.bracketSkippedFlanks.clear()
      this.lastBracketStatus = null
      this.refinementCandidate = null
      this.refinementUpdates = 0
    }
  }

  private candidateFormationStatus(): QuadCandidateFormationStatus {
    const ray = this.rayEstimate
    const surfaceSupportCount = ray
      ? this.surfaceEvidence.filter(
          (item) => distance(item.position, ray.point) <= 0.085,
        ).length
      : 0
    return evaluateQuadCandidateFormation({
      gradientRayPoolCount: this.gradientRays.length,
      ray,
      surfaceSupportCount,
      policy: this.candidatePolicy,
    })
  }

  private trustedRayEstimate() {
    if (this.environment.localGradientPolicy) return null
    if (this.inspectionPrior) return this.inspectionPrior.ray
    if (this.environment.bearingGeometry && this.environment.bearingAblation !== 'legacy-geometry') {
      const uncertainty = this.rayEstimate?.physicalUncertainty
      if (!uncertainty || (this.environment.bearingAblation === 'no-radius-gate'
        ? uncertainty.reducedChiSquare > 9 : !uncertainty.acceptable)) return null
    }
    if (this.environment.candidateLifecycle) {
      const stability = this.estimateStability()
      if (stability.count < 3 || stability.span < 2 || stability.radius > 0.035) return null
    }
    const formation = this.candidateFormationStatus()
    return formation.trustedCandidate ? this.rayEstimate : null
  }

  /** Read-only research instrumentation. Never appended to legacy decisions or
   * used to steer the controller. Raw-ray gates are distinct from a held prior.
   */
  getPhysicalDiagnostics() {
    const uncertainty = this.rayEstimate?.physicalUncertainty
    const stability = this.estimateStability()
    const formation = this.candidateFormationStatus()
    const usesPhysical = Boolean(this.environment.bearingGeometry && this.environment.bearingAblation !== 'legacy-geometry')
    const gates = {
      rayFreshness: this.gradientRays.every(ray => ray.time >= this.lifecycleTime - this.rayRetentionSeconds()),
      physicalModelAvailable: !usesPhysical || Boolean(uncertainty),
      nominalRadius: !usesPhysical || this.environment.bearingAblation === 'no-radius-gate' || Boolean(uncertainty && uncertainty.nominalRadius95 <= (this.environment.inspectionContract?.offsetNormalized ?? 0)),
      residualConsistency: !usesPhysical || Boolean(uncertainty && uncertainty.reducedChiSquare <= 9),
      physicalAcceptance: !usesPhysical || Boolean(uncertainty && (this.environment.bearingAblation === 'no-radius-gate' ? uncertainty.reducedChiSquare <= 9 : uncertainty.acceptable)),
      stabilityCount: !this.environment.candidateLifecycle || stability.count >= 3,
      stabilitySpan: !this.environment.candidateLifecycle || stability.span >= 2,
      stabilityRadius: !this.environment.candidateLifecycle || stability.radius <= 0.035,
      formation: formation.trustedCandidate,
    }
    return structuredClone({ time: this.lifecycleTime, retentionSeconds: this.rayRetentionSeconds(),
      rayTimes: this.gradientRays.map(ray => ray.time), rayEstimate: this.rayEstimate,
      stability, gates, rawRayEligible: Object.values(gates).every(Boolean),
      heldPrior: this.inspectionPrior, inspectionOutcome: this.inspectionOutcome,
      inspectionBudgetExhausted: this.inspectionBudgetExhausted,
      plannedViewpoint: this.physicalViewpoint, pendingScanId: this.pendingScanId,
      ...(this.environment.localGradientPolicy ? { localGradientMove: this.localGradientMove,
        localGradientOutcome: this.localGradientOutcome } : {}),
      ...(this.localMaximum ? {localMaximum:this.localMaximum.snapshot()} : {}) })
  }

  private currentEstimate() {
    if (this.environment.localGradientPolicy) return null
    if (this.rayDirectionMode === 'wind-constrained-refine' && this.refinementCandidate) {
      return this.refinementCandidate
    }
    if (
      this.rayDirectionMode === 'wind-constrained-corridor' &&
      this.corridorBelief?.accepted
    ) {
      return this.corridorBelief.estimate
    }
    if (this.rayDirectionMode === 'wind-constrained-range' && this.rangeBelief) {
      return this.rangeBelief.estimate
    }
    const trustedRay = this.trustedRayEstimate()
    if (trustedRay) return trustedRay.point
    if (!this.bestPassive) return null
    const peak = this.bestPassive
    const hits = this.passiveSamples.filter((sample) => sample.hit)
    if (hits.length >= 4) {
      const maximumHit = Math.max(...hits.map((sample) => sample.concentration))
      const supported = hits.filter((sample) => {
        if (sample.concentration < maximumHit * 0.35) return false
        const neighbours = hits.filter(
          (other) =>
            Math.abs(other.time - sample.time) <= 5 &&
            distance(other.position, sample.position) <= 0.045,
        ).length
        return neighbours >= 2
      })
      if (supported.length >= 3) {
        const upwind = scale(
          normalize(this.environment.scenario.baseWind, { x: -1, y: 0 }),
          -1,
        )
        const frontierProjection = Math.max(
          ...supported.map((sample) => dot(sample.position, upwind)),
        )
        const frontier = supported.filter(
          (sample) =>
            frontierProjection - dot(sample.position, upwind) <= 0.035,
        )
        if (frontier.length >= 2) {
          let totalWeight = 0
          let weighted = ZERO
          for (const sample of frontier) {
            const setback = frontierProjection - dot(sample.position, upwind)
            const weight =
              Math.max(1e-5, sample.concentration) ** 2 *
              Math.exp(-setback / 0.018)
            totalWeight += weight
            weighted = add(weighted, scale(sample.position, weight))
          }
          if (totalWeight > 0) return scale(weighted, 1 / totalWeight)
        }
      }
    }
    const nearby = this.passiveSamples.filter(
      (sample) =>
        peak.time - sample.time <= 45 &&
        distance(sample.position, peak.position) <= 0.026 &&
        sample.concentration >= peak.concentration * 0.78,
    )
    if (nearby.length < 3) return peak.position
    const floor = peak.concentration * 0.72
    let totalWeight = 0
    let weighted = ZERO
    for (const sample of nearby) {
      const weight = Math.max(1e-5, sample.concentration - floor) ** 2
      totalWeight += weight
      weighted = add(weighted, scale(sample.position, weight))
    }
    return totalWeight > 0 ? scale(weighted, 1 / totalWeight) : peak.position
  }

  private passiveEvidence(candidate: Vec2 | null) {
    if (!candidate) {
      return {
        coreCount: 0,
        coreHits: 0,
        ringCount: 0,
        coreMean: 0,
        ringMean: 0,
        contrast: 0,
      }
    }
    const newest = this.passiveSamples[this.passiveSamples.length - 1]?.time ?? 0
    const recent = this.passiveSamples.filter((sample) => sample.time >= newest - 55)
    const core = recent.filter((sample) => distance(sample.position, candidate) <= 0.038)
    const ring = recent.filter((sample) => {
      const radius = distance(sample.position, candidate)
      return radius >= 0.052 && radius <= 0.135
    })
    const coreMean = mean(core.map((sample) => sample.concentration))
    const ringMean = mean(ring.map((sample) => sample.concentration))
    return {
      coreCount: core.length,
      coreHits: core.filter((sample) => sample.hit).length,
      ringCount: ring.length,
      coreMean,
      ringMean,
      contrast: (coreMean - ringMean) / Math.max(0.03, coreMean, ringMean),
    }
  }

  private estimateStability() {
    const recent = (this.environment.candidateLifecycle
      ? this.estimateHistory.filter(item => item.time >= this.lifecycleTime - this.rayRetentionSeconds())
      : this.estimateHistory).slice(-7)
    if (recent.length === 0) return { count: 0, span: 0, radius: 1 }
    const center = scale(
      recent.reduce((sum, item) => add(sum, item.point), ZERO),
      1 / recent.length,
    )
    const radius = Math.sqrt(
      recent.reduce((sum, item) => sum + distance(item.point, center) ** 2, 0) /
      recent.length,
    )
    return {
      count: recent.length,
      span: (recent[recent.length - 1]?.time ?? 0) - (recent[0]?.time ?? 0),
      radius,
    }
  }

  private localSurfaceEvidence(candidate: Vec2 | null, time: number) {
    if (!candidate) return { count: 0, meanScore: 0 }
    const local = this.surfaceEvidence.filter(
      (item) => item.time >= time - 35 && distance(item.position, candidate) <= 0.06,
    )
    return {
      count: local.length,
      meanScore: mean(local.map((item) => item.score)),
    }
  }

  private declarationEvidence(input: AlgorithmStepInput): DeclarationEvidence {
    const candidateFormation = this.candidateFormationStatus()
    const trustedRay = candidateFormation.trustedCandidate ? this.rayEstimate : null
    if (!trustedRay) {
      const gates = Object.fromEntries(
        QUAD_DECLARATION_GATE_NAMES.map((name) => [name, false]),
      ) as Record<QuadDeclarationGateName, boolean>
      return {
        candidate: null,
        ready: false,
        score: 0,
        rayScore: 0,
        stabilityScore: 0,
        surfaceScore: 0,
        passiveScore: 0,
        gatesPassed: 0,
        gates,
        candidateFormation,
        raw: {
          rayQuality: 0,
          rayResidual: 0,
          stabilityCount: 0,
          stabilitySpan: 0,
          stabilityRadius: 1,
          surfaceCount: 0,
          surfaceMeanScore: 0,
          passiveCoreCount: 0,
          passiveCoreHits: 0,
          passiveRingCount: 0,
          passiveCoreMean: 0,
          passiveContrast: 0,
          secondsSincePassiveHit: null,
          distanceToCandidate: null,
        },
      }
    }
    const candidate = trustedRay.point
    const passive = this.passiveEvidence(candidate)
    const stability = this.estimateStability()
    const surface = this.localSurfaceEvidence(candidate, input.time)
    const scored = evaluateQuadDeclarationEvidence({
      ray: trustedRay,
      stability,
      surface,
      passive,
      secondsSincePassiveHit: input.time - this.lastPassiveHitTime,
      distanceToCandidate: distance(input.position, candidate),
    })
    return {
      candidate,
      ...scored,
      candidateFormation,
    }
  }

  private abstentionReady(input: AlgorithmStepInput) {
    const decisionTime = Math.max(30, this.environment.durationSeconds * 0.9)
    const surveyed = this.acquisitionIndex >= this.acquisitionWaypoints.length - 2 ||
      input.distance >= 3.2
    return Boolean(
      input.time >= decisionTime &&
      surveyed &&
      !this.everPassiveHit &&
      !Number.isFinite(this.lastActiveSignalTime) &&
      this.gradientRays.length === 0 &&
      (this.bestPassive?.concentration ?? 0) < 0.08,
    )
  }

  private confidence(time: number) {
    const candidate = this.currentEstimate()
    const passive = this.passiveEvidence(candidate)
    const stability = this.estimateStability()
    const surface = this.localSurfaceEvidence(candidate, time)
    const ray = this.trustedRayEstimate()?.quality ?? 0
    const passiveSupport = clamp(
      (passive.coreHits + passive.ringCount * 0.2) / 10,
    )
    const stable = clamp(1 - stability.radius / 0.08) * clamp(stability.count / 4)
    const verified = clamp(surface.count / 2) * clamp(surface.meanScore)
    return clamp(ray * 0.36 + passiveSupport * 0.28 + stable * 0.2 + verified * 0.16)
  }

  private scanForward(input: AlgorithmStepInput) {
    // The four inlet labels are body-frame directions. Keeping the array tied
    // to measured robot heading avoids a free, instantaneous gimbal rotation.
    return { x: Math.cos(input.heading), y: Math.sin(input.heading) }
  }

  private issueScan(input: AlgorithmStepInput): AlgorithmDecision {
    const scan = this.environment.localScanPolicy
    if (scan && (!this.physicalScanPose || distance(input.position, this.physicalScanPose) >=
        scan.relocationDistanceNormalized - scan.arrivalRadiusNormalized)) {
      this.physicalScanPose = copyPoint(input.position)
      this.physicalCompletedScansAtPose = 0
    }
    this.contactScanDue = false
    this.scanSequence += 1
    this.pendingScanId = this.scanSequence
    this.scanIssuedAt = input.time
    this.lastScanPosition = copyPoint(input.position)
    this.mode = 'await-quad'
    const forward = this.scanForward(input)
    return {
      direction: ZERO,
      estimate: this.currentEstimate(),
      confidence: this.confidence(input.time),
      phase: this.samplingMode === 'passive-array'
        ? 'SIMULTANEOUS PASSIVE ARRAY INTEGRATION'
        : 'SIMULTANEOUS QUAD ASPIRATION',
      quadSniff: {
        scanId: this.scanSequence,
        forward,
      },
      debug: {
        target: this.currentEstimate() ?? undefined,
        note: this.samplingMode === 'passive-array'
          ? 'Four spatially separated passive heads integrate synchronously; no suction or remote entrainment is applied.'
          : 'One synchronized four-channel draw; controller waits for sensor-processed returns.',
      },
    }
  }

  private surfaceScore(result: QuadGradientEstimate) {
    const signal = clamp((result.commonMean - 0.32) / 0.45)
    const symmetry = clamp(1 - result.normalizedContrast / 0.24)
    return clamp(
      signal * symmetry * result.supportQuality * Math.sqrt(result.geometryQuality),
    )
  }

  private acceptQuadReturn(input: AlgorithmStepInput) {
    if (this.environment.acquisitionPolicy) this.physicalViewpoint = null
    const status = input.measurement.quadSniff
    const readings = status?.readings ?? []
    const result = estimateQuadGradient(readings, this.environment.sensorNoise, this.environment.gradientEstimator)
    const anyChannelSaturated = readings.some((reading) => reading.saturated)
    const actuationStrength = clamp(status?.strength ?? 0)
    const passiveArray = status?.samplingMode === 'passive-array'
    const directionalSampling = passiveArray || actuationStrength >= 0.05
    if (this.usesAdaptiveViewpoints() && this.gradientRays.length > 0) {
      if (this.candidatePolicy === 'geometry-conditioned' &&
          !this.viewpointHistory.some((point) => distance(point, input.position) < 0.005)) {
        this.viewpointHistory.push(copyPoint(input.position))
        if (this.viewpointHistory.length > 20) this.viewpointHistory.shift()
      }
      // Every completed scan consumes the selected pose. A new public target
      // is selected even when the return is non-directional, preventing a
      // stalled rescan loop in an occluded or stagnant pocket.
      this.adaptiveViewpoint = null
      this.adaptiveViewpointRayCount = -1
    }
    const activeSignal = Boolean(
      directionalSampling &&
      result.commonMean >= 0.11 &&
      result.supportQuality >= 0.45 &&
      readings.filter((reading) => reading.hit).length >= 2,
    )
    if (activeSignal) this.lastActiveSignalTime = input.time
    if (this.environment.localGradientPolicy) {
      // Acquisition-only branch. Never create a source ray, surface prior or
      // inferred source estimate from this gradient, even when its SNR is high.
      this.localGradientMove = null
      this.localGradientOutcome = 'unreliable-cue; legacy-reacquisition'
      const usable = directionalSampling && !anyChannelSaturated && result.validDirection &&
        result.commonMean >= 0.16 && result.quality >= 0.08 && result.usableChannels === 4 &&
        result.geometryQuality >= 1 - 1e-9 && result.supportQuality >= 1 - 1e-9
      if (usable) {
        const plan = selectLocalGradientStep(this.environment, input.position, result.direction, input.dt)
        if (!plan) this.localGradientOutcome = 'blocked-step; legacy-reacquisition'
        else if (input.time + plan.returnAllowance > this.environment.durationSeconds) this.localGradientOutcome = 'mission-budget-exhausted'
        else {
          this.localGradientMove = { target: plan.target, arrivalRadius: plan.arrivalRadius,
            deadline: input.time + plan.travelAllowance }
          this.localGradientOutcome = 'following-measured-local-gradient'
        }
      }
      this.lastGradientQuality = 0 // No stale gradient burst in fallback motion.
      this.localMaximum?.observeScan(input,result.commonMean,result.validDirection,
        directionalSampling&&!anyChannelSaturated&&result.usableChannels===4&&result.supportQuality>=1-1e-9&&result.geometryQuality>=1-1e-9,
        this.environment.localMaximum?.nomination?result.direction:undefined,usable)
      if(this.environment.localMaximum?.nomination&&this.localMaximum?.hasActiveAttempt()) {
        this.localGradientMove=null
        this.localGradientOutcome='local-contrast-probe-in-progress'
      }
      this.forceStationaryRescan = false
      this.mode = 'cast'
      this.nextScanAt = input.time + (this.hasAcquisitionEvidence(input.time) ? 5.5 : 18)
      if (this.environment.localScanPolicy) this.physicalCompletedScansAtPose += 1
      this.pendingScanId = null
      this.lastScanAt = input.time
      return result
    }
    const priorSurfaceAtPose = this.surfaceEvidence.filter(
      (item) => input.time - item.time <= 12 && distance(item.position, input.position) <= 0.018,
    ).length
    // A zero-strength scan is a time-matched sham. Even if independent sensor
    // noise makes its four passive readings differ, it must not create an
    // active gradient ray or surface-verification anchor.
    const evidenceScale = passiveArray ? 1 : actuationStrength
    const surfaceScore = this.surfaceScore(result) * evidenceScale
    const isSurfaceLike = Boolean(
      directionalSampling &&
      !anyChannelSaturated &&
      result.commonMean >= 0.42 &&
      result.normalizedContrast <= 0.22 &&
      result.supportQuality >= 0.5 &&
      result.geometryQuality >= 0.3 &&
      surfaceScore >= 0.32,
    )

    if (isSurfaceLike) {
      this.surfaceEvidence.push({
        time: input.time,
        position: copyPoint(input.position),
        score: surfaceScore,
        commonMean: result.commonMean,
        normalizedContrast: result.normalizedContrast,
      })
      if (this.surfaceEvidence.length > 20) this.surfaceEvidence.shift()
    }

    if (result.validDirection && directionalSampling) {
      const sourceDirection = (!this.environment.bearingGeometry || this.environment.bearingAblation === 'wind-bearing') && this.rayDirectionMode !== 'measured-gradient'
        ? windConstrainedSourceDirection(result.direction, input.measurement.wind)
        : result.direction
      if (this.rayDirectionMode === 'wind-constrained-range') {
        this.rangeBelief = inferSourceRangeAlongBearing(
          this.environment, input.observations, input.position, sourceDirection,
        )
      }
      this.lastGradientDirection = sourceDirection
      this.lastGradientQuality = result.quality * evidenceScale
      const retentionSeconds = this.rayRetentionSeconds()
      this.gradientRays = this.gradientRays.filter(
        (ray) => ray.time >= input.time - retentionSeconds,
      )
      const rayHasEnoughSignal =
        result.commonMean >= 0.16 &&
        result.quality * evidenceScale >= 0.08 &&
        (!this.environment.bearingGeometry || (result.usableChannels === 4 &&
          result.geometryQuality >= 1 - 1e-9 && result.supportQuality >= 1 - 1e-9))
      const separated = this.gradientRays.every(
        (ray) => distance(ray.origin, input.position) >= this.minimumRaySeparation(),
      )
      if (rayHasEnoughSignal && separated) {
        if (this.candidatePolicy !== 'legacy-four-ray-surface' && this.gradientRays.length === 0) {
          this.triangulationAnchor = copyPoint(input.position)
        }
        this.gradientRays.push({
          ...(this.environment.bearingGeometry ? { angularSigma: 1 / result.gradientSnr } : {}),
          time: input.time,
          origin: copyPoint(input.position),
          direction: copyPoint(sourceDirection),
          weight: result.quality * evidenceScale,
        })
        if (this.gradientRays.length > MAX_GRADIENT_RAYS) this.gradientRays.shift()
        this.rayEstimate = this.intersectCurrentRays(this.gradientRays)
        if (this.rayEstimate) {
          this.estimateHistory.push({
            time: input.time,
            point: copyPoint(this.rayEstimate.point),
          })
          if (this.estimateHistory.length > MAX_ESTIMATE_HISTORY) {
            this.estimateHistory.shift()
          }
        }
      }
      if (this.rayDirectionMode === 'wind-constrained-corridor') {
        this.corridorBelief = inferSourceCorridorBelief(
          this.environment, input.observations, this.gradientRays,
        )
      }
      this.burstUntil = input.time + (
        result.quality * evidenceScale >= 0.35 ? 2.2 : 1.25
      )
      if (this.candidatePolicy !== 'legacy-four-ray-surface') {
        const candidateReady = this.environment.candidateLifecycle
          ? this.trustedRayEstimate() !== null : this.candidateFormationStatus().trustedCandidate
        this.mode = candidateReady ? 'advance' : this.gradientRays.length > 0 ? 'triangulate' : 'cast'
        this.nextScanAt = input.time + (candidateReady ? 3.2 : this.gradientRays.length > 0 ? 2.2 : 7)
      } else {
        this.mode = 'advance'
        this.nextScanAt = input.time + (result.commonMean >= 0.45 ? 3.2 : 7)
      }
    } else {
      this.lastGradientQuality = 0
      if (this.candidatePolicy !== 'legacy-four-ray-surface') {
        this.mode = isSurfaceLike
          ? 'surface-check'
          : this.gradientRays.length > 0 ? 'triangulate' : 'cast'
        this.nextScanAt = input.time + (
          isSurfaceLike ? 1.5 : this.gradientRays.length > 0 ? 2.2 : this.hasAcquisitionEvidence(input.time) ? 5.5 : 18
        )
      } else {
        this.mode = isSurfaceLike ? 'surface-check' : 'cast'
        this.nextScanAt = input.time + (
          isSurfaceLike ? 1.5 : this.hasAcquisitionEvidence(input.time) ? 5.5 : 18
        )
      }
    }

    this.forceStationaryRescan = isSurfaceLike && priorSurfaceAtPose === 0
    if (this.environment.localScanPolicy) this.physicalCompletedScansAtPose += 1
    this.pendingScanId = null
    this.lastScanAt = input.time
    return result
  }

  private declaredDecision(): AlgorithmDecision {
    const trustedRay = this.trustedRayEstimate()
    return {
      direction: ZERO,
      estimate: this.rayDirectionMode === 'wind-constrained-refine'
        ? this.refinementCandidate ?? this.confirmationCandidate ?? trustedRay?.point ?? null
        : trustedRay?.point ?? this.currentEstimate(),
      confidence: Math.max(0.91, this.confidence(this.lastScanAt)),
      phase: this.rayDirectionMode === 'wind-constrained-bracket' ||
        this.rayDirectionMode === 'wind-constrained-refine'
        ? 'PAIRED SPATIAL BRACKET CONFIRMED'
        : 'SURFACE-PROXY CANDIDATE CONFIRMED',
      nativeTerminated: true,
      terminationReason: this.terminationReason,
      quadBracketEvidence: this.lastBracketStatus ?? undefined,
      debug: {
        target: trustedRay?.point,
        note: this.rayDirectionMode === 'wind-constrained-bracket'
          ? 'Wind-constrained rays guided approach; alternating centre/cardinal passive ranks supplied terminal confirmation.'
          : 'Gradient rays guided localization; terminal core/ring statistics use passive samples only.',
      },
    }
  }

  private abstainedDecision(): AlgorithmDecision {
    return {
      direction: ZERO,
      estimate: null,
      confidence: 0.88,
      phase: 'NO CREDIBLE SOURCE EVIDENCE',
      nativeAbstained: true,
      terminationReason: this.terminationReason,
      debug: {
        note: 'The truth-blind search budget gate found no passive contact, credible array signal, or supported gradient ray after broad survey coverage.',
      },
    }
  }

  private shouldScan(input: AlgorithmStepInput) {
    if (this.environment.candidateLifecycle && this.trustedRayEstimate()) return false
    // A slower physical inspection cannot collect its settled passive samples
    // if legacy periodic scans repeatedly blank the sensor during the dwell.
    if (this.inspection && this.confirmationStartedAt !== null && this.confirmationCompletedAt === null) return false
    if (
      (this.samplingMode === 'active-suction' && !this.environment.activeSniffEnabled) ||
      (!this.contactScanDue && input.time < this.nextScanAt)
    ) return false
    if (this.contactScanDue) return true
    if (!this.hasAcquisitionEvidence(input.time)) {
      if (!this.lastScanPosition) return input.time >= 2
      return input.time - this.lastScanAt >= 18 &&
        distance(input.position, this.lastScanPosition) >= 0.08
    }
    if (this.forceStationaryRescan) return true
    if (!this.lastScanPosition) return true
    const moved = distance(input.position, this.lastScanPosition)
    if (this.usesCandidateConfirmation()) {
      const trusted = this.trustedRayEstimate()
      if (trusted) {
        const target = this.candidateConfirmationTarget(input, trusted.point)
        const arrivalRadius = this.candidatePolicy === 'geometry-conditioned'
          ? QUAD_GEOMETRY_CONDITIONED_POLICY.confirmationArrivalRadiusNormalized
          : QUAD_ADAPTIVE_VIEWPOINT_POLICY.confirmationArrivalRadiusNormalized
        return distance(input.position, target) <=
          arrivalRadius &&
          input.time - this.lastScanAt >= 4.5
      }
      if (this.mode === 'triangulate' && this.gradientRays.length > 0) {
        const viewpoint = this.adaptiveTriangulationTarget(input)
        return viewpoint
          ? distance(input.position, viewpoint.target) <= 0.018 ||
              (input.time - this.lastScanAt >= 8 && moved >= 0.05)
          : moved >= 0.04
      }
    }
    const nearCandidate = this.currentEstimate()
      ? distance(input.position, this.currentEstimate()!) <= 0.075
      : false
    return moved >= 0.024 || (nearCandidate && input.time - this.lastScanAt >= 4.5)
  }

  private adaptiveTriangulationTarget(input: AlgorithmStepInput) {
    if (
      this.adaptiveViewpoint &&
      this.adaptiveViewpointRayCount === this.gradientRays.length &&
      !this.environment.isBlocked(this.adaptiveViewpoint.target, 0.012)
    ) return this.adaptiveViewpoint
    const anchor = this.triangulationAnchor ?? this.gradientRays[0]?.origin
    if (!anchor) return null
    const preferredSide = (
      (this.adaptiveViewpointSequence % 2 === 0 ? 1 : -1) * this.castSide
    ) as 1 | -1
    const shared = {
      environment: this.environment,
      currentPosition: input.position,
      anchor,
      cueDirection: magnitude(this.lastGradientDirection) > 1e-9
        ? this.lastGradientDirection
        : this.gradientRays[0]?.direction ?? { x: -1, y: 0 },
      measuredWind: input.measurement.wind,
      rays: this.gradientRays,
      preferredSide,
    }
    const selected = this.candidatePolicy === 'geometry-conditioned'
      ? selectGeometryConditionedQuadViewpoint({
          ...shared,
          visitedViewpoints: this.viewpointHistory,
        })
      : selectAdaptiveQuadViewpoint(shared)
    this.adaptiveViewpoint = selected
    this.adaptiveViewpointRayCount = this.gradientRays.length
    this.adaptiveViewpointSequence += 1
    return selected
  }

  private adaptiveConfirmationTarget(input: AlgorithmStepInput, candidate: Vec2) {
    if (!this.confirmationCandidate || distance(this.confirmationCandidate, candidate) > 0.025) {
      this.confirmationCandidate = copyPoint(candidate)
      this.confirmationWaypoints = this.rayDirectionMode === 'wind-constrained-refine'
        ? buildCoordinateRefinementWaypoints(
            candidate, input.measurement.wind, this.castSide as 1 | -1,
          )
        : buildAdaptiveConfirmationWaypoints(
            candidate, input.measurement.wind, this.castSide as 1 | -1,
          )
      this.confirmationIndex = 0
      this.confirmationWaypointReachedAt = null
    }
    while (this.confirmationIndex < this.confirmationWaypoints.length - 1) {
      const target = this.confirmationWaypoints[this.confirmationIndex]!
      if (this.environment.isBlocked(target, 0.01)) {
        this.confirmationIndex += 1
        this.confirmationWaypointReachedAt = null
        continue
      }
      if (distance(input.position, target) <=
          QUAD_ADAPTIVE_VIEWPOINT_POLICY.confirmationArrivalRadiusNormalized) {
        this.confirmationWaypointReachedAt ??= input.time
        if (input.time - this.confirmationWaypointReachedAt >=
            QUAD_ADAPTIVE_VIEWPOINT_POLICY.confirmationDwellSeconds) {
          this.confirmationIndex += 1
          this.confirmationWaypointReachedAt = null
          continue
        }
      } else {
        this.confirmationWaypointReachedAt = null
      }
      break
    }
    return this.confirmationWaypoints[this.confirmationIndex] ?? candidate
  }

  private geometryConfirmationTarget(input: AlgorithmStepInput, candidate: Vec2) {
    if (!this.confirmationCandidate || distance(this.confirmationCandidate, candidate) > 0.025) {
      this.confirmationCandidate = copyPoint(candidate)
      this.confirmationWaypoints = this.rayDirectionMode === 'wind-constrained-refine'
        ? buildCoordinateRefinementWaypoints(
            candidate, input.measurement.wind, this.castSide as 1 | -1, this.inspection?.offsetNormalized,
          )
        : buildAdaptiveConfirmationWaypoints(
            candidate, input.measurement.wind, this.castSide as 1 | -1,
          )
      this.confirmationIndex = 0
      this.confirmationWaypointReachedAt = null
      this.confirmationCompletedAt = null
      this.confirmationStartedAt = input.time
      this.confirmationSamples = []
      this.confirmationWind = copyPoint(input.measurement.wind)
      this.bracketSkippedFlanks.clear()
      this.lastBracketStatus = null
    }
    while (this.confirmationIndex < this.confirmationWaypoints.length) {
      const target = this.confirmationWaypoints[this.confirmationIndex]!
      if (this.environment.isBlocked(target, this.inspection ? undefined : 0.01)) {
        if (this.rayDirectionMode === 'wind-constrained-bracket' ||
            this.rayDirectionMode === 'wind-constrained-refine') {
          const flankByWaypoint: Record<number, number> =
            this.rayDirectionMode === 'wind-constrained-refine'
              ? this.inspection && this.castSide < 0 ? { 1: 3, 3: 2, 5: 0 } : { 1: 2, 3: 3, 5: 0 }
              : { 1: 2, 3: 3, 5: 1, 7: 0 }
          const flank = flankByWaypoint[this.confirmationIndex]
          if (flank !== undefined) this.bracketSkippedFlanks.add(flank)
        }
        this.confirmationIndex += 1
        this.confirmationWaypointReachedAt = null
        continue
      }
      if (distance(input.position, target) <=
          (this.inspection?.arrivalRadiusNormalized ?? QUAD_GEOMETRY_CONDITIONED_POLICY.confirmationArrivalRadiusNormalized)) {
        this.confirmationWaypointReachedAt ??= input.time
        const dwellSeconds = this.inspection?.dwellSeconds ?? (this.rayDirectionMode === 'wind-constrained-refine'
          ? QUAD_REFINE_POLICY.dwellSeconds
          : QUAD_GEOMETRY_CONDITIONED_POLICY.confirmationDwellSeconds)
        let retained = 0, lastRetained = -Infinity
        if (this.inspection) for (const sample of this.confirmationSamples) {
          if (sample.time >= this.confirmationWaypointReachedAt + this.inspection.settlingSeconds &&
              distance(sample.position, target) <= this.inspection.arrivalRadiusNormalized &&
              sample.time - lastRetained >= this.inspection.sampleSpacingSeconds) {
            retained += 1; lastRetained = sample.time
          }
        }
        if (input.time - this.confirmationWaypointReachedAt >= dwellSeconds &&
            (!this.inspection || retained >= this.inspection.minimumSamplesPerWaypoint)) {
          this.confirmationIndex += 1
          this.confirmationWaypointReachedAt = null
          continue
        }
      } else {
        this.confirmationWaypointReachedAt = null
      }
      return target
    }
    this.confirmationCompletedAt ??= input.time
    return candidate
  }

  private candidateConfirmationTarget(input: AlgorithmStepInput, candidate: Vec2) {
    return this.candidatePolicy === 'geometry-conditioned'
      ? this.geometryConfirmationTarget(input, candidate)
      : this.adaptiveConfirmationTarget(input, candidate)
  }

  private rejectFailedGeometryConfirmation(input: AlgorithmStepInput) {
    if (this.candidatePolicy !== 'geometry-conditioned' || this.confirmationCompletedAt === null) {
      return false
    }
    if (this.inspectionPrior) {
      this.clearPhysicalInspection(input.time, 'failed-fresh-confirmation')
      return true
    }
    const evidence = this.declarationEvidence(input)
    if (evidence.ready &&
        this.rayDirectionMode !== 'wind-constrained-bracket' &&
        this.rayDirectionMode !== 'wind-constrained-refine') return false
    this.gradientRays = retainStrongestGeometryRay(this.gradientRays)
    this.rayEstimate = null
    this.estimateHistory = []
    this.surfaceEvidence = []
    this.triangulationAnchor = this.gradientRays[0]?.origin ?? copyPoint(input.position)
    this.adaptiveViewpoint = null
    this.adaptiveViewpointRayCount = -1
    this.confirmationCandidate = null
    this.confirmationWaypoints = []
    this.confirmationIndex = 0
    this.confirmationWaypointReachedAt = null
    this.confirmationCompletedAt = null
    this.confirmationStartedAt = null
    this.confirmationWind = null
    this.bracketSkippedFlanks.clear()
    if (this.rayDirectionMode === 'wind-constrained-refine') {
      this.refinementCandidate = null
      this.refinementUpdates = 0
    }
    this.lastFailedConfirmationAt = input.time
    this.mode = this.gradientRays.length ? 'triangulate' : 'cast'
    this.nextScanAt = input.time
    return true
  }

  private bracketStatus(input: AlgorithmStepInput): QuadBracketEvidenceStatus | null {
    if (
      (this.rayDirectionMode !== 'wind-constrained-bracket' &&
        this.rayDirectionMode !== 'wind-constrained-refine') ||
      this.confirmationStartedAt === null
    ) return null
    const ray = this.trustedRayEstimate()
    const candidate = this.confirmationCandidate
    if (!ray || !candidate) return null
    const bracket = evaluateQuadSpatialBracket(
      this.confirmationSamples, candidate,
      this.inspection ? this.confirmationWind ?? input.measurement.wind : input.measurement.wind,
      this.confirmationStartedAt,
      this.rayDirectionMode === 'wind-constrained-refine'
        ? this.inspection?.offsetNormalized ?? QUAD_REFINE_POLICY.offsetNormalized
        : QUAD_BRACKET_POLICY.offsetNormalized,
      this.rayDirectionMode === 'wind-constrained-refine'
        ? this.inspection?.zoneRadiusNormalized ?? QUAD_REFINE_POLICY.zoneRadiusNormalized
        : QUAD_BRACKET_POLICY.zoneRadiusNormalized,
      this.inspection,
    )
    const stability = this.inspectionPrior?.stability ?? this.estimateStability()
    const sampledFlankDirections = bracket.flankCounts.filter(
      (count) => count >= QUAD_BRACKET_POLICY.minimumFlankSamplesPerDirection,
    ).length
    const candidateDistance = distance(input.position, candidate)
    const accessibleFlankDirections = 4 - this.bracketSkippedFlanks.size
    const gates: Record<QuadBracketGateName, boolean> = {
      'confirmation-completed': this.confirmationCompletedAt !== null,
      'accessible-flank-directions': accessibleFlankDirections >=
        QUAD_BRACKET_POLICY.minimumSampledFlankDirections,
      'core-samples': bracket.coreCount >= QUAD_BRACKET_POLICY.minimumCoreSamples,
      'sampled-flank-directions': sampledFlankDirections >=
        QUAD_BRACKET_POLICY.minimumSampledFlankDirections,
      'core-hits': bracket.coreHits >= QUAD_BRACKET_POLICY.minimumCoreHits,
      'directional-wins': bracket.directionalWins >= QUAD_BRACKET_POLICY.minimumDirectionalWins,
      'paired-samples': bracket.pairCount >= QUAD_BRACKET_POLICY.minimumPairs,
      'paired-win-fraction': bracket.pairedWinFraction >= QUAD_BRACKET_POLICY.minimumPairedWinFraction,
      'ray-quality': ray.quality >= QUAD_GEOMETRY_CONDITIONED_POLICY.minimumRayQuality,
      'ray-residual': ray.residual <= QUAD_GEOMETRY_CONDITIONED_POLICY.maximumRayResidual,
      'stability-count': stability.count >= 3,
      'stability-span': stability.span >= 2,
      'stability-radius': stability.radius <= 0.035,
      'candidate-distance': candidateDistance <= QUAD_BRACKET_POLICY.maximumCandidateDistanceNormalized,
    }
    return {
      candidate: copyPoint(candidate),
      startedAt: this.confirmationStartedAt,
      completedAt: this.confirmationCompletedAt,
      accessibleFlankDirections,
      ...bracket,
      sampledFlankDirections,
      rayQuality: ray.quality,
      rayResidual: ray.residual,
      stabilityCount: stability.count,
      stabilitySpan: stability.span,
      stabilityRadius: stability.radius,
      candidateDistance,
      gates,
      gatesPassed: QUAD_BRACKET_GATE_NAMES.filter((name) => gates[name]).length,
      ready: QUAD_BRACKET_GATE_NAMES.every((name) => gates[name]),
    }
  }

  private bracketDeclaration(input: AlgorithmStepInput): AlgorithmDecision | null {
    const status = this.bracketStatus(input)
    if (!status) return null
    this.lastBracketStatus = status
    if (!status.ready) return null
    if (this.inspectionPrior) this.inspectionOutcome = 'confirmed'
    this.terminated = true
    this.mode = 'declared'
    this.terminationReason =
      `Paired spatial bracket confirmed a local rank maximum: ${status.directionalWins}/4 directional wins and ${(status.pairedWinFraction * 100).toFixed(0)}% paired wins.`
    return this.declaredDecision()
  }

  private applyCoordinateRefinement(input: AlgorithmStepInput) {
    // This opt-in lifecycle permits one bracket per acquisition. A failed
    // bracket must reacquire, rather than reuse a frozen prior for more steps.
    if (this.environment.candidateLifecycle) return false
    if (
      this.rayDirectionMode !== 'wind-constrained-refine' ||
      this.confirmationCompletedAt === null ||
      !this.lastBracketStatus ||
      this.refinementUpdates >= QUAD_REFINE_POLICY.maximumUpdates
    ) return false
    const status = this.lastBracketStatus
    let strongest = -1
    for (let index = 0; index < status.flankCounts.length; index += 1) {
      if (status.flankCounts[index]! < QUAD_REFINE_POLICY.minimumFlankSamples) continue
      if (strongest < 0 || status.flankMedians[index]! > status.flankMedians[strongest]!) {
        strongest = index
      }
    }
    if (strongest < 0) return false
    const flank = status.flankMedians[strongest]!
    const relativeGain = (flank - status.coreMedian) /
      Math.max(this.environment.sensorNoise, Math.abs(flank), Math.abs(status.coreMedian))
    if (relativeGain < QUAD_REFINE_POLICY.minimumRelativeImprovement) return false
    const refinementWind = this.inspection ? this.confirmationWind ?? input.measurement.wind : input.measurement.wind
    const upwind = magnitude(refinementWind) > 1e-9
      ? scale(normalize(refinementWind), -1)
      : { x: -1, y: 0 }
    const directions = [upwind, scale(upwind, -1), rotate(upwind, Math.PI / 2),
      rotate(upwind, -Math.PI / 2)]
    this.refinementCandidate = boundedPoint(add(
      status.candidate, scale(directions[strongest]!, this.inspection?.offsetNormalized ?? QUAD_REFINE_POLICY.offsetNormalized),
    ))
    this.refinementUpdates += 1
    this.confirmationCandidate = null
    this.confirmationWaypoints = []
    this.confirmationIndex = 0
    this.confirmationWaypointReachedAt = null
    this.confirmationCompletedAt = null
    this.confirmationStartedAt = null
    this.bracketSkippedFlanks.clear()
    this.mode = 'advance'
    return true
  }

  private inspectionUnresolved(): AlgorithmDecision {
    return { direction: ZERO, speedScale: 0, estimate: null, confidence: 0,
      phase: 'INSUFFICIENT PHYSICAL INSPECTION BUDGET',
      debug: { note: 'Unresolved: remaining mission time cannot accommodate the planned fresh inspection. This is not a no-leak declaration.' } }
  }

  private clearPhysicalInspection(time: number, outcome: string) {
    this.physicalViewpoint = null
    this.inspectionPrior = null
    this.inspectionOutcome = outcome
    this.confirmationCandidate = null
    this.confirmationWaypoints = []
    this.confirmationIndex = 0
    this.confirmationWaypointReachedAt = null
    this.confirmationCompletedAt = null
    this.confirmationStartedAt = null
    this.confirmationWind = null
    this.confirmationSamples = []
    this.bracketSkippedFlanks.clear()
    this.lastBracketStatus = null
    this.refinementCandidate = null
    this.refinementUpdates = 0
    this.gradientRays = []
    this.rayEstimate = null
    this.estimateHistory = []
    this.surfaceEvidence = []
    this.triangulationAnchor = null
    this.adaptiveViewpoint = null
    this.adaptiveViewpointRayCount = -1
    this.viewpointHistory = []
    this.physicalCompletedScansAtPose = 0
    this.physicalRelocation = null
    this.forceStationaryRescan = false
    this.nextScanAt = time
    this.lastFailedConfirmationAt = time
    this.mode = 'cast'
  }

  private beginPhysicalInspection(input: AlgorithmStepInput): AlgorithmDecision | null {
    const policy = this.environment.candidateLifecycle
    if (!policy || !this.inspection || this.inspectionPrior || this.terminated) return null
    if (this.inspectionBudgetExhausted) return this.inspectionUnresolved()
    const ray = this.trustedRayEstimate()
    if (!ray) return null
    const waypoints = buildCoordinateRefinementWaypoints(ray.point, input.measurement.wind,
      this.castSide as 1 | -1, this.inspection.offsetNormalized)
    if (waypoints.some(point => this.environment.isBlocked(point))) {
      this.clearPhysicalInspection(input.time, 'blocked-inspection')
      return { direction: ZERO, speedScale: 0, estimate: null, confidence: 0,
        phase: 'PHYSICAL INSPECTION BLOCKED; REACQUIRE' }
    }
    const budget = inspectionAttemptBudget(input.position, waypoints, this.inspection,
      this.environment.maxSpeed, policy.maximumTurnRateRadiansPerSecond, input.dt)
    if (input.time + budget.totalSeconds > this.environment.durationSeconds) {
      this.clearPhysicalInspection(input.time, 'insufficient-mission-budget')
      this.inspectionBudgetExhausted = true
      return this.inspectionUnresolved()
    }
    this.inspectionPrior = { ray: { ...ray, point: copyPoint(ray.point) },
      stability: { ...this.estimateStability() }, startedAt: input.time,
      deadline: input.time + budget.totalSeconds }
    this.inspectionOutcome = 'fresh-confirmation-in-progress'
    // Snapshot is a navigation hypothesis, not a renewal of any raw ray.
    this.forceStationaryRescan = false
    this.physicalRelocation = null
    this.geometryConfirmationTarget(input, ray.point)
    return null
  }

  private movementDecision(input: AlgorithmStepInput): AlgorithmDecision {
    const maximumDecision = this.localMaximum?.step(input)
    if(maximumDecision)return maximumDecision
    const gradientMove = this.localGradientAcquisition(input)
    if (gradientMove) return gradientMove
    const inspectionStop = this.beginPhysicalInspection(input)
    if (inspectionStop) return inspectionStop
    const acquisitionMove = this.timeBudgetedAcquisition(input)
    if (acquisitionMove) return acquisitionMove
    const estimate = this.currentEstimate()
    const trustedRay = this.trustedRayEstimate()
    const upwind = magnitude(input.measurement.wind) > 1e-9
      ? scale(normalize(input.measurement.wind), -1)
      : { x: -1, y: 0 }
    const crosswind = rotate(upwind, Math.PI / 2)
    const recentHit = input.time - this.lastPassiveHitTime <= 1.5
    let desired: Vec2
    let phase: string
    let speedScale = 1

    if (!this.hasAcquisitionEvidence(input.time)) {
      while (
        this.acquisitionIndex < this.acquisitionWaypoints.length - 1 &&
        distance(
          input.position,
          this.acquisitionWaypoints[this.acquisitionIndex] ?? input.position,
        ) <= 0.028
      ) {
        this.acquisitionIndex += 1
      }
      const target = this.acquisitionWaypoints[this.acquisitionIndex] ?? input.position
      desired = sub(target, input.position)
      phase = 'BROAD PASSIVE ACQUISITION'
    } else if (
      this.mode === 'triangulate' &&
      this.gradientRays.length > 0 &&
      !trustedRay
    ) {
      if (this.usesAdaptiveViewpoints()) {
        const viewpoint = this.adaptiveTriangulationTarget(input)
        if (viewpoint) {
          desired = sub(viewpoint.target, input.position)
          phase = this.candidatePolicy === 'geometry-conditioned'
            ? 'GEOMETRY-CONDITIONED VIEWPOINT'
            : viewpoint.wakeEscape
              ? 'ADAPTIVE WAKE-ESCAPE VIEWPOINT'
              : 'ADAPTIVE FLOW-AWARE VIEWPOINT'
          speedScale = 0.66
        } else {
          desired = add(scale(crosswind, this.castSide * 0.9), scale(upwind, -0.22))
          phase = 'ADAPTIVE OCCLUSION ESCAPE'
          speedScale = 0.72
        }
      } else {
        const anchor = this.triangulationAnchor ?? this.gradientRays[0]!.origin
        const stage = Math.ceil(this.gradientRays.length / 2)
        const side = this.gradientRays.length % 2 === 1 ? this.castSide : -this.castSide
        const target = add(anchor, scale(
          crosswind,
          side * QUAD_STAGED_CROSSWIND_POLICY.lateralOffsetNormalized * stage,
        ))
        desired = sub(target, input.position)
        phase = 'STAGED CROSSWIND TRIANGULATION'
        speedScale = 0.62
      }
    } else if (
      this.mode === 'advance' &&
      input.time < this.burstUntil &&
      this.lastGradientQuality > 0 &&
      !(this.confirmationScheduling === 'priority-dwell' && trustedRay && this.usesCandidateConfirmation())
    ) {
      desired = add(
        scale(this.lastGradientDirection, 0.42),
        scale(upwind, 0.86),
      )
      phase = 'QUADRATURE GRADIENT ADVANCE'
      speedScale = 0.8
    } else if (trustedRay && this.usesCandidateConfirmation()) {
      const confirmationCenter = this.rayDirectionMode === 'wind-constrained-refine'
        ? this.refinementCandidate ?? trustedRay.point
        : trustedRay.point
      const target = this.candidateConfirmationTarget(input, confirmationCenter)
      desired = sub(target, input.position)
      phase = this.candidatePolicy === 'geometry-conditioned'
        ? 'GEOMETRY CANDIDATE CONFIRMATION'
        : 'ADAPTIVE PASSIVE CANDIDATE CONFIRMATION'
      speedScale = distance(input.position, confirmationCenter) > 0.075 ? 0.72 : 0.46
      if (this.confirmationScheduling === 'priority-dwell') {
        const dwelling = distance(input.position, target) <=
          (this.inspection?.arrivalRadiusNormalized ?? QUAD_GEOMETRY_CONDITIONED_POLICY.confirmationArrivalRadiusNormalized)
        phase = dwelling ? 'CANDIDATE CONFIRMATION DWELL' : 'CANDIDATE CONFIRMATION APPROACH'
        if (dwelling) {
          desired = ZERO
          speedScale = 0
        }
        if (this.inspection && !dwelling) speedScale = Math.min(speedScale,
          distance(input.position, target) / Math.max(1e-12, this.environment.maxSpeed * input.dt))
      }
    } else if (trustedRay && distance(input.position, trustedRay.point) > 0.032) {
      desired = add(
        scale(normalize(sub(trustedRay.point, input.position)), 0.82),
        scale(upwind, 0.18),
      )
      phase = 'SURFACE-SUPPORTED RAY APPROACH'
      speedScale = 0.72
    } else if (
      estimate &&
      (this.bestPassive?.concentration ?? 0) >= 0.7 &&
      input.time - this.lastPassiveHitTime <= 4 &&
      distance(input.position, estimate) <= 0.075
    ) {
      const angle = input.time * 1.35 * this.castSide
      const target = add(estimate, { x: Math.cos(angle) * 0.045, y: Math.sin(angle) * 0.045 })
      desired = sub(target, input.position)
      phase = 'PASSIVE CORE / RING CHECK'
      speedScale = 0.48
    } else if (recentHit) {
      const lateralCue = this.lastGradientQuality > 0
        ? clamp(dot(this.lastGradientDirection, crosswind), -1, 1)
        : 0
      desired = add(scale(upwind, 0.82), scale(crosswind, lateralCue * 0.34))
      phase = 'UPWIND TRACK WITH QUAD ALIGNMENT'
      speedScale = 0.9
    } else {
      const lastEvidenceTime = Math.max(
        this.lastPassiveHitTime,
        this.lastActiveSignalTime,
      )
      const castEpoch = Math.floor(
        Math.max(0, input.time - lastEvidenceTime) / 3.5,
      )
      const side = castEpoch % 2 === 0 ? this.castSide : -this.castSide
      desired = add(scale(crosswind, side * 0.9), scale(upwind, 0.16))
      phase = input.time - this.lastFailedConfirmationAt <= 4
        ? 'FAILED-CANDIDATE REACQUISITION'
        : 'PASSIVE REACQUISITION CAST'
    }

    const direction = safeDirection(this.environment, input.position, desired)
    return {
      direction,
      speedScale,
      estimate,
      confidence: this.confidence(input.time),
      phase,
      quadBracketEvidence: this.bracketStatus(input) ?? this.lastBracketStatus ?? undefined,
      debug: {
        target: estimate ?? add(input.position, scale(direction, 0.09)),
        candidates: this.gradientRays.map((ray) => add(ray.origin, scale(ray.direction, 0.09))),
        note: trustedRay
          ? `${trustedRay.rayCount} trusted gradient rays; residual ${trustedRay.residual.toFixed(3)}; passive surface confirmation remains required.`
          : this.rayEstimate
            ? `${this.rayEstimate.rayCount} provisional rays at (${this.rayEstimate.point.x.toFixed(2)}, ${this.rayEstimate.point.y.toFixed(2)}) withheld pending surface-proxy support.`
          : 'Searching for separated poses before reporting a triangulated surface candidate.',
      },
    }
  }

  step(input: AlgorithmStepInput): AlgorithmDecision {
    const decision = this.stepInternal(input)
    if (!this.environment.candidateLifecycle) return decision
    return { ...decision, debug: { ...decision.debug,
      note: `${decision.debug?.note ?? ''} Inspection lifecycle: ${this.inspectionOutcome}${this.inspectionPrior
        ? `; prior acquired ${this.inspectionPrior.startedAt.toFixed(2)} s; deadline ${this.inspectionPrior.deadline.toFixed(2)} s` : ''}.` } }
  }

  private stepInternal(input: AlgorithmStepInput): AlgorithmDecision {
    this.lifecycleTime = input.time
    const maximumDecision = this.localMaximum?.step(input)
    if(maximumDecision)return maximumDecision
    if (this.environment.candidateLifecycle && !this.terminated && this.inspectionPrior &&
        input.time > this.inspectionPrior.deadline) this.clearPhysicalInspection(input.time, 'timed-out')
    if (this.inspectionBudgetExhausted && !this.terminated) return this.inspectionUnresolved()
    this.observePassive(input)
    this.expireUnsupportedActiveEvidence(input.time)
    if (this.candidatePolicy !== 'legacy-four-ray-surface') this.expireGradientRays(input.time)
    if (this.terminated) return this.declaredDecision()
    if (this.abstained) return this.abstainedDecision()

    const relocation = this.boundedPhysicalRelocation(input)
    if (relocation) return relocation

    if (this.abstentionReady(input)) {
      this.abstained = true
      this.mode = 'abstained'
      this.terminationReason =
        `No credible source evidence after ${input.time.toFixed(1)} s and broad survey coverage; controller abstained without access to target truth.`
      return this.abstainedDecision()
    }

    const matchingQuadReturn = Boolean(
      this.pendingScanId !== null &&
      input.measurement.valid &&
      (input.measurement.sampleMode === 'quad-return' ||
        input.measurement.sampleMode === 'quad-passive-return') &&
      input.measurement.quadSniff?.scanId === this.pendingScanId &&
      input.measurement.quadSniff.readings?.length,
    )
    if (matchingQuadReturn) {
      const result = this.acceptQuadReturn(input)
      const bracketDecision = this.bracketDeclaration(input)
      if (bracketDecision) return bracketDecision
      if (this.applyCoordinateRefinement(input)) return this.movementDecision(input)
      const evidence = this.declarationEvidence(input)
      if (evidence.ready &&
          this.rayDirectionMode !== 'wind-constrained-bracket' &&
          this.rayDirectionMode !== 'wind-constrained-refine') {
        this.terminated = true
        this.mode = 'declared'
        const passive = this.passiveEvidence(this.trustedRayEstimate()?.point ?? null)
        this.terminationReason =
          `Stable multi-pose candidate passed the truth-blind evidence score ${evidence.score.toFixed(2)}; passive core/ring contrast ${passive.contrast.toFixed(2)}.`
        return { ...this.declaredDecision(), quadDeclarationEvidence: evidence }
      }
      if (this.rejectFailedGeometryConfirmation(input)) {
        return { ...this.movementDecision(input), quadDeclarationEvidence: evidence }
      }
      if (this.forceStationaryRescan) {
        return {
          direction: ZERO,
          estimate: this.currentEstimate(),
          confidence: this.confidence(input.time),
          phase: 'STATIONARY SURFACE-PROXY REPEAT',
          quadDeclarationEvidence: evidence,
          debug: {
            target: this.currentEstimate() ?? undefined,
            note: `High common return ${result.commonMean.toFixed(2)} with contrast ${result.normalizedContrast.toFixed(2)}; holding for an independent repeat.`,
          },
        }
      }
      return { ...this.movementDecision(input), quadDeclarationEvidence: evidence }
    }

    if (this.pendingScanId !== null) {
      const timeout = Math.max(1, this.environment.activeSniffCycleSeconds * 1.8)
      if (input.time - this.scanIssuedAt <= timeout) {
        return {
          direction: ZERO,
          estimate: this.currentEstimate(),
          confidence: this.confidence(input.time),
          phase: 'AWAITING FOUR CHANNELS',
          debug: {
            target: this.currentEstimate() ?? undefined,
            note: `Scan ${this.pendingScanId} is a single simultaneous event; no channel is requested serially.`,
          },
        }
      }
      this.pendingScanId = null
      this.forceStationaryRescan = false
      this.mode = 'cast'
      this.nextScanAt = input.time + 4
    }

    const gradientMove = this.localGradientAcquisition(input)
    if (gradientMove) return gradientMove
    const bracketDecision = this.bracketDeclaration(input)
    if (bracketDecision) return bracketDecision
    if (this.applyCoordinateRefinement(input)) return this.movementDecision(input)
    const evidence = this.declarationEvidence(input)
    if (evidence.ready &&
        this.rayDirectionMode !== 'wind-constrained-bracket' &&
        this.rayDirectionMode !== 'wind-constrained-refine') {
      this.terminated = true
      this.mode = 'declared'
      const passive = this.passiveEvidence(this.trustedRayEstimate()?.point ?? null)
      this.terminationReason =
        `Stable quadrature rays passed the truth-blind evidence score ${evidence.score.toFixed(2)} and passive core/ring contrast ${passive.contrast.toFixed(2)}.`
      return { ...this.declaredDecision(), quadDeclarationEvidence: evidence }
    }

    if (this.rejectFailedGeometryConfirmation(input)) {
      return { ...this.movementDecision(input), quadDeclarationEvidence: evidence }
    }

    const viewpoint = this.timeBudgetedAcquisition(input)
    if (viewpoint) return { ...viewpoint, quadDeclarationEvidence: evidence }

    if (this.shouldScan(input)) {
      this.forceStationaryRescan = false
      return this.issueScan(input)
    }
    if (this.mode === 'surface-check' && this.forceStationaryRescan) {
      return {
        direction: ZERO,
        estimate: this.currentEstimate(),
        confidence: this.confidence(input.time),
        phase: 'STATIONARY ASPIRATION REPEAT',
        debug: {
          target: this.currentEstimate() ?? undefined,
          note: 'Holding pose preserves a comparable common-mode return for the emergence proxy.',
        },
      }
    }
    return this.movementDecision(input)
  }

  /** Acquisition-only intervention. It does not supply a source candidate,
   * relax evidence tests, or extend the age of a ray. A failed relocation
   * remains explicitly unresolved until the common mission deadline.
   */
  private boundedPhysicalRelocation(input: AlgorithmStepInput): AlgorithmDecision | null {
    if (this.environment.localGradientPolicy && this.localGradientMove) return null
    if (this.environment.rayWindowPolicy && this.physicalViewpoint) return null
    if (this.environment.acquisitionPolicy && this.gradientRays.length > 0) return null
    const policy = this.environment.localScanPolicy
    if (!policy || this.pendingScanId !== null) return null
    if (this.trustedRayEstimate() || this.confirmationStartedAt !== null) {
      this.physicalRelocation = null
      return null
    }
    if (!this.physicalRelocation && this.physicalCompletedScansAtPose < policy.maximumCompletedScansPerPose) return null
    if (!this.physicalRelocation) {
      const upwind = magnitude(input.measurement.wind) > 1e-9
        ? scale(normalize(input.measurement.wind), -1) : { x: -1, y: 0 }
      const lateral = scale(rotate(upwind, Math.PI / 2), this.castSide)
      const target = [lateral, scale(lateral, -1), upwind, scale(upwind, -1)]
        .map(direction => add(input.position, scale(direction, policy.relocationDistanceNormalized)))
        .find(point => Array.from({ length: 9 }, (_, i) => add(input.position,
          scale(sub(point, input.position), i / 8))).every(probe => !this.environment.isBlocked(probe))) ?? null
      this.physicalRelocation = { target, startedAt: input.time, failed: target === null }
      this.forceStationaryRescan = false
    }
    const move = this.physicalRelocation
    if (input.time - move.startedAt > policy.maximumRelocationSeconds) move.failed = true
    const status = (phase: string, direction = ZERO, speedScale = 0): AlgorithmDecision => ({
      direction, speedScale, estimate: this.currentEstimate(), confidence: this.confidence(input.time), phase,
      debug: { target: move.target ?? undefined,
        note: `${policy.version}: ${this.physicalCompletedScansAtPose} completed scans at this pose; relocation is not source confirmation.` },
    })
    if (move.failed || !move.target) return status(move.target ? 'PHYSICAL RELOCATION TIMEOUT' : 'PHYSICAL RELOCATION BLOCKED')
    const remaining = distance(input.position, move.target)
    if (remaining <= policy.arrivalRadiusNormalized) {
      this.physicalScanPose = copyPoint(input.position)
      this.physicalCompletedScansAtPose = 0
      this.physicalRelocation = null
      this.forceStationaryRescan = false
      return this.issueScan(input)
    }
    return status('BOUNDED PHYSICAL RELOCATION', normalize(sub(move.target, input.position)),
      Math.min(0.6, remaining / Math.max(1e-12, this.environment.maxSpeed * input.dt)))
  }

  private timeBudgetedAcquisition(input: AlgorithmStepInput): AlgorithmDecision | null {
    if (this.environment.localGradientPolicy) return null
    if (!this.environment.acquisitionPolicy || this.pendingScanId !== null) return null
    if ((this.gradientRays.length === 0 && !(this.environment.rayWindowPolicy && this.physicalViewpoint)) || this.trustedRayEstimate() || this.inspectionPrior) {
      this.physicalViewpoint = null
      return null
    }
    const stopped = (phase: string): AlgorithmDecision => ({ direction: ZERO, speedScale: 0,
      estimate: null, confidence: 0, phase,
      debug: { note: 'Unresolved acquisition: no thresholds or ray lifetimes have been relaxed.' } })
    if (!this.physicalViewpoint) {
      const selected = selectPhysicalAcquisitionTarget(this.environment, input.position,
        this.lastGradientDirection, this.gradientRays.map(ray => ray.origin),
        this.minimumRaySeparation(),
        (this.physicalViewpointSequence % 2 ? -1 : 1) * this.castSide, input.dt)
      if (!selected) return stopped('PHYSICAL VIEWPOINT BLOCKED')
      const oldest = Math.min(...this.gradientRays.map(ray => ray.time))
      if (this.environment.rayWindowPolicy) {
        if (input.time + selected.returnAllowance > this.environment.durationSeconds) return stopped('INSUFFICIENT MISSION ACQUISITION BUDGET')
      } else if (input.time + selected.returnAllowance > Math.min(this.environment.durationSeconds,
          oldest + this.rayRetentionSeconds())) return stopped('INSUFFICIENT BEARING ACQUISITION BUDGET')
      this.physicalViewpoint = { target: selected.target, arrivalRadius: selected.arrivalRadius,
        deadline: input.time + selected.travelAllowance }
      this.physicalViewpointSequence++
      this.forceStationaryRescan = false
      this.physicalRelocation = null
    }
    const move = this.physicalViewpoint
    if (input.time > move.deadline) return stopped('PHYSICAL VIEWPOINT TIMEOUT')
    const remaining = distance(input.position, move.target)
    if (remaining <= move.arrivalRadius) return this.issueScan(input)
    return { direction: normalize(sub(move.target, input.position)),
      speedScale: Math.min(PHYSICAL_VIEWPOINT_SPEED, remaining / (this.environment.maxSpeed * input.dt)),
      estimate: null, confidence: 0, phase: 'TIME-BUDGETED PHYSICAL VIEWPOINT',
      debug: { target: copyPoint(move.target), note: 'Fixed separated pose; next scan starts only after arrival.' } }
  }

  private localGradientAcquisition(input: AlgorithmStepInput): AlgorithmDecision | null {
    if (!this.environment.localGradientPolicy || this.pendingScanId !== null) return null
    const stopped = (phase: string): AlgorithmDecision => ({direction: ZERO, speedScale: 0,
      estimate: null, confidence: 0, phase, debug: {note: 'Acquisition only; no leak-location or no-leak claim.'}})
    if (this.localGradientOutcome === 'mission-budget-exhausted') return stopped('LOCAL GRADIENT MISSION BUDGET EXHAUSTED')
    const move = this.localGradientMove
    if (!move) return null
    if (input.time > move.deadline) {
      this.localGradientMove = null
      this.localGradientOutcome = 'timed-out; legacy-reacquisition'
      return stopped('LOCAL GRADIENT STEP TIMEOUT')
    }
    const remaining = distance(input.position, move.target)
    if (remaining <= move.arrivalRadius) {
      this.localGradientMove = null
      this.localGradientOutcome = 'arrived; requesting-fresh-scan'
      return this.issueScan(input)
    }
    return {direction: normalize(sub(move.target, input.position)),
      speedScale: Math.min(PHYSICAL_VIEWPOINT_SPEED, remaining / (this.environment.maxSpeed * input.dt)),
      estimate: null, confidence: 0, phase: 'LOCAL GRADIENT HEAD STEP',
      debug: {target: copyPoint(move.target), note: 'One head spacing along a measured local gradient; destination is not a source estimate.'}}
  }

  private minimumRaySeparation() {
    return this.environment.bearingGeometry && this.environment.bearingAblation !== 'legacy-spacing' ? 4 * this.environment.activeSniffReach
      : QUAD_STAGED_CROSSWIND_POLICY.minimumOriginSeparationNormalized
  }

  private intersectCurrentRays(rays: readonly GradientRay[]) {
    return this.environment.bearingGeometry && this.environment.bearingAblation !== 'legacy-geometry'
      ? physicalBearingIntersection(rays, 2 * this.environment.activeSniffReach, this.inspection!.offsetNormalized)
      : intersectGradientRays(rays)
  }
}

export const createQuadSoilSniffController = () =>
  new QuadSoilSniffController('active-suction', 'geometry-conditioned')
export const createQuadWindController = () =>
  new QuadSoilSniffController(
    'active-suction', 'geometry-conditioned', 'frozen', 'wind-constrained',
  )
export const createQuadRangeController = () =>
  new QuadSoilSniffController(
    'active-suction', 'geometry-conditioned', 'frozen', 'wind-constrained-range',
  )
export const createQuadCorridorController = () =>
  new QuadSoilSniffController(
    'active-suction', 'geometry-conditioned', 'frozen', 'wind-constrained-corridor',
  )
export const createQuadBracketController = () =>
  new QuadSoilSniffController(
    'active-suction', 'geometry-conditioned', 'frozen', 'wind-constrained-bracket',
  )
export const createQuadRefineController = () =>
  new QuadSoilSniffController(
    'active-suction', 'geometry-conditioned', 'priority-dwell', 'wind-constrained-refine',
  )
export const createQuadConfirmationController = () =>
  new QuadSoilSniffController('active-suction', 'geometry-conditioned', 'priority-dwell')
export const createQuadAdaptiveController = () =>
  new QuadSoilSniffController('active-suction', 'adaptive-viewpoint')
export const createQuadStagedController = () =>
  new QuadSoilSniffController('active-suction', 'staged-three-ray')
export const createQuadLegacyController = () =>
  new QuadSoilSniffController('active-suction', 'legacy-four-ray-surface')
export const createQuadPassiveController = () =>
  new QuadSoilSniffController('passive-array', 'geometry-conditioned')
