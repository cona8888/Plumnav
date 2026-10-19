import { distance, normalize, percentile, weightedMean, weightedRadius } from '../math'
import type {
  AlgorithmController,
  AlgorithmDecision,
  AlgorithmEnvironment,
  AlgorithmStepInput,
  Vec2,
  WeightedPoint,
} from '../types'
import { ALGORITHM_METADATA } from './metadata'
import { confirmSourceFromConcentration } from './confirmation'

const GRID_SIZE = 18
const EPSILON = 1e-12

type GridCell = WeightedPoint & { index: number }

type PmfsActionScore = {
  point: Vec2
  variance: number
  mapUncertainty: number
  travelPenalty: number
  score: number
}

type PmfsDiagnostics = {
  lastActionScores: PmfsActionScore[]
  selectedIndex: number | null
  selectedScore: number | null
}

const entropy = (probability: number) => {
  const p = Math.max(1e-8, Math.min(1 - 1e-8, probability))
  return -p * Math.log(p) - (1 - p) * Math.log(1 - p)
}

export class PmfsController implements AlgorithmController {
  readonly metadata = ALGORITHM_METADATA.pmfs
  private environment!: AlgorithmEnvironment
  private cells: GridCell[] = []
  private hitMap: number[] = []
  private target: Vec2 | null = null
  private lastPlanTime = -Infinity
  private stepCount = 0
  private lastObservationIndex = 0
  private refinedSourceEstimate: Vec2 | null = null
  private diagnostics: PmfsDiagnostics = {
    lastActionScores: [],
    selectedIndex: null,
    selectedScore: null,
  }

  reset(environment: AlgorithmEnvironment) {
    this.environment = environment
    this.cells = []
    this.hitMap = new Array(GRID_SIZE * GRID_SIZE).fill(0.08) as number[]
    for (let y = 0; y < GRID_SIZE; y += 1) {
      for (let x = 0; x < GRID_SIZE; x += 1) {
        const point = { x: (x + 0.5) / GRID_SIZE, y: (y + 0.5) / GRID_SIZE }
        if (environment.isBlocked(point, 0.006)) continue
        this.cells.push({ ...point, weight: 1, index: y * GRID_SIZE + x })
      }
    }
    const uniform = 1 / Math.max(1, this.cells.length)
    this.cells.forEach((cell) => {
      cell.weight = uniform
    })
    this.target = null
    this.lastPlanTime = -Infinity
    this.stepCount = 0
    this.lastObservationIndex = 0
    this.refinedSourceEstimate = null
    this.diagnostics = {
      lastActionScores: [],
      selectedIndex: null,
      selectedScore: null,
    }
  }

  private updateHitMap(input: AlgorithmStepInput) {
    const { position, measurement } = input
    const wind = normalize(measurement.wind, { x: -1, y: 0 })
    const cross = { x: -wind.y, y: wind.x }
    for (let gy = 0; gy < GRID_SIZE; gy += 1) {
      for (let gx = 0; gx < GRID_SIZE; gx += 1) {
        const index = gy * GRID_SIZE + gx
        const point = { x: (gx + 0.5) / GRID_SIZE, y: (gy + 0.5) / GRID_SIZE }
        if (this.environment.isBlocked(point, 0.002)) {
          this.hitMap[index] = 0
          continue
        }
        const dx = point.x - position.x
        const dy = point.y - position.y
        const along = dx * wind.x + dy * wind.y
        const lateral = Math.abs(dx * cross.x + dy * cross.y)
        const influence =
          Math.exp(-(lateral * lateral) / (2 * 0.075 ** 2)) *
          Math.exp(-Math.abs(along) / 0.19) *
          (along > -0.04 ? 1 : 0.45)
        const prior = this.hitMap[index] ?? 0.08
        const evidence = measurement.hit ? 0.83 : 0.025
        this.hitMap[index] = Math.max(0.002, Math.min(0.998, prior * (1 - influence * 0.24) + evidence * influence * 0.24))
      }
    }
  }

