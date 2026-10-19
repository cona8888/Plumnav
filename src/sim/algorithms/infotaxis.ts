import { clamp, distance, magnitude, normalize, sub } from '../math'
import type {
  AlgorithmController,
  AlgorithmDecision,
  AlgorithmEnvironment,
  AlgorithmStepInput,
  DebugGrid,
  Observation,
  Vec2,
} from '../types'
import { ALGORITHM_METADATA } from './metadata'
import { confirmSourceFromConcentration } from './confirmation'

const GRID_WIDTH = 23
const GRID_HEIGHT = 15
const GRID_SIZE = GRID_WIDTH * GRID_HEIGHT
const GRID_CLEARANCE = 0.012
const POSTERIOR_FLOOR_MIX = 1e-6
const MIN_HIT_PROBABILITY = 0.01
const MAX_HIT_PROBABILITY = 0.99
const TERMINATION_LOCAL_RADIUS = 0.06
const PLAN_INTERVAL_SECONDS = 0.65
const REQUIRED_CONVERGENCE_CONFIRMATIONS = 6

const COMPASS_DIRECTIONS: readonly Vec2[] = [
  { x: 1, y: 0 },
  { x: Math.SQRT1_2, y: Math.SQRT1_2 },
  { x: 0, y: 1 },
  { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
  { x: -1, y: 0 },
  { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
  { x: 0, y: -1 },
  { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
]

type GridCell = {
  index: number
  point: Vec2
}

type PosteriorStatistics = {
  estimate: Vec2
  entropy: number
  confidence: number
  radius: number
  localMass: number
  maxProbability: number
}

type CandidateScore = {
  point: Vec2
  score: number
  informationGain: number
}

const poissonHitProbability = (rate: number) =>
  clamp(
    1 - Math.exp(-Math.max(0, Number.isFinite(rate) ? rate : 0)),
    MIN_HIT_PROBABILITY,
    MAX_HIT_PROBABILITY,
  )

const entropyTerm = (probability: number) =>
  probability > 0 ? -probability * Math.log(probability) : 0

/**
 * A deterministic, grid-based approximation of the Infotaxis policy.
 *
 * The grid stores only feasible source hypotheses. At each new measurement,
 * expectedHitRate is interpreted as a dimensionless Poisson lambda per sample,
 * so P(hit | source) = 1 - exp(-lambda). Movement is selected by the expected
 * one-step reduction in Shannon entropy.
 */
export class InfotaxisController implements AlgorithmController {
  readonly metadata = ALGORITHM_METADATA.infotaxis

  private environment: AlgorithmEnvironment | null = null
  private cells: GridCell[] = []
  private posterior: number[] = new Array<number>(GRID_SIZE).fill(0)
  private visitSeconds: number[] = new Array<number>(GRID_SIZE).fill(0)
  private lastAssimilatedTime = Number.NEGATIVE_INFINITY
  private assimilatedMeasurements = 0
  private hitMeasurements = 0
  private convergenceConfirmations = 0
  private terminated = false
  private terminationReason: string | undefined
  private target: Vec2 | null = null
  private candidates: Vec2[] = []
  private nextPlanTime = 0
  private lastInformationGain = 0
  private evidenceHistory: Observation[] = []

  reset(environment: AlgorithmEnvironment): void {
    this.environment = environment
    this.cells = []
    this.posterior = new Array<number>(GRID_SIZE).fill(0)
    this.visitSeconds = new Array<number>(GRID_SIZE).fill(0)
    this.lastAssimilatedTime = Number.NEGATIVE_INFINITY
    this.assimilatedMeasurements = 0
    this.hitMeasurements = 0
    this.convergenceConfirmations = 0
    this.terminated = false
    this.terminationReason = undefined
    this.target = null
    this.candidates = []
    this.nextPlanTime = 0
    this.lastInformationGain = 0
    this.evidenceHistory = []

    for (let row = 0; row < GRID_HEIGHT; row += 1) {
      for (let column = 0; column < GRID_WIDTH; column += 1) {
        const point = {
          x: (column + 0.5) / GRID_WIDTH,
          y: (row + 0.5) / GRID_HEIGHT,
        }
        if (environment.isBlocked(point, GRID_CLEARANCE)) continue
        this.cells.push({ index: row * GRID_WIDTH + column, point })
      }
    }

    const uniformWeight = this.cells.length > 0 ? 1 / this.cells.length : 0
    for (const cell of this.cells) this.posterior[cell.index] = uniformWeight
  }

  step(input: AlgorithmStepInput): AlgorithmDecision {
    const environment = this.requireEnvironment()

    const assimilatedNewMeasurement =
      !this.terminated && input.time > this.lastAssimilatedTime + 1e-9
    if (assimilatedNewMeasurement) {
      this.assimilateMeasurement(input)
    }
    this.recordVisit(input.position, input.dt)

    const statistics = this.posteriorStatistics()
    if (statistics === null) {
      return {
        direction: { x: 0, y: 0 },
        estimate: null,
        confidence: 0,
        phase: 'NO FEASIBLE BELIEF CELLS',
        debug: { grid: this.debugGrid(), note: 'The obstacle map leaves no feasible source cells.' },
      }
    }
    const confirmation = confirmSourceFromConcentration(
      this.evidenceHistory,
      statistics.estimate,
    )
    const reportedEstimate = confirmation?.estimate ?? statistics.estimate

    if (!this.terminated && assimilatedNewMeasurement) {
      this.convergenceConfirmations =
        confirmation && this.hasPosteriorConverged(input.time, statistics)
        ? this.convergenceConfirmations + 1
        : 0
      if (this.convergenceConfirmations >= REQUIRED_CONVERGENCE_CONFIRMATIONS) {
        this.terminated = true
        this.terminationReason =
          `Posterior converged: spread ${statistics.radius.toFixed(3)}, ` +
          `local mass ${(statistics.localMass * 100).toFixed(0)}%, ` +
          `MAP ${(statistics.maxProbability * 100).toFixed(1)}%; ` +
          `local peak ${confirmation?.peakConcentration.toFixed(2)}`
      }
    }

    if (this.terminated) {
      return {
        direction: { x: 0, y: 0 },
        estimate: reportedEstimate,
        confidence: statistics.confidence,
        phase: 'POSTERIOR CONVERGED',
        nativeTerminated: true,
        terminationReason: this.terminationReason,
        debug: {
          grid: this.debugGrid(),
          target: reportedEstimate,
          note: this.debugNote(statistics),
        },
      }
    }

    const targetInvalid =
      this.target === null ||
      distance(input.position, this.target) < 0.014 ||
      environment.isBlocked(this.target, GRID_CLEARANCE)
    if (targetInvalid || input.time >= this.nextPlanTime) {
      this.candidates = this.feasibleCandidates(input.position)
      const bestCandidate = this.selectCandidate(input, this.candidates, statistics.entropy)
      this.target = bestCandidate?.point ?? statistics.estimate
      this.lastInformationGain = bestCandidate?.informationGain ?? 0
      this.nextPlanTime = input.time + PLAN_INTERVAL_SECONDS
    }

    const target = this.target ?? statistics.estimate
    const desired = sub(target, input.position)
    const safeDirection =
      magnitude(desired) > 1e-9
        ? environment.safeDirection(input.position, normalize(desired))
        : { x: 0, y: 0 }
    const direction =
      magnitude(safeDirection) > 1e-9 ? normalize(safeDirection, { x: 0, y: 0 }) : { x: 0, y: 0 }

    return {
      direction,
      estimate: reportedEstimate,
      confidence: statistics.confidence,
      phase: input.measurement.hit ? 'UPDATE: HIT' : 'SEEK INFORMATION',
      debug: {
        target,
        candidates: this.candidates,
        grid: this.debugGrid(),
        note:
          `${this.debugNote(statistics)} · ` +
          `expected gain ${this.lastInformationGain.toFixed(4)} nat`,
      },
    }
  }

  private requireEnvironment(): AlgorithmEnvironment {
    if (this.environment === null) {
      throw new Error('InfotaxisController.step() called before reset().')
    }
    return this.environment
  }

  private assimilateMeasurement(input: AlgorithmStepInput): void {
    const environment = this.requireEnvironment()
    const updated = new Array<number>(GRID_SIZE).fill(0)
    let evidence = 0

    for (const cell of this.cells) {
      const rate = environment.expectedHitRate(cell.point, input.position, input.time)
      const hitProbability = poissonHitProbability(rate)
      // Consecutive plume samples are correlated; temper the Bernoulli evidence
      // to avoid an unrealistically overconfident posterior.
      const likelihood = Math.pow(
        input.measurement.hit ? hitProbability : 1 - hitProbability,
        0.28,
      )
      const unnormalised = (this.posterior[cell.index] ?? 0) * likelihood
      updated[cell.index] = unnormalised
      evidence += unnormalised
    }

    if (evidence > 0 && Number.isFinite(evidence)) {
      const uniformWeight = this.cells.length > 0 ? 1 / this.cells.length : 0
      for (const cell of this.cells) {
        const normalised = (updated[cell.index] ?? 0) / evidence
        this.posterior[cell.index] =
          normalised * (1 - POSTERIOR_FLOOR_MIX) + uniformWeight * POSTERIOR_FLOOR_MIX
      }
    } else {
      const uniformWeight = this.cells.length > 0 ? 1 / this.cells.length : 0
      for (const cell of this.cells) this.posterior[cell.index] = uniformWeight
    }

    this.lastAssimilatedTime = input.time
    this.assimilatedMeasurements += 1
    if (input.measurement.hit) this.hitMeasurements += 1
    this.evidenceHistory.push({
      ...input.measurement,
      position: { ...input.position },
    })
    if (this.evidenceHistory.length > 240) this.evidenceHistory.shift()
  }

  private refineMapEstimate(mapPoint: Vec2): Vec2 {
    const environment = this.requireEnvironment()
    const evidence = this.evidenceHistory.slice(-140).filter((_, index) => index % 2 === 0)
    if (evidence.filter((observation) => observation.hit).length < 3) return { ...mapPoint }
    let best = { ...mapPoint }
    let bestScore = Number.NEGATIVE_INFINITY
    const stepX = 1 / (GRID_WIDTH * 6)
    const stepY = 1 / (GRID_HEIGHT * 8)
    for (let offsetY = -4; offsetY <= 4; offsetY += 1) {
      for (let offsetX = -4; offsetX <= 4; offsetX += 1) {
        const candidate = {
          x: clamp(mapPoint.x + offsetX * stepX, 0.008, 0.992),
          y: clamp(mapPoint.y + offsetY * stepY, 0.008, 0.992),
        }
        if (environment.isBlocked(candidate, 0.004)) continue
        let score = 0
        for (const observation of evidence) {
          const probability = poissonHitProbability(
            environment.expectedHitRate(candidate, observation.position, observation.time),
          )
          score += Math.log(Math.max(0.01, observation.hit ? probability : 1 - probability))
        }
        if (score > bestScore) {
          bestScore = score
          best = candidate
        }
      }
    }
    return best
  }

  private posteriorStatistics(): PosteriorStatistics | null {
    const firstCell = this.cells[0]
    if (firstCell === undefined) return null

    let totalWeight = 0
    let meanX = 0
    let meanY = 0
    let entropy = 0
    let mapCell = firstCell
    let maxProbability = -1

    for (const cell of this.cells) {
      const weight = this.posterior[cell.index] ?? 0
      totalWeight += weight
      meanX += cell.point.x * weight
      meanY += cell.point.y * weight
      entropy += entropyTerm(weight)
      if (weight > maxProbability) {
        maxProbability = weight
        mapCell = cell
      }
    }

    if (totalWeight <= 0) return null
    const mean = { x: meanX / totalWeight, y: meanY / totalWeight }
    let variance = 0
    let localMass = 0

    for (const cell of this.cells) {
      const weight = (this.posterior[cell.index] ?? 0) / totalWeight
      variance += weight * distance(cell.point, mean) ** 2
      if (distance(cell.point, mapCell.point) <= TERMINATION_LOCAL_RADIUS) localMass += weight
    }

    const radius = Math.sqrt(Math.max(0, variance))
    const maximumEntropy = Math.log(Math.max(2, this.cells.length))
    const entropyConfidence = clamp(1 - entropy / maximumEntropy)
    const spreadConfidence = clamp(1 - radius / 0.42)
    const confidence = clamp(entropyConfidence * 0.7 + spreadConfidence * 0.3)

    return {
      estimate: this.refineMapEstimate(mapCell.point),
      entropy,
      confidence,
      radius,
      localMass,
      maxProbability: Math.max(0, maxProbability),
    }
  }

  private hasPosteriorConverged(time: number, statistics: PosteriorStatistics): boolean {
    if (time < 20 || this.assimilatedMeasurements < 80 || this.hitMeasurements < 5) return false
    return (
      statistics.radius <= 0.028 &&
      statistics.localMass >= 0.82 &&
      statistics.maxProbability >= 0.08
    )
  }

  private feasibleCandidates(position: Vec2): Vec2[] {
    const environment = this.requireEnvironment()
    const travelDistance = clamp(environment.maxSpeed * 1.6, 0.045, 0.085)
    const candidates: Vec2[] = []

    for (const compassDirection of COMPASS_DIRECTIONS) {
      const safe = environment.safeDirection(position, compassDirection)
      if (magnitude(safe) <= 1e-9) continue
      const direction = normalize(safe)
      const point = {
        x: clamp(position.x + direction.x * travelDistance, 0.01, 0.99),
        y: clamp(position.y + direction.y * travelDistance, 0.01, 0.99),
      }
      if (distance(position, point) < travelDistance * 0.35) continue
      if (!this.segmentIsFeasible(position, point)) continue
      if (candidates.some((candidate) => distance(candidate, point) < 0.005)) continue
      candidates.push(point)
    }

    return candidates
  }

  private segmentIsFeasible(from: Vec2, to: Vec2): boolean {
    const environment = this.requireEnvironment()
    for (let step = 1; step <= 4; step += 1) {
      const amount = step / 4
      const point = {
        x: from.x + (to.x - from.x) * amount,
        y: from.y + (to.y - from.y) * amount,
      }
      if (environment.isBlocked(point, GRID_CLEARANCE)) return false
    }
    return true
  }

  private selectCandidate(
    input: AlgorithmStepInput,
    candidates: readonly Vec2[],
    currentEntropy: number,
  ): CandidateScore | null {
    const environment = this.requireEnvironment()
    let best: CandidateScore | null = null

    for (const candidate of candidates) {
      const travelDistance = distance(input.position, candidate)
      const travelDirection = normalize({
        x: candidate.x - input.position.x,
        y: candidate.y - input.position.y,
      })
      const directionalSpeed =
        environment.maxSpeed * environment.terrainMobilityScale(travelDirection)
      const futureTime = input.time + travelDistance / Math.max(1e-6, directionalSpeed)
      const informationGain = this.expectedInformationGain(candidate, futureTime, currentEntropy)
      const movementPenalty = 0.0005 * (travelDistance / 0.085)
      const visitedSeconds = this.visitTimeNear(candidate)
      const visitPenalty = 0.002 * (1 - Math.exp(-visitedSeconds / 3))
      const score = informationGain - movementPenalty - visitPenalty

      if (best === null || score > best.score + 1e-12) {
        best = { point: candidate, score, informationGain }
      }
    }

    return best
  }

  private expectedInformationGain(
    samplePoint: Vec2,
    sampleTime: number,
    currentEntropy: number,
  ): number {
    const environment = this.requireEnvironment()
    let predictiveHit = 0

    for (const cell of this.cells) {
      const prior = this.posterior[cell.index] ?? 0
      const hitProbability = poissonHitProbability(
        environment.expectedHitRate(cell.point, samplePoint, sampleTime),
      )
      predictiveHit += prior * hitProbability
    }

    predictiveHit = clamp(predictiveHit, 1e-9, 1 - 1e-9)
    let entropyAfterHit = 0
    let entropyAfterMiss = 0

    for (const cell of this.cells) {
      const prior = this.posterior[cell.index] ?? 0
      const hitProbability = poissonHitProbability(
        environment.expectedHitRate(cell.point, samplePoint, sampleTime),
      )
      const posteriorOnHit = (prior * hitProbability) / predictiveHit
      const posteriorOnMiss = (prior * (1 - hitProbability)) / (1 - predictiveHit)
      entropyAfterHit += entropyTerm(posteriorOnHit)
      entropyAfterMiss += entropyTerm(posteriorOnMiss)
    }

    const expectedEntropy =
      predictiveHit * entropyAfterHit + (1 - predictiveHit) * entropyAfterMiss
    return Math.max(0, currentEntropy - expectedEntropy)
  }

  private recordVisit(position: Vec2, dt: number): void {
    const index = this.closestCellIndex(position)
    if (index === null) return
    this.visitSeconds[index] = (this.visitSeconds[index] ?? 0) + Math.max(0, dt)
  }

  private visitTimeNear(point: Vec2): number {
    const index = this.closestCellIndex(point)
    return index === null ? 0 : (this.visitSeconds[index] ?? 0)
  }

  private closestCellIndex(point: Vec2): number | null {
    let closest: GridCell | undefined
    let closestDistance = Number.POSITIVE_INFINITY
    for (const cell of this.cells) {
      const candidateDistance = distance(point, cell.point)
      if (candidateDistance < closestDistance) {
        closest = cell
        closestDistance = candidateDistance
      }
    }
    return closest?.index ?? null
  }

  private debugGrid(): DebugGrid {
    let maximum = 0
    for (const cell of this.cells) maximum = Math.max(maximum, this.posterior[cell.index] ?? 0)
    const values = this.posterior.map((value) => (maximum > 0 ? value / maximum : 0))
    return {
      width: GRID_WIDTH,
      height: GRID_HEIGHT,
      values,
      label: 'Source posterior (relative)',
      palette: 'belief',
    }
  }

  private debugNote(statistics: PosteriorStatistics): string {
    return (
      `H ${statistics.entropy.toFixed(2)} nat · spread ${statistics.radius.toFixed(3)} · ` +
      `MAP ${(statistics.maxProbability * 100).toFixed(1)}% · ` +
      `${this.hitMeasurements}/${this.assimilatedMeasurements} hits`
    )
  }
}

export const createInfotaxisController = (): AlgorithmController => new InfotaxisController()

export default InfotaxisController
