import {
  clamp,
  distance,
  magnitude,
  normalize,
  rotate,
  scale,
} from '../math'
import { SeededRandom } from '../rng'
import type {
  AlgorithmController,
  AlgorithmDecision,
  AlgorithmEnvironment,
  AlgorithmId,
  AlgorithmStepInput,
  Vec2,
} from '../types'
import { ALGORITHM_METADATA } from './metadata'

export type ReactiveAlgorithmId = Extract<
  AlgorithmId,
  'coverage' | 'surge-cast' | 'zigzag-spiral'
>

type SensorSample = {
  time: number
  position: Vec2
  concentration: number
  hit: boolean
}

type PeakEstimate = {
  point: Vec2
  concentration: number
  support: number
}

type PeakEvidence = {
  coreCount: number
  coreHits: number
  ringCount: number
  coreMean: number
  ringMean: number
  contrast: number
}

type TimedPoint = {
  time: number
  point: Vec2
}

const ZERO: Vec2 = { x: 0, y: 0 }
const DOMAIN_MARGIN = 0.035
const SAMPLE_INTERVAL = 0.18
const MAX_TRACKED_SAMPLES = 1_200

const copyPoint = (point: Vec2): Vec2 => ({ x: point.x, y: point.y })

const clampPoint = (point: Vec2, margin = DOMAIN_MARGIN): Vec2 => ({
  x: clamp(point.x, margin, 1 - margin),
  y: clamp(point.y, margin, 1 - margin),
})

const pointAlong = (origin: Vec2, direction: Vec2, amount: number): Vec2 =>
  clampPoint({
    x: origin.x + direction.x * amount,
    y: origin.y + direction.y * amount,
  })

/** Every non-zero command is filtered through the simulator's obstacle-aware steering hook. */
const obstacleSafeDirection = (
  environment: AlgorithmEnvironment,
  from: Vec2,
  desired: Vec2,
): Vec2 => {
  if (magnitude(desired) <= 1e-9) return ZERO

  const primary = normalize(desired)
  const angles = [0, Math.PI / 5, -Math.PI / 5, Math.PI / 2, -Math.PI / 2, Math.PI]
  for (const angle of angles) {
    const candidate = rotate(primary, angle)
    const safe = environment.safeDirection(from, candidate)
    if (magnitude(safe) > 1e-7) return normalize(safe, candidate)
  }
  return ZERO
}