  private updateSourcePosterior(input: AlgorithmStepInput) {
    const pending = input.observations.slice(this.lastObservationIndex)
    if (pending.length === 0) return
    let total = 0
    for (const cell of this.cells) {
      let logLikelihood = Math.log(Math.max(EPSILON, cell.weight))
      for (const observation of pending) {
        const rate = this.environment.expectedHitRate(cell, observation.position, observation.time)
        const predictedHit = 1 - Math.exp(-rate)
        const probability = observation.hit ? predictedHit : 1 - predictedHit
        logLikelihood += Math.log(Math.max(0.015, probability)) * 0.28
      }

      if (this.stepCount % 5 === 0) {
        let mapError = 0
        let samples = 0
        for (let index = cell.index % 4; index < this.hitMap.length; index += 13) {
          const gx = index % GRID_SIZE
          const gy = Math.floor(index / GRID_SIZE)
          const point = { x: (gx + 0.5) / GRID_SIZE, y: (gy + 0.5) / GRID_SIZE }
          if (this.environment.isBlocked(point, 0.002)) continue
          const predicted = 1 - Math.exp(-this.environment.expectedHitRate(cell, point, input.time))
          mapError += Math.abs(predicted - (this.hitMap[index] ?? 0.08))
          samples += 1
        }
        if (samples > 0) logLikelihood -= (mapError / samples) * 0.14
      }

      cell.weight = Math.exp(Math.max(-60, logLikelihood))
      total += cell.weight
    }
    if (total <= EPSILON) {
      const uniform = 1 / this.cells.length
      this.cells.forEach((cell) => {
        cell.weight = uniform
      })
      return
    }
    this.cells.forEach((cell) => {
      cell.weight /= total
    })
    this.lastObservationIndex = input.observations.length
  }

