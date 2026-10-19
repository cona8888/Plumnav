import type { Vec2 } from '../src/sim/types'

/**
 * Separately authored arithmetic used by the Phase 5 development replay
 * evaluators. This module deliberately does not import production RNG or math
 * helpers: agreement therefore checks the recorded implementation rather than
 * calling the implementation under test a second time.
 */

export type ReferenceSmcParticle = Vec2 & {
  weight: number
  strength: number
}

type ReferencePmfsCell = Vec2 & {
  weight: number
  index: number
}

export type ReferencePmfsActionScore = {
  point: Vec2
  variance: number
  mapUncertainty: number
  travelPenalty: number
  score: number
}

const clampReference = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value))

const referenceHashNumbers = (...values: number[]) => {
  let hash = 2_166_136_261 >>> 0
  for (const value of values) {
    const scaled = Math.round(value * 1_000_003)
    hash ^= scaled
    hash = Math.imul(hash, 16_777_619)
    hash ^= hash >>> 13
  }
  return hash >>> 0
}

class ReferenceRandom {
  private state: number
  private spareNormal: number | null = null
  uniformDraws = 0
  normalCalls = 0

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e37_79b9
  }

  next() {
    this.uniformDraws += 1
    let value = (this.state += 0x6d2b_79f5)
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }

  range(minimum: number, maximum: number) {
    return minimum + (maximum - minimum) * this.next()
  }

  normal(mean = 0, standardDeviation = 1) {
    this.normalCalls += 1
    if (this.spareNormal !== null) {
      const value = this.spareNormal
      this.spareNormal = null
      return mean + value * standardDeviation
    }
    const u = Math.max(1e-12, this.next())
    const v = this.next()
    const magnitude = Math.sqrt(-2 * Math.log(u))
    const first = magnitude * Math.cos(2 * Math.PI * v)
    this.spareNormal = magnitude * Math.sin(2 * Math.PI * v)
    return mean + first * standardDeviation
  }
}

const referenceWeightedMean = (
  particles: readonly ReferenceSmcParticle[],
): Vec2 => {
  const total = particles.reduce((value, particle) => value + particle.weight, 0)
  if (total <= 0) return { x: 0.5, y: 0.5 }
  return particles.reduce(
    (mean, particle) => ({
      x: mean.x + (particle.x * particle.weight) / total,
      y: mean.y + (particle.y * particle.weight) / total,
    }),
    { x: 0, y: 0 },
  )
}

const referenceWeightedRadius = (
  particles: readonly ReferenceSmcParticle[],
  center: Vec2,
) => {
  const total = particles.reduce((value, particle) => value + particle.weight, 0)
  if (total <= 0) return 1
  const variance = particles.reduce(
    (value, particle) => value + particle.weight *
      Math.hypot(particle.x - center.x, particle.y - center.y) ** 2,
    0,
  )
  return Math.sqrt(variance / total)
}

const referenceEffectiveSampleSize = (weights: readonly number[]) => {
  const squaredSum = weights.reduce((value, weight) => value + weight * weight, 0)
  return squaredSum > 0 ? 1 / squaredSum : 0
}

