import {
  clamp,
  distance,
  effectiveSampleSize,
  normalize,
  sub,
  weightedMean,
  weightedRadius,
} from '../math'
import { hashNumbers, SeededRandom } from '../rng'
import type {
  AlgorithmController,
  AlgorithmDecision,
  AlgorithmEnvironment,
  AlgorithmStepInput,
  Observation,
  Vec2,
  WeightedPoint,
} from '../types'
import { ALGORITHM_METADATA } from './metadata'
import { confirmSourceFromConcentration } from './confirmation'

type SmcParticle = WeightedPoint & {
  strength: number
}

type CandidateScore = {
  point: Vec2
  informationGain: number
  predictedHitProbability: number
}

type SmcUpdateDiagnostic = {
  preResampleEss: number
  resampleThreshold: number
  resampleTriggered: boolean
}

const PARTICLE_COUNT = 320
const MIN_STRENGTH = 0.25
const MAX_STRENGTH = 3
const PRIOR_SPATIAL_RADIUS = 0.42
const RESAMPLE_ESS_RATIO = 0.52
const PLAN_INTERVAL_SECONDS = 0.7
const MIN_TERMINATION_OBSERVATIONS = 48
const MIN_TERMINATION_HITS = 6
const TERMINATION_RADIUS = 0.028
const TERMINATION_STRENGTH_CV = 0.4
const TERMINATION_CONFIRMATIONS = 8
const MIN_PROBABILITY = 1e-6

const binaryEntropy = (probability: number) => {
  const value = clamp(probability, MIN_PROBABILITY, 1 - MIN_PROBABILITY)
  return -value * Math.log(value) - (1 - value) * Math.log(1 - value)
}

const isInsideDomain = (point: Vec2, margin = 0.015) =>
  point.x >= margin &&
  point.x <= 1 - margin &&
  point.y >= margin &&
  point.y <= 1 - margin

/**
 * Sequential-Monte-Carlo source-term estimator with one-step expected-KL
 * measurement planning. All stochastic operations use the simulation seed,
 * making a run reproducible for a given sequence of observations.
 */
export class SmcKlController implements AlgorithmController {
  readonly metadata = ALGORITHM_METADATA['smc-kl']

  private environment: AlgorithmEnvironment | null = null
  private random = new SeededRandom(1)
  private particles: SmcParticle[] = []
  private assimilatedObservationCount = 0
  private hitCount = 0
  private contractionConfirmations = 0
  private terminated = false
  private terminationReason: string | undefined
  private target: Vec2 | null = null
  private candidates: Vec2[] = []
  private nextPlanTime = 0
  private lastInformationGain = 0
  private refinedEstimate: Vec2 | null = null
  private lastUpdate: SmcUpdateDiagnostic | null = null

  reset(environment: AlgorithmEnvironment) {
    this.environment = environment
    this.random = new SeededRandom(hashNumbers(environment.controllerSeed, 0x534d_434b))
    this.particles = this.createPrior(environment)
    this.assimilatedObservationCount = 0
    this.hitCount = 0
    this.contractionConfirmations = 0
    this.terminated = false
    this.terminationReason = undefined
    this.target = null
    this.candidates = []
    this.nextPlanTime = 0
    this.lastInformationGain = 0
    this.refinedEstimate = null
    this.lastUpdate = null
  }