  private refineEstimate(input: AlgorithmStepInput, fallback: Vec2) {
    const recent = input.observations.slice(-100).filter((_, index) => index % 2 === 0)
    if (recent.filter((observation) => observation.hit).length < 3) return fallback
    const mapCell = [...this.cells].sort((a, b) => b.weight - a.weight)[0]
    if (!mapCell) return fallback
    let best: Vec2 = { x: mapCell.x, y: mapCell.y }
    let bestScore = -Infinity
    const step = 1 / (GRID_SIZE * 6)
    for (let offsetY = -4; offsetY <= 4; offsetY += 1) {
      for (let offsetX = -4; offsetX <= 4; offsetX += 1) {
        const candidate = {
          x: Math.max(0.008, Math.min(0.992, mapCell.x + offsetX * step)),
          y: Math.max(0.008, Math.min(0.992, mapCell.y + offsetY * step)),
        }
        if (this.environment.isBlocked(candidate, 0.004)) continue
        let score = 0
        for (const observation of recent) {
          const probability =
            1 -
            Math.exp(
              -this.environment.expectedHitRate(candidate, observation.position, observation.time),
            )
          score += Math.log(
            Math.max(0.01, observation.hit ? probability : 1 - probability),
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

  private chooseTarget(input: AlgorithmStepInput) {
    const directions = Array.from({ length: 12 }, (_, index) => {
      const angle = (index / 12) * Math.PI * 2
      return {
        x: input.position.x + Math.cos(angle) * 0.105,
        y: input.position.y + Math.sin(angle) * 0.105,
      }
    })
    const likely = [...this.cells].sort((a, b) => b.weight - a.weight).slice(0, 36)
    const candidates = directions.filter((point) => !this.environment.isBlocked(point, 0.018))
    if (likely[0]) candidates.push({ x: likely[0].x, y: likely[0].y })

    let best = candidates[0] ?? input.position
    let bestScore = -Infinity
    this.diagnostics.lastActionScores = []
    this.diagnostics.selectedIndex = null
    this.diagnostics.selectedScore = null
    for (const [candidateIndex, candidate] of candidates.entries()) {
      let expected = 0
      let mean = 0
      const probabilities: number[] = []
      for (const sourceCell of likely) {
        const hitProbability = 1 - Math.exp(-this.environment.expectedHitRate(sourceCell, candidate, input.time))
        mean += sourceCell.weight * hitProbability
        probabilities.push(hitProbability)
      }
      const likelyMass = likely.reduce((sum, cell) => sum + cell.weight, 0) || 1
      mean /= likelyMass
      for (let index = 0; index < likely.length; index += 1) {
        const cell = likely[index]
        if (!cell) continue
        const probability = probabilities[index] ?? mean
        expected += (cell.weight / likelyMass) * (probability - mean) ** 2
      }
      const gx = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor(candidate.x * GRID_SIZE)))
      const gy = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor(candidate.y * GRID_SIZE)))
      const mapUncertainty = entropy(this.hitMap[gy * GRID_SIZE + gx] ?? 0.08)
      const travelPenalty = distance(input.position, candidate) * 0.22
      const score = expected * 8.5 + mapUncertainty * 0.18 - travelPenalty
      this.diagnostics.lastActionScores.push({
        point: { x: candidate.x, y: candidate.y },
        variance: expected,
        mapUncertainty,
        travelPenalty,
        score,
      })
      if (score > bestScore) {
        bestScore = score
        best = candidate
        this.diagnostics.selectedIndex = candidateIndex
        this.diagnostics.selectedScore = score
      }
    }
    this.target = best
    this.lastPlanTime = input.time
  }

  step(input: AlgorithmStepInput): AlgorithmDecision {
    this.stepCount += 1
    this.updateHitMap(input)
    if (this.stepCount % 2 === 0) this.updateSourcePosterior(input)
    if (
      !this.target ||
      input.time - this.lastPlanTime >= 1.4 ||
      distance(input.position, this.target) < 0.025
    ) {
      this.chooseTarget(input)
    }

    const coarseEstimate = weightedMean(this.cells)
    if (this.stepCount % 4 === 0) {
      this.refinedSourceEstimate = this.refineEstimate(input, coarseEstimate)
    }
    const estimate = this.refinedSourceEstimate ?? coarseEstimate
    const confirmation = confirmSourceFromConcentration(input.observations, estimate)
    const reportedEstimate = confirmation?.estimate ?? estimate
    const spread = weightedRadius(this.cells, coarseEstimate)
    const confidence = Math.max(0, Math.min(1, 1 - spread / 0.34))
    const hitCount = input.observations.reduce(
      (count, observation) => count + (observation.hit ? 1 : 0),
      0,
    )
    const nativeTerminated =
      confirmation !== null &&
      input.observations.length > 100 &&
      hitCount >= 6 &&
      spread < 0.022
    const desired = this.target ? normalize({ x: this.target.x - input.position.x, y: this.target.y - input.position.y }) : { x: 1, y: 0 }
    const direction = this.environment.safeDirection(input.position, desired)
    const values = new Array(GRID_SIZE * GRID_SIZE).fill(0) as number[]
    this.cells.forEach((cell) => {
      values[cell.index] = cell.weight
    })
    const maximum = percentile(values, 0.995) || 1

    return {
      direction,
      estimate: reportedEstimate,
      confidence,
      phase: input.observations.length < 18 ? 'BUILDING HIT MAP' : 'FILAMENT HYPOTHESIS TEST',
      nativeTerminated,
      terminationReason: nativeTerminated
        ? 'PMFS posterior contracted and a local concentration peak confirmed the candidate'
        : undefined,
      debug: {
        target: this.target ?? undefined,
        grid: {
          width: GRID_SIZE,
          height: GRID_SIZE,
          values: values.map((value) => Math.min(1, value / maximum)),
          label: 'Source probability • PMFS',
          palette: 'hit-map',
        },
        candidates: [...this.cells].sort((a, b) => b.weight - a.weight).slice(0, 8),
        note: `Posterior radius ${(spread * 100).toFixed(1)}% of domain`,
      },
    }
  }
}

export const createPmfsController = () => new PmfsController()