export const independentlyReplaySmcHitAndResample = (options: {
  controllerSeed: number
  robotStart: Vec2
  isBlocked: (point: Vec2, clearance: number) => boolean
  expectedHitRate: (candidateSource: Vec2, samplePoint: Vec2, time: number) => number
  observation: { position: Vec2; time: number; hit: boolean }
}) => {
  const particleCount = 320
  const random = new ReferenceRandom(referenceHashNumbers(options.controllerSeed, 0x534d_434b))
  const particles: ReferenceSmcParticle[] = []
  const equalWeight = 1 / particleCount

  const sampleFreePosition = (): Vec2 => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const candidate = {
        x: random.range(0.02, 0.98),
        y: random.range(0.02, 0.98),
      }
      if (!options.isBlocked(candidate, 0.008)) return candidate
    }
    return { ...options.robotStart }
  }

  for (let index = 0; index < particleCount; index += 1) {
    const column = index % 20
    const row = Math.floor(index / 20) % 16
    let position = {
      x: (column + random.next()) / 20,
      y: (row + random.next()) / 16,
    }
    const inside = position.x >= 0.015 && position.x <= 0.985 &&
      position.y >= 0.015 && position.y <= 0.985
    if (!inside || options.isBlocked(position, 0.008)) position = sampleFreePosition()
    const logStrength = random.range(Math.log(0.4), Math.log(2.4))
    particles.push({ ...position, strength: Math.exp(logStrength), weight: equalWeight })
  }

  const priorParticles = particles.map((particle) => ({ ...particle }))
  const logWeights = particles.map((particle) => {
    const rate = Math.max(
      0,
      options.expectedHitRate(
        particle,
        options.observation.position,
        options.observation.time,
      ),
    )
    const hitProbability = clampReference(
      1 - Math.exp(-rate * particle.strength),
      1e-6,
      1 - 1e-6,
    )
    const likelihood = options.observation.hit ? hitProbability : 1 - hitProbability
    return Math.log(Math.max(particle.weight, Number.MIN_VALUE)) +
      Math.log(Math.max(likelihood, 1e-6)) * 0.28
  })
  const maximumLogWeight = Math.max(...logWeights)
  const unnormalized = logWeights.map((value) => Math.exp(value - maximumLogWeight))
  const normalizer = unnormalized.reduce((value, weight) => value + weight, 0)
  const normalizedPreResample = particles.map((particle, index) => ({
    ...particle,
    weight: (unnormalized[index] ?? 0) / normalizer,
  }))
  const preResampleEffectiveSampleSize = referenceEffectiveSampleSize(
    normalizedPreResample.map((particle) => particle.weight),
  )
  const resampleThreshold = particleCount * 0.52
  const resampleTriggered = preResampleEffectiveSampleSize < resampleThreshold
  if (!resampleTriggered) {
    return {
      priorParticles,
      normalizedPreResample,
      postUpdateParticles: normalizedPreResample,
      preResampleEffectiveSampleSize,
      resampleThreshold,
      resampleTriggered,
      systematicStart: null,
      jitterStandardDeviation: null,
      ancestorIndices: [] as number[],
      uniformDraws: random.uniformDraws,
      normalCalls: random.normalCalls,
    }
  }

  const spatialCenter = referenceWeightedMean(normalizedPreResample)
  const currentRadius = referenceWeightedRadius(normalizedPreResample, spatialCenter)
  const jitterStandardDeviation = clampReference(currentRadius * 0.18, 0.006, 0.026)
  const systematicStart = random.next() / particleCount
  const postUpdateParticles: ReferenceSmcParticle[] = []
  const ancestorIndices: number[] = []
  let sourceIndex = 0
  let cumulativeWeight = normalizedPreResample[0]?.weight ?? equalWeight

  for (let index = 0; index < particleCount; index += 1) {
    const threshold = systematicStart + index / particleCount
    while (threshold > cumulativeWeight && sourceIndex < particleCount - 1) {
      sourceIndex += 1
      cumulativeWeight += normalizedPreResample[sourceIndex]?.weight ?? 0
    }
    const source = normalizedPreResample[sourceIndex] ?? normalizedPreResample[0]
    if (source === undefined) continue
    ancestorIndices.push(sourceIndex)
    let position: Vec2 = { x: source.x, y: source.y }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = {
        x: clampReference(
          random.normal(source.x, jitterStandardDeviation),
          0.015,
          0.985,
        ),
        y: clampReference(
          random.normal(source.y, jitterStandardDeviation),
          0.015,
          0.985,
        ),
      }
      if (!options.isBlocked(candidate, 0.006)) {
        position = candidate
        break
      }
    }
    const strength = clampReference(
      source.strength * Math.exp(random.normal(0, 0.075)),
      0.25,
      3,
    )
    postUpdateParticles.push({ ...position, strength, weight: equalWeight })
  }

  return {
    priorParticles,
    normalizedPreResample,
    postUpdateParticles,
    preResampleEffectiveSampleSize,
    resampleThreshold,
    resampleTriggered,
    systematicStart,
    jitterStandardDeviation,
    ancestorIndices,
    uniformDraws: random.uniformDraws,
    normalCalls: random.normalCalls,
  }
}

export const independentlyScorePmfsActions = (options: {
  posteriorCells: readonly ReferencePmfsCell[]
  hitMap: readonly number[]
  position: Vec2
  time: number
  isBlocked: (point: Vec2, clearance: number) => boolean
  expectedHitRate: (candidateSource: Vec2, samplePoint: Vec2, time: number) => number
}) => {
  const likely = [...options.posteriorCells]
    .sort((first, second) => second.weight - first.weight)
    .slice(0, 36)
  const candidates = Array.from({ length: 12 }, (_, index) => {
    const angle = (index / 12) * Math.PI * 2
    return {
      x: options.position.x + Math.cos(angle) * 0.105,
      y: options.position.y + Math.sin(angle) * 0.105,
    }
  }).filter((point) => !options.isBlocked(point, 0.018))
  if (likely[0]) candidates.push({ x: likely[0].x, y: likely[0].y })

  const likelyMass = likely.reduce((value, cell) => value + cell.weight, 0) || 1
  const actionScores: ReferencePmfsActionScore[] = []
  let selectedIndex = 0
  let bestScore = Number.NEGATIVE_INFINITY
  candidates.forEach((candidate, candidateIndex) => {
    const probabilities = likely.map((cell) =>
      1 - Math.exp(-options.expectedHitRate(cell, candidate, options.time)))
    const mean = likely.reduce(
      (value, cell, index) => value + cell.weight * (probabilities[index] ?? 0),
      0,
    ) / likelyMass
    const variance = likely.reduce(
      (value, cell, index) => value +
        (cell.weight / likelyMass) * ((probabilities[index] ?? mean) - mean) ** 2,
      0,
    )
    const gx = clampReference(Math.floor(candidate.x * 18), 0, 17)
    const gy = clampReference(Math.floor(candidate.y * 18), 0, 17)
    const mapProbability = clampReference(
      options.hitMap[gy * 18 + gx] ?? 0.08,
      1e-8,
      1 - 1e-8,
    )
    const mapUncertainty = -mapProbability * Math.log(mapProbability) -
      (1 - mapProbability) * Math.log(1 - mapProbability)
    const travelPenalty = Math.hypot(
      candidate.x - options.position.x,
      candidate.y - options.position.y,
    ) * 0.22
    const score = variance * 8.5 + mapUncertainty * 0.18 - travelPenalty
    actionScores.push({
      point: { ...candidate },
      variance,
      mapUncertainty,
      travelPenalty,
      score,
    })
    if (score > bestScore) {
      bestScore = score
      selectedIndex = candidateIndex
    }
  })

  return {
    likelyCells: likely,
    actionScores,
    selectedIndex,
    selectedTarget: actionScores[selectedIndex]?.point ?? { ...options.position },
  }
}