  step(input: AlgorithmStepInput): AlgorithmDecision {
    const environment = this.environment
    if (environment === null) {
      throw new Error('SmcKlController must be reset before stepping')
    }

    const assimilatedNewObservation = this.assimilatePendingObservations(input.observations)
    const coarseEstimate = weightedMean(this.particles)
    if (this.hitCount >= 3 && this.assimilatedObservationCount % 4 === 0) {
      this.refinedEstimate = this.refineSourceEstimate(input.observations, coarseEstimate)
    }
    const estimate = this.refinedEstimate ?? coarseEstimate
    const confirmation = confirmSourceFromConcentration(input.observations, estimate)
    const reportedEstimate = confirmation?.estimate ?? estimate
    const radius = weightedRadius(this.particles, coarseEstimate)
    const confidence = clamp(1 - radius / PRIOR_SPATIAL_RADIUS)
    const strength = this.strengthSummary()

    if (assimilatedNewObservation) {
      const contracted =
        confirmation !== null &&
        this.assimilatedObservationCount >= MIN_TERMINATION_OBSERVATIONS &&
        this.hitCount >= MIN_TERMINATION_HITS &&
        radius <= TERMINATION_RADIUS &&
        strength.coefficientOfVariation <= TERMINATION_STRENGTH_CV

      this.contractionConfirmations = contracted ? this.contractionConfirmations + 1 : 0
      if (this.contractionConfirmations >= TERMINATION_CONFIRMATIONS) {
        this.terminated = true
        this.terminationReason =
          `Posterior contracted: spatial radius ${(radius * 100).toFixed(1)}% ` +
          `and strength CV ${(strength.coefficientOfVariation * 100).toFixed(0)}%.`
      }
    }

    if (this.terminated) {
      this.target = reportedEstimate
      return this.makeDecision({
        direction: { x: 0, y: 0 },
        estimate: reportedEstimate,
        confidence,
        radius,
        strengthMean: strength.mean,
        ess: effectiveSampleSize(this.particles.map((particle) => particle.weight)),
        phase: 'posterior contracted',
        nativeTerminated: true,
      })
    }

    const targetInvalid =
      this.target === null ||
      distance(input.position, this.target) < 0.014 ||
      environment.isBlocked(this.target, 0.008)
    if (targetInvalid || input.time >= this.nextPlanTime) {
      const selected = this.selectInformativeTarget(input, reportedEstimate)
      this.target = selected.point
      this.lastInformationGain = selected.informationGain
      this.nextPlanTime = input.time + PLAN_INTERVAL_SECONDS
    }

    const fallbackDirection = {
      x: Math.cos(input.heading),
      y: Math.sin(input.heading),
    }
    const desiredDirection = normalize(
      sub(this.target ?? reportedEstimate, input.position),
      fallbackDirection,
    )
    const direction = environment.safeDirection(input.position, desiredDirection)
    const targetDistance = distance(input.position, this.target ?? input.position)
    const speedScale = clamp(targetDistance / 0.035, 0.35, 1)
    const ess = effectiveSampleSize(this.particles.map((particle) => particle.weight))

    let phase = 'information sampling'
    if (this.hitCount === 0) phase = 'seeking an informative encounter'
    else if (confidence >= 0.78) phase = 'verifying posterior contraction'
    else if (this.hitCount < MIN_TERMINATION_HITS) phase = 'conditioning source posterior'

    return this.makeDecision({
      direction,
      speedScale,
      estimate: reportedEstimate,
      confidence,
      radius,
      strengthMean: strength.mean,
      ess,
      phase,
      nativeTerminated: false,
    })
  }

  private createPrior(environment: AlgorithmEnvironment) {
    const particles: SmcParticle[] = []
    const columns = 20
    const rows = Math.ceil(PARTICLE_COUNT / columns)
    const equalWeight = 1 / PARTICLE_COUNT

    for (let index = 0; index < PARTICLE_COUNT; index += 1) {
      const column = index % columns
      const row = Math.floor(index / columns) % rows
      let position = {
        x: (column + this.random.next()) / columns,
        y: (row + this.random.next()) / rows,
      }

      if (!isInsideDomain(position) || environment.isBlocked(position, 0.008)) {
        position = this.sampleFreePosition(environment)
      }

      const logStrength = this.random.range(Math.log(0.4), Math.log(2.4))
      particles.push({
        ...position,
        strength: Math.exp(logStrength),
        weight: equalWeight,
      })
    }

    return particles
  }