const mean = (values: readonly number[]) => {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

class ObservationTracker {
  private samples: SensorSample[] = []
  private best: SensorSample | null = null
  private lastStoredTime = -Infinity
  private lastStoredHit = false

  reset() {
    this.samples = []
    this.best = null
    this.lastStoredTime = -Infinity
    this.lastStoredHit = false
  }

  observe(input: AlgorithmStepInput) {
    // Reactive peak/declaration evidence is defined only by valid passive
    // measurements. Active/quad returns are intervention-specific signals,
    // while blanked or otherwise invalid frames contain no admissible sample.
    if (!input.measurement.valid || input.measurement.sampleMode !== 'passive') return

    const sample: SensorSample = {
      time: input.time,
      position: copyPoint(input.position),
      concentration: Number.isFinite(input.measurement.concentration)
        ? input.measurement.concentration
        : 0,
      hit: input.measurement.hit,
    }
    const isNewBest = this.best === null || sample.concentration > this.best.concentration
    if (isNewBest) this.best = sample

    const hitChanged = sample.hit !== this.lastStoredHit
    if (isNewBest || hitChanged || sample.time - this.lastStoredTime >= SAMPLE_INTERVAL) {
      this.samples.push(sample)
      this.lastStoredTime = sample.time
      this.lastStoredHit = sample.hit
      if (this.samples.length > MAX_TRACKED_SAMPLES) {
        this.samples.splice(0, this.samples.length - MAX_TRACKED_SAMPLES)
      }
    }
  }

  maxEstimate(): Vec2 | null {
    return this.best ? copyPoint(this.best.position) : null
  }

  bestConcentration() {
    return this.best?.concentration ?? 0
  }

  hitCount() {
    return this.samples.reduce((count, sample) => count + (sample.hit ? 1 : 0), 0)
  }

  peak(radius: number, sinceTime = -Infinity): PeakEstimate | null {
    let anchor: SensorSample | null = null
    for (const sample of this.samples) {
      if (sample.time < sinceTime) continue
      if (anchor === null || sample.concentration > anchor.concentration) anchor = sample
    }
    if (anchor === null) return null

    const local = this.samples.filter(
      (sample) =>
        sample.time >= sinceTime && distance(sample.position, anchor.position) <= radius,
    )
    if (local.length === 0) {
      return {
        point: copyPoint(anchor.position),
        concentration: anchor.concentration,
        support: 1,
      }
    }

    let minimum = local[0]?.concentration ?? anchor.concentration
    let maximum = minimum
    for (const sample of local) {
      minimum = Math.min(minimum, sample.concentration)
      maximum = Math.max(maximum, sample.concentration)
    }
    const spread = Math.max(1e-6, maximum - minimum)
    const selectionFloor = minimum + spread * 0.5
    const selected = local.filter(
      (sample) => sample.concentration >= selectionFloor || (sample.hit && spread < 1e-4),
    )
    const contributors = selected.length > 0 ? selected : [anchor]

    let totalWeight = 0
    let x = 0
    let y = 0
    for (const sample of contributors) {
      const relativeStrength = Math.max(1e-5, sample.concentration - minimum + spread * 0.08)
      const weight = relativeStrength * relativeStrength * (sample.hit ? 1.25 : 1)
      totalWeight += weight
      x += sample.position.x * weight
      y += sample.position.y * weight
    }

    return {
      point:
        totalWeight > 0
          ? clampPoint({ x: x / totalWeight, y: y / totalWeight })
          : copyPoint(anchor.position),
      concentration: anchor.concentration,
      support: contributors.length,
    }
  }

  evidence(
    center: Vec2,
    now: number,
    horizon: number,
    coreRadius: number,
    ringRadius: number,
  ): PeakEvidence {
    const core: SensorSample[] = []
    const ring: SensorSample[] = []
    const oldestTime = now - horizon
    for (const sample of this.samples) {
      if (sample.time < oldestTime) continue
      const radius = distance(sample.position, center)
      if (radius <= coreRadius) core.push(sample)
      else if (radius <= ringRadius) ring.push(sample)
    }

    const coreMean = mean(core.map((sample) => sample.concentration))
    const ringMean = mean(ring.map((sample) => sample.concentration))
    const concentrationScale = Math.max(0.02, Math.abs(coreMean), Math.abs(ringMean))
    return {
      coreCount: core.length,
      coreHits: core.reduce((count, sample) => count + (sample.hit ? 1 : 0), 0),
      ringCount: ring.length,
      coreMean,
      ringMean,
      contrast: (coreMean - ringMean) / concentrationScale,
    }
  }
}

const peakStability = (history: readonly TimedPoint[], count = 8) => {
  const recent = history.slice(Math.max(0, history.length - count))
  if (recent.length === 0) return { radius: 1, span: 0, count: 0 }

  const center = recent.reduce(
    (sum, item) => ({ x: sum.x + item.point.x, y: sum.y + item.point.y }),
    { x: 0, y: 0 },
  )
  center.x /= recent.length
  center.y /= recent.length
  const radius = Math.sqrt(
    recent.reduce((sum, item) => sum + distance(item.point, center) ** 2, 0) /
      recent.length,
  )
  const first = recent[0]
  const last = recent[recent.length - 1]
  return {
    radius,
    span: first && last ? last.time - first.time : 0,
    count: recent.length,
  }
}

const buildCoverageWaypoints = (startAtTop: boolean): Vec2[] => {
  const margin = 0.055
  const laneCount = 9
  const laneStep = (1 - margin * 2) / (laneCount - 1)
  const waypoints: Vec2[] = []
  let startsAtTop = startAtTop

  for (let lane = 0; lane < laneCount; lane += 1) {
    const x = margin + lane * laneStep
    const startY = startsAtTop ? margin : 1 - margin
    const endY = startsAtTop ? 1 - margin : margin
    if (lane === 0) waypoints.push({ x, y: startY })
    waypoints.push({ x, y: endY })
    if (lane < laneCount - 1) waypoints.push({ x: x + laneStep, y: endY })
    startsAtTop = !startsAtTop
  }

  return waypoints
}

const buildPlumeAcquisitionWaypoints = (startAtTop: boolean): Vec2[] => {
  const waypoints: Vec2[] = []
  const columns = 7
  for (let index = 0; index < columns; index += 1) {
    const x = 0.06 + (index / (columns - 1)) * 0.88
    const top = index % 2 === 0 ? startAtTop : !startAtTop
    waypoints.push({ x, y: top ? 0.08 : 0.92 })
  }
  return waypoints
}

export class CoverageController implements AlgorithmController {
  readonly metadata = ALGORITHM_METADATA.coverage

  private environment!: AlgorithmEnvironment
  private readonly tracker = new ObservationTracker()
  private waypoints: Vec2[] = []
  private waypointIndex = 0
  private terminated = false

  reset(environment: AlgorithmEnvironment) {
    this.environment = environment
    this.tracker.reset()
    const random = new SeededRandom(environment.controllerSeed ^ 0x00c0_5e11)
    this.waypoints = buildCoverageWaypoints(random.next() < 0.5)
    this.waypointIndex = 0
    this.terminated = false
  }

  step(input: AlgorithmStepInput): AlgorithmDecision {
    this.tracker.observe(input)

    while (
      this.waypointIndex < this.waypoints.length &&
      distance(input.position, this.waypoints[this.waypointIndex] ?? input.position) <= 0.022
    ) {
      this.waypointIndex += 1
    }
    if (this.waypointIndex >= this.waypoints.length) this.terminated = true

    const estimate = this.tracker.maxEstimate()
    const progress = clamp(this.waypointIndex / Math.max(1, this.waypoints.length))
    const confidence = estimate
      ? clamp(progress * 0.8 + Math.min(0.15, this.tracker.hitCount() * 0.004))
      : 0

    if (this.terminated) {
      return {
        direction: ZERO,
        estimate,
        confidence: clamp(Math.max(confidence, 0.85)),
        phase: 'COVERAGE COMPLETE',
        nativeTerminated: true,
        terminationReason:
          'Boustrophedon sweep completed; reporting the highest measured concentration.',
        debug: {
          target: estimate ?? undefined,
          note: 'All lanes sampled. Estimate uses measured concentration only.',
        },
      }
    }

    const target = this.waypoints[this.waypointIndex] ?? input.position
    const desired = { x: target.x - input.position.x, y: target.y - input.position.y }
    const direction = obstacleSafeDirection(this.environment, input.position, desired)
    return {
      direction,
      estimate,
      confidence,
      phase: 'BOUSTROPHEDON SWEEP',
      debug: {
        target: copyPoint(target),
        note: `Lane waypoint ${this.waypointIndex + 1}/${this.waypoints.length}; ${(
          progress * 100
        ).toFixed(0)}% complete.`,
      },
    }
  }
}

export class SurgeCastController implements AlgorithmController {
  readonly metadata = ALGORITHM_METADATA['surge-cast']

  private environment!: AlgorithmEnvironment
  private readonly tracker = new ObservationTracker()
  private lastUpwind: Vec2 = { x: 1, y: 0 }
  private castSide = 1
  private castProgress = 0
  private castSpan = 0.045
  private castLeg = 0
  private wasHit = false
  private lastHitTime = -Infinity
  private peak: PeakEstimate | null = null
  private peakHistory: TimedPoint[] = []
  private lastPeakUpdate = -Infinity
  private evidence: PeakEvidence = {
    coreCount: 0,
    coreHits: 0,
    ringCount: 0,
    coreMean: 0,
    ringMean: 0,
    contrast: 0,
  }
  private declarationEvidenceSeconds = 0
  private terminated = false
  private terminationReason: string | undefined
  private everHit = false
  private surgeDistance = 0
  private acquisitionWaypoints: Vec2[] = []
  private acquisitionIndex = 0
  private previousPosition: Vec2 = { x: 0.5, y: 0.5 }
  private previousMotion: 'surge' | 'cast' | 'other' = 'other'

  reset(environment: AlgorithmEnvironment) {
    this.environment = environment
    this.tracker.reset()
    const random = new SeededRandom(environment.controllerSeed ^ 0x51a9_c457)
    const fallbackAngle = random.range(-Math.PI, Math.PI)
    this.lastUpwind = { x: Math.cos(fallbackAngle), y: Math.sin(fallbackAngle) }
    this.castSide = random.next() < 0.5 ? -1 : 1
    this.castProgress = 0
    this.castSpan = 0.045
    this.castLeg = 0
    this.wasHit = false
    this.lastHitTime = -Infinity
    this.peak = null
    this.peakHistory = []
    this.lastPeakUpdate = -Infinity
    this.evidence = {
      coreCount: 0,
      coreHits: 0,
      ringCount: 0,
      coreMean: 0,
      ringMean: 0,
      contrast: 0,
    }
    this.declarationEvidenceSeconds = 0
    this.terminated = false
    this.terminationReason = undefined
    this.everHit = false
    this.surgeDistance = 0
    this.acquisitionWaypoints = buildPlumeAcquisitionWaypoints(random.next() < 0.5)
    this.acquisitionIndex = 0
    this.previousPosition = copyPoint(environment.scenario.robotStart)
    this.previousMotion = 'other'
  }

  step(input: AlgorithmStepInput): AlgorithmDecision {
    const actualTravel = distance(this.previousPosition, input.position)
    if (this.previousMotion === 'surge') this.surgeDistance += actualTravel
    if (this.previousMotion === 'cast') {
      this.castProgress += actualTravel
      if (this.castProgress >= this.castSpan) {
        this.castProgress = 0
        this.castSide *= -1
        this.castLeg += 1
        this.castSpan = Math.min(0.22, 0.045 + this.castLeg * 0.018)
      }
    }
    this.previousPosition = copyPoint(input.position)

    this.tracker.observe(input)
    const wind = input.measurement.wind
    if (magnitude(wind) > 1e-6) this.lastUpwind = scale(normalize(wind), -1)

    let phase: string
    let desired: Vec2
    if (!this.everHit && !input.measurement.hit) {
      phase = 'PLUME ACQUISITION SWEEP'
      while (
        this.acquisitionIndex < this.acquisitionWaypoints.length - 1 &&
        distance(
          input.position,
          this.acquisitionWaypoints[this.acquisitionIndex] ?? input.position,
        ) <= 0.025
      ) {
        this.acquisitionIndex += 1
      }
      const target = this.acquisitionWaypoints[this.acquisitionIndex] ?? input.position
      desired = { x: target.x - input.position.x, y: target.y - input.position.y }
    } else if (input.measurement.hit) {
      this.everHit = true
      phase = 'UPWIND SURGE'
      desired = this.lastUpwind
      this.lastHitTime = input.time
      this.castProgress = 0
      if (!this.wasHit) {
        this.castLeg = 0
        this.castSpan = 0.045
      }
    } else {
      phase = 'EXPANDING CROSSWIND CAST'
      if (this.wasHit) {
        this.castProgress = 0
        this.castLeg = 0
        this.castSpan = 0.045
        this.castSide *= -1
      }
      desired = rotate(this.lastUpwind, this.castSide * (Math.PI / 2))
    }
    this.wasHit = input.measurement.hit

    if (input.time - this.lastPeakUpdate >= 0.7 || this.peak === null) {
      this.peak = this.tracker.peak(0.085)
      this.lastPeakUpdate = input.time
      if (this.peak) {
        this.peakHistory.push({ time: input.time, point: copyPoint(this.peak.point) })
        if (this.peakHistory.length > 14) this.peakHistory.shift()
        this.evidence = this.tracker.evidence(this.peak.point, input.time, 24, 0.045, 0.14)
      }
    }

    const estimate = this.peak?.point ?? this.tracker.maxEstimate()
    const stability = peakStability(this.peakHistory)
    const hasStablePeak =
      estimate !== null &&
      stability.count >= 7 &&
      stability.span >= 4.2 &&
      stability.radius <= 0.023 &&
      this.evidence.coreCount >= 8 &&
      this.evidence.coreHits >= 4 &&
      this.evidence.ringCount >= 5 &&
      this.evidence.contrast >= 0.08 &&
      input.time - this.lastHitTime <= 3.5 &&
      distance(input.position, estimate) <= 0.1 &&
      this.surgeDistance >= 0.24 &&
      this.tracker.bestConcentration() >= 0.55

    this.declarationEvidenceSeconds = hasStablePeak
      ? this.declarationEvidenceSeconds + input.dt
      : Math.max(0, this.declarationEvidenceSeconds - input.dt * 1.5)
    if (this.declarationEvidenceSeconds >= 2.5 && estimate) {
      this.terminated = true
      this.terminationReason = `Measured peak remained stable for ${stability.span.toFixed(
        1,
      )} s and exceeded surrounding cast samples.`
      phase = 'STABLE PEAK DECLARED'
    }

    const stabilityScore = clamp(1 - stability.radius / 0.08)
    const supportScore = clamp((this.evidence.coreHits + this.evidence.ringCount * 0.25) / 10)
    const contrastScore = clamp(this.evidence.contrast / 0.35)
    const confidence = estimate
      ? clamp(stabilityScore * 0.35 + supportScore * 0.35 + contrastScore * 0.3)
      : 0

    if (this.terminated) {
      this.previousMotion = 'other'
      return {
        direction: ZERO,
        estimate,
        confidence: Math.max(0.9, confidence),
        phase,
        nativeTerminated: true,
        terminationReason: this.terminationReason,
        debug: {
          target: estimate ?? undefined,
          note: `Local evidence: ${this.evidence.coreHits}/${this.evidence.coreCount} core hits; contrast ${this.evidence.contrast.toFixed(
            2,
          )}.`,
        },
      }
    }

    const direction = obstacleSafeDirection(this.environment, input.position, desired)
    this.previousMotion = phase === 'UPWIND SURGE'
      ? 'surge'
      : phase === 'EXPANDING CROSSWIND CAST'
        ? 'cast'
        : 'other'
    const movementTarget = pointAlong(input.position, direction, Math.max(0.08, this.castSpan))
    return {
      direction,
      estimate,
      confidence,
      phase,
      debug: {
        target: movementTarget,
        note:
          phase === 'UPWIND SURGE'
            ? `Gas hit: steering against measured wind; peak stability ${stability.radius.toFixed(
                3,
              )}.`
            : `Gas lost: cast leg ${this.castLeg + 1}, half-span ${this.castSpan.toFixed(3)}.`,
      },
    }
  }
}

const buildBroadZigzag = (startsHigh: boolean): Vec2[] => {
  const waypoints: Vec2[] = []
  const columns = 8
  const xStart = 0.06
  const xStep = (0.94 - xStart) / (columns - 1)
  for (let index = 0; index < columns; index += 1) {
    const high = index % 2 === 0 ? startsHigh : !startsHigh
    waypoints.push({ x: xStart + index * xStep, y: high ? 0.87 : 0.13 })
  }
  return waypoints
}

export class ZigzagSpiralController implements AlgorithmController {
  readonly metadata = ALGORITHM_METADATA['zigzag-spiral']

  private environment!: AlgorithmEnvironment
  private readonly tracker = new ObservationTracker()
  private acquisitionWaypoints: Vec2[] = []
  private acquisitionIndex = 0
  private refining = false
  private refinementStartedAt = Infinity
  private lastHitTime = -Infinity
  private spiralCenter: Vec2 | null = null
  private spiralRadius = 0.13
  private spiralAngle = 0
  private bestAtCenter = -Infinity
  private peak: PeakEstimate | null = null
  private peakHistory: TimedPoint[] = []
  private lastPeakUpdate = -Infinity
  private evidence: PeakEvidence = {
    coreCount: 0,
    coreHits: 0,
    ringCount: 0,
    coreMean: 0,
    ringMean: 0,
    contrast: 0,
  }
  private declarationEvidenceSeconds = 0
  private terminated = false
  private terminationReason: string | undefined

  reset(environment: AlgorithmEnvironment) {
    this.environment = environment
    this.tracker.reset()
    const random = new SeededRandom(environment.controllerSeed ^ 0x2192_5a91)
    this.acquisitionWaypoints = buildBroadZigzag(random.next() < 0.5)
    this.acquisitionIndex = 0
    this.refining = false
    this.refinementStartedAt = Infinity
    this.lastHitTime = -Infinity
    this.spiralCenter = null
    this.spiralRadius = 0.13
    this.spiralAngle = random.range(-Math.PI, Math.PI)
    this.bestAtCenter = -Infinity
    this.peak = null
    this.peakHistory = []
    this.lastPeakUpdate = -Infinity
    this.evidence = {
      coreCount: 0,
      coreHits: 0,
      ringCount: 0,
      coreMean: 0,
      ringMean: 0,
      contrast: 0,
    }
    this.declarationEvidenceSeconds = 0
    this.terminated = false
    this.terminationReason = undefined
  }

  private beginRefinement(input: AlgorithmStepInput) {
    this.refining = true
    this.refinementStartedAt = input.time
    this.lastHitTime = input.time
    this.peak = this.tracker.peak(0.09, input.time - 4)
    this.spiralCenter = copyPoint(this.peak?.point ?? input.position)
    this.bestAtCenter = this.peak?.concentration ?? input.measurement.concentration
    this.spiralRadius = 0.13
    this.peakHistory = []
    this.lastPeakUpdate = -Infinity
    this.declarationEvidenceSeconds = 0
  }

  private returnToAcquisition(input: AlgorithmStepInput) {
    this.refining = false
    this.refinementStartedAt = Infinity
    this.spiralCenter = null
    this.peak = null
    this.peakHistory = []
    this.declarationEvidenceSeconds = 0

    let nearestIndex = 0
    let nearestDistance = Infinity
    for (let index = 0; index < this.acquisitionWaypoints.length; index += 1) {
      const waypoint = this.acquisitionWaypoints[index]
      if (!waypoint) continue
      const candidateDistance = distance(input.position, waypoint)
      if (candidateDistance < nearestDistance) {
        nearestDistance = candidateDistance
        nearestIndex = index
      }
    }
    this.acquisitionIndex = nearestIndex
  }

  private spiralTarget(center: Vec2): Vec2 {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const angle = this.spiralAngle + attempt * (Math.PI / 5)
      const candidate = clampPoint({
        x: center.x + Math.cos(angle) * this.spiralRadius,
        y: center.y + Math.sin(angle) * this.spiralRadius,
      })
      if (!this.environment.isBlocked(candidate, 0.012)) return candidate
    }
    return clampPoint(center)
  }

  step(input: AlgorithmStepInput): AlgorithmDecision {
    this.tracker.observe(input)
    if (input.measurement.hit) this.lastHitTime = input.time
    // A first faint contact may occur far downwind. Refinement starts only once
    // the gas-only signal itself provides evidence of a high-concentration core.
    if (
      !this.refining &&
      input.measurement.hit &&
      this.tracker.bestConcentration() >= 0.58
    ) {
      this.beginRefinement(input)
    }

    let phase = this.refining ? 'CONTRACTING SPIRAL' : 'BROAD ZIGZAG ACQUISITION'
    let target: Vec2

    if (this.refining) {
      const refinementSamplesSince = Math.max(0, this.refinementStartedAt - 2)
      if (input.time - this.lastPeakUpdate >= 0.65 || this.peak === null) {
        const nextPeak = this.tracker.peak(0.09, refinementSamplesSince)
        if (nextPeak) {
          const improvement = nextPeak.concentration - this.bestAtCenter
          const meaningfulImprovement = Math.max(0.005, Math.abs(this.bestAtCenter) * 0.07)
          if (
            this.spiralCenter === null ||
            (improvement >= meaningfulImprovement &&
              distance(this.spiralCenter, nextPeak.point) >= 0.008)
          ) {
            this.spiralCenter = copyPoint(nextPeak.point)
            this.bestAtCenter = nextPeak.concentration
            this.spiralRadius = Math.max(0.04, Math.min(this.spiralRadius, 0.11))
          }
          this.peak = nextPeak
          this.peakHistory.push({ time: input.time, point: copyPoint(nextPeak.point) })
          if (this.peakHistory.length > 16) this.peakHistory.shift()
          this.evidence = this.tracker.evidence(nextPeak.point, input.time, 30, 0.04, 0.15)
        }
        this.lastPeakUpdate = input.time
      }

      if (input.time - this.lastHitTime > 18) {
        this.returnToAcquisition(input)
        phase = 'BROAD ZIGZAG REACQUISITION'
      }
    }

    if (this.refining) {
      const center = this.spiralCenter ?? input.position
      this.spiralAngle += input.dt * 1.75
      this.spiralRadius = Math.max(0.018, this.spiralRadius - input.dt * 0.0038)
      target = this.spiralTarget(center)
    } else {
      while (
        this.acquisitionWaypoints.length > 0 &&
        distance(
          input.position,
          this.acquisitionWaypoints[this.acquisitionIndex] ?? input.position,
        ) <= 0.026
      ) {
        this.acquisitionIndex =
          (this.acquisitionIndex + 1) % Math.max(1, this.acquisitionWaypoints.length)
      }
      target = this.acquisitionWaypoints[this.acquisitionIndex] ?? clampPoint(input.position)
    }

    const estimate = this.peak?.point ?? this.tracker.maxEstimate()
    const stability = peakStability(this.peakHistory)
    const stablePeak =
      this.refining &&
      estimate !== null &&
      input.time - this.refinementStartedAt >= 14 &&
      this.spiralRadius <= 0.045 &&
      stability.count >= 8 &&
      stability.span >= 4.8 &&
      stability.radius <= 0.02 &&
      this.evidence.coreCount >= 9 &&
      this.evidence.coreHits >= 5 &&
      this.evidence.ringCount >= 7 &&
      this.evidence.contrast >= 0.1 &&
      input.time - this.lastHitTime <= 4.5 &&
      distance(input.position, estimate) <= 0.09

    this.declarationEvidenceSeconds = stablePeak
      ? this.declarationEvidenceSeconds + input.dt
      : Math.max(0, this.declarationEvidenceSeconds - input.dt * 1.5)
    if (this.declarationEvidenceSeconds >= 3 && estimate) {
      this.terminated = true
      this.terminationReason = `Contracting samples support a stable measured peak (core/ring contrast ${this.evidence.contrast.toFixed(
        2,
      )}).`
      phase = 'STABLE PEAK DECLARED'
    }

    const contractionScore = this.refining ? clamp(1 - this.spiralRadius / 0.13) : 0
    const stabilityScore = clamp(1 - stability.radius / 0.07)
    const evidenceScore = clamp(
      this.evidence.coreHits / 8 + Math.max(0, this.evidence.contrast) * 0.5,
    )
    const confidence = estimate
      ? clamp(
          this.refining
            ? contractionScore * 0.3 + stabilityScore * 0.35 + evidenceScore * 0.35
            : Math.min(0.3, this.tracker.hitCount() * 0.02),
        )
      : 0

    if (this.terminated) {
      return {
        direction: ZERO,
        estimate,
        confidence: Math.max(0.9, confidence),
        phase,
        nativeTerminated: true,
        terminationReason: this.terminationReason,
        debug: {
          target: estimate ?? undefined,
          note: `Gas-only declaration from ${this.evidence.coreCount} core and ${this.evidence.ringCount} surrounding samples.`,
        },
      }
    }

    const desired = { x: target.x - input.position.x, y: target.y - input.position.y }
    const direction = obstacleSafeDirection(this.environment, input.position, desired)
    return {
      direction,
      speedScale: this.refining ? 0.82 : 1,
      estimate,
      confidence,
      phase,
      debug: {
        target: copyPoint(target),
        note: this.refining
          ? `Gas-only steering; spiral radius ${this.spiralRadius.toFixed(
              3,
            )}, peak stability ${stability.radius.toFixed(3)}.`
          : `Gas-only broad zigzag waypoint ${this.acquisitionIndex + 1}/${
              this.acquisitionWaypoints.length
            }; wind is not used.`,
      },
    }
  }
}

export const createCoverageController = () => new CoverageController()
export const createSurgeCastController = () => new SurgeCastController()
export const createZigzagSpiralController = () => new ZigzagSpiralController()

export const REACTIVE_ALGORITHM_FACTORIES: Record<
  ReactiveAlgorithmId,
  () => AlgorithmController
> = {
  coverage: createCoverageController,
  'surge-cast': createSurgeCastController,
  'zigzag-spiral': createZigzagSpiralController,
}

export const createReactiveController = (id: ReactiveAlgorithmId): AlgorithmController =>
  REACTIVE_ALGORITHM_FACTORIES[id]()