  private sampleFreePosition(environment: AlgorithmEnvironment) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const candidate = {
        x: this.random.range(0.02, 0.98),
        y: this.random.range(0.02, 0.98),
      }
      if (!environment.isBlocked(candidate, 0.008)) return candidate
    }

    // Scenario starts are guaranteed navigable and provide a deterministic
    // fallback in a pathologically cluttered domain.
    return { ...environment.scenario.robotStart }
  }

  private assimilatePendingObservations(observations: readonly Observation[]) {
    if (observations.length < this.assimilatedObservationCount) {
      this.assimilatedObservationCount = 0
      this.hitCount = 0
    }

    let assimilated = false
    for (let index = this.assimilatedObservationCount; index < observations.length; index += 1) {
      const observation = observations[index]
      if (observation === undefined) continue
      this.updatePosterior(observation)
      this.hitCount += observation.hit ? 1 : 0
      this.assimilatedObservationCount += 1
      assimilated = true
    }
    return assimilated
  }

  private updatePosterior(observation: Observation) {
    const environment = this.environment
    if (environment === null || this.particles.length === 0) return

    const logWeights = new Array<number>(this.particles.length)
    let maximumLogWeight = -Infinity

    for (let index = 0; index < this.particles.length; index += 1) {
      const particle = this.particles[index]
      if (particle === undefined) continue
      const hitProbability = this.hitProbability(particle, observation.position, observation.time)
      const likelihood = observation.hit ? hitProbability : 1 - hitProbability
      const logWeight = Math.log(Math.max(particle.weight, Number.MIN_VALUE)) +
        Math.log(Math.max(likelihood, MIN_PROBABILITY)) * 0.28
      logWeights[index] = logWeight
      maximumLogWeight = Math.max(maximumLogWeight, logWeight)
    }

    let total = 0
    for (let index = 0; index < this.particles.length; index += 1) {
      const logWeight = logWeights[index]
      const particle = this.particles[index]
      if (logWeight === undefined || particle === undefined) continue
      particle.weight = Math.exp(logWeight - maximumLogWeight)
      total += particle.weight
    }

    if (!Number.isFinite(total) || total <= 0) {
      this.setUniformWeights()
      return
    }

    for (const particle of this.particles) particle.weight /= total

    const ess = effectiveSampleSize(this.particles.map((particle) => particle.weight))
    const resampleThreshold = this.particles.length * RESAMPLE_ESS_RATIO
    const resampleTriggered = ess < resampleThreshold
    this.lastUpdate = {
      preResampleEss: ess,
      resampleThreshold,
      resampleTriggered,
    }
    if (resampleTriggered) this.systematicResample()
  }

  private hitProbability(particle: SmcParticle, samplePoint: Vec2, time: number) {
    const environment = this.environment
    if (environment === null) return 0.5
    const lambda = Math.max(0, environment.expectedHitRate(particle, samplePoint, time))
    return clamp(
      1 - Math.exp(-lambda * particle.strength),
      MIN_PROBABILITY,
      1 - MIN_PROBABILITY,
    )
  }

  private systematicResample() {
    const environment = this.environment
    if (environment === null || this.particles.length === 0) return

    const spatialCenter = weightedMean(this.particles)
    const currentRadius = weightedRadius(this.particles, spatialCenter)
    const jitter = clamp(currentRadius * 0.18, 0.006, 0.026)
    const count = this.particles.length
    const equalWeight = 1 / count
    const start = this.random.next() / count
    const resampled: SmcParticle[] = []
    let sourceIndex = 0
    let cumulativeWeight = this.particles[0]?.weight ?? equalWeight

    for (let index = 0; index < count; index += 1) {
      const threshold = start + index / count
      while (threshold > cumulativeWeight && sourceIndex < count - 1) {
        sourceIndex += 1
        cumulativeWeight += this.particles[sourceIndex]?.weight ?? 0
      }

      const source = this.particles[sourceIndex] ?? this.particles[0]
      if (source === undefined) continue
      const position = this.jitterPosition(source, jitter, environment)
      const strength = clamp(
        source.strength * Math.exp(this.random.normal(0, 0.075)),
        MIN_STRENGTH,
        MAX_STRENGTH,
      )
      resampled.push({ ...position, strength, weight: equalWeight })
    }

    if (resampled.length === count) this.particles = resampled
    else this.setUniformWeights()
  }

  private jitterPosition(source: Vec2, standardDeviation: number, environment: AlgorithmEnvironment) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = {
        x: clamp(this.random.normal(source.x, standardDeviation), 0.015, 0.985),
        y: clamp(this.random.normal(source.y, standardDeviation), 0.015, 0.985),
      }
      if (!environment.isBlocked(candidate, 0.006)) return candidate
    }
    return { x: source.x, y: source.y }
  }

  private setUniformWeights() {
    const weight = this.particles.length > 0 ? 1 / this.particles.length : 0
    for (const particle of this.particles) particle.weight = weight
  }

  private selectInformativeTarget(input: AlgorithmStepInput, estimate: Vec2): CandidateScore {
    const environment = this.environment
    if (environment === null) {
      return { point: input.position, informationGain: 0, predictedHitProbability: 0 }
    }

    const lookahead = clamp(environment.maxSpeed * 1.6, 0.045, 0.08)
    const candidatePoints: Vec2[] = []
    const radialCount = 12
    for (let index = 0; index < radialCount; index += 1) {
      const angle = input.heading + (index * Math.PI * 2) / radialCount
      const candidate = {
        x: input.position.x + Math.cos(angle) * lookahead,
        y: input.position.y + Math.sin(angle) * lookahead,
      }
      if (isInsideDomain(candidate) && !environment.isBlocked(candidate, 0.012)) {
        candidatePoints.push(candidate)
      }
    }

    const estimateDirection = normalize(sub(estimate, input.position), {
      x: Math.cos(input.heading),
      y: Math.sin(input.heading),
    })
    const estimateCandidate = {
      x: input.position.x + estimateDirection.x * lookahead,
      y: input.position.y + estimateDirection.y * lookahead,
    }
    if (isInsideDomain(estimateCandidate) && !environment.isBlocked(estimateCandidate, 0.012)) {
      const isDuplicate = candidatePoints.some((point) => distance(point, estimateCandidate) < 0.005)
      if (!isDuplicate) candidatePoints.push(estimateCandidate)
    }

    this.candidates = candidatePoints
    if (candidatePoints.length === 0) {
      const safeDirection = environment.safeDirection(input.position, {
        x: Math.cos(input.heading),
        y: Math.sin(input.heading),
      })
      return {
        point: {
          x: clamp(input.position.x + safeDirection.x * lookahead, 0.015, 0.985),
          y: clamp(input.position.y + safeDirection.y * lookahead, 0.015, 0.985),
        },
        informationGain: 0,
        predictedHitProbability: 0,
      }
    }

    let best: CandidateScore | null = null
    for (const point of candidatePoints) {
      const travelDirection = normalize(sub(point, input.position))
      const directionalSpeed =
        environment.maxSpeed * environment.terrainMobilityScale(travelDirection)
      const arrivalTime =
        input.time + distance(input.position, point) / Math.max(1e-6, directionalSpeed)
      const score = this.scoreCandidate(point, arrivalTime)
      if (best === null || this.isBetterCandidate(score, best, estimate)) best = score
    }

    return best ?? { point: candidatePoints[0] ?? input.position, informationGain: 0, predictedHitProbability: 0 }
  }

  private scoreCandidate(point: Vec2, time: number): CandidateScore {
    let predictedHitProbability = 0
    let expectedConditionalEntropy = 0

    for (const particle of this.particles) {
      const hitProbability = this.hitProbability(particle, point, time)
      predictedHitProbability += particle.weight * hitProbability
      expectedConditionalEntropy += particle.weight * binaryEntropy(hitProbability)
    }

    // This Bernoulli mutual information is the expected KL divergence between
    // the current particle posterior and its hit/miss-conditioned posterior.
    const informationGain = Math.max(
      0,
      binaryEntropy(predictedHitProbability) - expectedConditionalEntropy,
    )
    return { point, informationGain, predictedHitProbability }
  }

  private isBetterCandidate(candidate: CandidateScore, incumbent: CandidateScore, estimate: Vec2) {
    const informationDifference = candidate.informationGain - incumbent.informationGain
    if (Math.abs(informationDifference) > 1e-9) return informationDifference > 0

    const detectionDifference =
      candidate.predictedHitProbability - incumbent.predictedHitProbability
    if (Math.abs(detectionDifference) > 1e-9) return detectionDifference > 0

    return distance(candidate.point, estimate) < distance(incumbent.point, estimate)
  }

  private strengthSummary() {
    const mean = this.particles.reduce(
      (sum, particle) => sum + particle.weight * particle.strength,
      0,
    )
    const variance = this.particles.reduce(
      (sum, particle) => sum + particle.weight * (particle.strength - mean) ** 2,
      0,
    )
    return {
      mean,
      coefficientOfVariation: mean > 1e-9 ? Math.sqrt(Math.max(0, variance)) / mean : 1,
    }
  }

  private refineSourceEstimate(observations: readonly Observation[], center: Vec2): Vec2 {
    const environment = this.environment
    if (environment === null) return center
    const evidence = observations.slice(-140).filter((_, index) => index % 2 === 0)
    let best = { ...center }
    let bestScore = Number.NEGATIVE_INFINITY
    const strength = this.strengthSummary().mean
    for (let offsetY = -4; offsetY <= 4; offsetY += 1) {
      for (let offsetX = -4; offsetX <= 4; offsetX += 1) {
        const candidate = {
          x: clamp(center.x + offsetX * 0.009, 0.012, 0.988),
          y: clamp(center.y + offsetY * 0.009, 0.012, 0.988),
        }
        if (environment.isBlocked(candidate, 0.005)) continue
        let score = 0
        for (const observation of evidence) {
          const lambda = environment.expectedHitRate(
            candidate,
            observation.position,
            observation.time,
          )
          const probability = clamp(
            1 - Math.exp(-lambda * strength),
            MIN_PROBABILITY,
            1 - MIN_PROBABILITY,
          )
          score += Math.log(
            Math.max(MIN_PROBABILITY, observation.hit ? probability : 1 - probability),
          )
        }
        if (score > bestScore) {
          bestScore = score
          best = candidate
        }
      }
    }
    return best
  }

  private makeDecision(args: {
    direction: Vec2
    speedScale?: number
    estimate: Vec2
    confidence: number
    radius: number
    strengthMean: number
    ess: number
    phase: string
    nativeTerminated: boolean
  }): AlgorithmDecision {
    return {
      direction: args.direction,
      speedScale: args.speedScale,
      estimate: args.estimate,
      confidence: args.confidence,
      phase: args.phase,
      nativeTerminated: args.nativeTerminated,
      terminationReason: args.nativeTerminated ? this.terminationReason : undefined,
      debug: {
        target: this.target ?? undefined,
        candidates: this.candidates,
        particles: this.particles.map((particle) => ({ ...particle })),
        note:
          `ESS ${args.ess.toFixed(0)}/${this.particles.length} · ` +
          `radius ${(args.radius * 100).toFixed(1)}% · ` +
          `strength ${args.strengthMean.toFixed(2)}× · ` +
          `EIG ${this.lastInformationGain.toFixed(3)} nat`,
      },
    }
  }
}

export const createSmcKlController = (): AlgorithmController => new SmcKlController()
