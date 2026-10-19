import { add, clamp, distance, magnitude, normalize, rotate, scale, sub } from '../math'
import { SeededRandom } from '../rng'
import type {
  AlgorithmController,
  AlgorithmDecision,
  AlgorithmEnvironment,
  AlgorithmStepInput,
  Vec2,
} from '../types'
import { ALGORITHM_METADATA } from './metadata'

type PassiveSample = {
  time: number
  position: Vec2
  concentration: number
  hit: boolean
}

type ProbeLabel = 'upwind' | 'left' | 'downwind' | 'right'

type ProbeDirection = {
  label: ProbeLabel
  direction: Vec2
}

type ProbeReading = ProbeDirection & {
  concentration: number
  returned: boolean
}

type SearchMode = 'search' | 'scan' | 'burst' | 'cast' | 'declared'

const ZERO: Vec2 = { x: 0, y: 0 }
const MAX_PASSIVE_SAMPLES = 1_200
const buildAcquisitionWaypoints = (startNearTop: boolean): Vec2[] => {
  const waypoints: Vec2[] = []
  const columns = 8
  for (let index = 0; index < columns; index += 1) {
    const x = 0.06 + (index / (columns - 1)) * 0.88
    const top = index % 2 === 0 ? startNearTop : !startNearTop
    waypoints.push({ x, y: top ? 0.055 : 0.945 })
  }
  return waypoints
}

const copyPoint = (point: Vec2): Vec2 => ({ x: point.x, y: point.y })

const mean = (values: readonly number[]) =>
  values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0

const safeDirection = (
  environment: AlgorithmEnvironment,
  position: Vec2,
  desired: Vec2,
) => {
  if (magnitude(desired) <= 1e-9) return ZERO
  return normalize(environment.safeDirection(position, desired), ZERO)
}

/**
 * Experimental mammalian active-olfaction controller.
 *
 * The controller only receives tagged, filtered sensor readings. The directional
 * sampling footprint and all plume values used to form an active return remain
 * private to SimulationEngine.
 */
export class PulseSniffController implements AlgorithmController {
  readonly metadata = ALGORITHM_METADATA['pulse-sniff']

  private environment!: AlgorithmEnvironment
  private mode: SearchMode = 'search'
  private passiveSamples: PassiveSample[] = []
  private bestPassive: PassiveSample | null = null
  private estimateHistory: Array<{ time: number; point: Vec2 }> = []
  private lastEstimateHistoryAt = -Infinity
  private lastWind: Vec2 = { x: -1, y: 0 }
  private lastPassiveHit = false
  private lastHitTime = -Infinity
  private everHit = false
  private acquisitionWaypoints: Vec2[] = []
  private acquisitionIndex = 0
  private castSide = 1
  private castTravel = 0
  private castSpan = 0.08
  private refineAngle = 0
  private previousPosition: Vec2 = { x: 0.5, y: 0.5 }
  private previousMotionWasCast = false

  private probeSequence = 0
  private reverseScan = false
  private scanAnchor: Vec2 = { x: 0.5, y: 0.5 }
  private scanBaseline = 0
  private scanStartedAt = -Infinity
  private scanDirections: ProbeDirection[] = []
  private scanReadings: ProbeReading[] = []
  private scanIndex = 0
  private awaitingProbeId: number | null = null
  private probeIssuedAt = -Infinity
  private lastScanAt = -Infinity
  private nextScheduledScan = 1.5
  private verificationAnchors: Vec2[] = []

  private lastGradient: Vec2 = ZERO
  private lastGradientQuality = 0
  private burstDirection: Vec2 = ZERO
  private burstUntil = -Infinity
  private terminated = false
  private terminationReason: string | undefined

  reset(environment: AlgorithmEnvironment) {
    this.environment = environment
    const random = new SeededRandom(environment.controllerSeed ^ 0x5a17_0ff1)
    this.mode = 'search'
    this.passiveSamples = []
    this.bestPassive = null
    this.estimateHistory = []
    this.lastEstimateHistoryAt = -Infinity
    const initialWind = environment.scenario.baseWind
    this.lastWind = magnitude(initialWind) > 1e-9 ? copyPoint(initialWind) : { x: -1, y: 0 }
    this.lastPassiveHit = false
    this.lastHitTime = -Infinity
    this.everHit = false
    this.acquisitionWaypoints = buildAcquisitionWaypoints(
      environment.scenario.robotStart.y <= 0.5,
    )
    this.acquisitionIndex = 0
    this.castSide = random.next() < 0.5 ? -1 : 1
    this.castTravel = 0
    this.castSpan = 0.08
    this.refineAngle = random.range(-Math.PI, Math.PI)
    this.previousPosition = copyPoint(environment.scenario.robotStart)
    this.previousMotionWasCast = false
    this.probeSequence = 0
    this.reverseScan = false
    this.scanAnchor = { x: 0.5, y: 0.5 }
    this.scanBaseline = 0
    this.scanStartedAt = -Infinity
    this.scanDirections = []
    this.scanReadings = []
    this.scanIndex = 0
    this.awaitingProbeId = null
    this.probeIssuedAt = -Infinity
    this.lastScanAt = -Infinity
    this.nextScheduledScan = 1.5
    this.verificationAnchors = []
    this.lastGradient = ZERO
    this.lastGradientQuality = 0
    this.burstDirection = ZERO
    this.burstUntil = -Infinity
    this.terminated = false
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
    if (!this.bestPassive || sample.concentration > this.bestPassive.concentration) {
      this.bestPassive = sample
    }
    if (sample.hit) {
      this.lastHitTime = input.time
      this.everHit = true
    }

    const estimate = this.estimate()
    if (estimate && input.time - this.lastEstimateHistoryAt >= 0.75) {
      this.estimateHistory.push({ time: input.time, point: copyPoint(estimate) })
      if (this.estimateHistory.length > 20) this.estimateHistory.shift()
      this.lastEstimateHistoryAt = input.time
    }
  }

  /** Active-return samples are intentionally excluded from this estimate. */
  private estimate(): Vec2 | null {
    if (!this.bestPassive) return null
    const peak = this.bestPassive
    const nearby = this.passiveSamples.filter(
      (sample) =>
        peak.time - sample.time <= 45 &&
        distance(sample.position, peak.position) <= 0.026 &&
        sample.concentration >= peak.concentration * 0.78,
    )
    if (nearby.length < 3) return copyPoint(peak.position)

    const floor = peak.concentration * 0.72
    let total = 0
    let x = 0
    let y = 0
    for (const sample of nearby) {
      const weight = Math.max(1e-5, sample.concentration - floor) ** 2
      total += weight
      x += sample.position.x * weight
      y += sample.position.y * weight
    }
    return total > 0 ? { x: x / total, y: y / total } : copyPoint(peak.position)
  }

  private upwind() {
    return scale(normalize(this.lastWind, { x: -1, y: 0 }), -1)
  }

  private beginScan(input: AlgorithmStepInput) {
    const upwind = this.upwind()
    const left = rotate(upwind, -Math.PI / 2)
    const canonical: ProbeDirection[] = [
      { label: 'upwind', direction: upwind },
      { label: 'left', direction: left },
      { label: 'downwind', direction: scale(upwind, -1) },
      { label: 'right', direction: scale(left, -1) },
    ]
    this.scanDirections = this.reverseScan
      ? [canonical[0]!, canonical[3]!, canonical[2]!, canonical[1]!]
      : canonical
    this.reverseScan = !this.reverseScan
    this.scanAnchor = copyPoint(input.position)
    this.scanBaseline = input.measurement.concentration
    this.scanStartedAt = input.time
    this.scanReadings = []
    this.scanIndex = 0
    this.awaitingProbeId = null
    this.mode = 'scan'
  }

  private scanCandidates() {
    return this.scanDirections.map((probe) =>
      add(this.scanAnchor, scale(
        probe.direction,
        this.environment.horizontalReachForSurfaceDistance(
          probe.direction,
          this.environment.activeSniffReach,
        ),
      )),
    )
  }

  private issueProbe(input: AlgorithmStepInput): AlgorithmDecision {
    const probe = this.scanDirections[this.scanIndex]
    if (!probe) return this.finishScan(input)
    this.probeSequence += 1
    this.awaitingProbeId = this.probeSequence
    this.probeIssuedAt = input.time
    return {
      direction: ZERO,
      estimate: this.estimate(),
      confidence: this.confidence(input.time),
      phase: `PULSE ${this.scanIndex + 1}/4 · ${probe.label.toUpperCase()}`,
      activeSniff: {
        probeId: this.probeSequence,
        direction: probe.direction,
      },
      debug: {
        candidates: this.scanCandidates(),
        target: add(
          this.scanAnchor,
          scale(
            probe.direction,
            this.environment.horizontalReachForSurfaceDistance(
              probe.direction,
              this.environment.activeSniffReach,
            ),
          ),
        ),
        note: 'Directional air pulse issued; motion pauses before the delayed return sample.',
      },
    }
  }

  private waitForProbe(input: AlgorithmStepInput): AlgorithmDecision {
    const active = input.measurement.activeSniff
    const matchingReturn =
      input.measurement.valid &&
      input.measurement.sampleMode === 'active-return' &&
      active?.probeId === this.awaitingProbeId

    if (matchingReturn) {
      const probe = this.scanDirections[this.scanIndex]
      if (probe) {
        this.scanReadings.push({
          ...probe,
          concentration: input.measurement.concentration,
          returned: true,
        })
      }
      this.scanIndex += 1
      this.awaitingProbeId = null
    } else if (
      input.time - this.probeIssuedAt >= this.environment.activeSniffCycleSeconds
    ) {
      // This path makes the "active sampler disabled" setting a usable sham
      // ablation with the same controller and nominal pause structure.
      const probe = this.scanDirections[this.scanIndex]
      if (probe) {
        this.scanReadings.push({
          ...probe,
          concentration: this.scanBaseline,
          returned: false,
        })
      }
      this.scanIndex += 1
      this.awaitingProbeId = null
    }

    if (this.awaitingProbeId !== null) {
      const phase = input.measurement.activeSniff?.phase
      return {
        direction: ZERO,
        estimate: this.estimate(),
        confidence: this.confidence(input.time),
        phase: phase === 'exhale'
          ? 'EXHALE · SENSOR BLANKED'
          : phase === 'settle'
            ? 'SETTLE · SENSOR BLANKED'
            : 'AWAITING ACTIVE RETURN',
        debug: {
          candidates: this.scanCandidates(),
          note: `Probe ${this.scanIndex + 1}/4; blanked frames are excluded from observations and plume-contact metrics.`,
        },
      }
    }

    return this.scanIndex < this.scanDirections.length
      ? this.issueProbe(input)
      : this.finishScan(input)
  }

  private reading(label: ProbeLabel) {
    return this.scanReadings.find((reading) => reading.label === label)?.concentration
      ?? this.scanBaseline
  }

  private finishScan(input: AlgorithmStepInput): AlgorithmDecision {
    const upwind = this.scanDirections.find((item) => item.label === 'upwind')?.direction
      ?? this.upwind()
    const left = this.scanDirections.find((item) => item.label === 'left')?.direction
      ?? rotate(upwind, -Math.PI / 2)
    const upwindDifference = this.reading('upwind') - this.reading('downwind')
    const lateralDifference = this.reading('left') - this.reading('right')
    const gradient = add(
      scale(upwind, upwindDifference),
      scale(left, lateralDifference),
    )
    const maximum = Math.max(this.scanBaseline, ...this.scanReadings.map((item) => item.concentration))
    const minimum = Math.min(this.scanBaseline, ...this.scanReadings.map((item) => item.concentration))
    const quality = magnitude(gradient) / Math.max(0.03, maximum)
    const contrast = (maximum - minimum) / Math.max(0.03, maximum)
    this.lastGradient = gradient
    this.lastGradientQuality = quality
    this.lastScanAt = input.time
    this.nextScheduledScan = input.time + (maximum >= 0.35 ? 7 : 22)

    const estimate = this.estimate()
    if (
      estimate &&
      this.scanBaseline >= 0.55 &&
      distance(this.scanAnchor, estimate) <= 0.055
    ) {
      const previous = this.verificationAnchors[this.verificationAnchors.length - 1]
      if (!previous || distance(previous, this.scanAnchor) <= 0.045) {
        this.verificationAnchors.push(copyPoint(this.scanAnchor))
      } else {
        this.verificationAnchors = [copyPoint(this.scanAnchor)]
      }
      if (this.verificationAnchors.length > 4) this.verificationAnchors.shift()
    }

    if (this.declarationReady(input.time, input.position)) {
      this.terminated = true
      this.mode = 'declared'
      const evidence = this.passiveEvidence()
      this.terminationReason =
        `Two repeat scans agreed with a stable passive peak; passive core/ring contrast ${evidence.contrast.toFixed(2)}.`
      return this.declaredDecision()
    }

    if (quality >= 0.018 && magnitude(gradient) > 1e-5) {
      // In a transported plume, the robust long-range cue is still upwind.
      // The intervention primarily corrects lateral position; it is not
      // allowed to reverse a coherent upwind track on one noisy scan.
      this.burstDirection = normalize(add(scale(normalize(gradient), 0.42), scale(upwind, 0.86)))
      this.burstUntil = input.time + (maximum >= 0.5 ? 0.9 : 1.45)
      this.mode = 'burst'
    } else {
      this.mode = maximum >= 0.45 ? 'burst' : 'cast'
      this.burstDirection = normalize(add(scale(upwind, 0.52), scale(left, this.castSide * 0.48)))
      this.burstUntil = input.time + 0.9
    }

    const direction = safeDirection(this.environment, input.position, this.burstDirection)
    return {
      direction,
      estimate,
      confidence: this.confidence(input.time),
      phase: quality >= 0.018 ? 'INFORMED BURST' : 'LOW-CONTRAST REACQUISITION',
      debug: {
        candidates: this.scanCandidates(),
        target: add(input.position, scale(direction, 0.08)),
        note: `${this.scanReadings.filter((reading) => reading.returned).length}/4 active returns; directional quality ${quality.toFixed(2)}, range contrast ${contrast.toFixed(2)}.`,
      },
    }
  }

  private passiveEvidence() {
    const estimate = this.estimate()
    if (!estimate) {
      return { coreCount: 0, coreHits: 0, ringCount: 0, coreMean: 0, ringMean: 0, contrast: 0 }
    }
    const newestTime = this.passiveSamples[this.passiveSamples.length - 1]?.time ?? 0
    const recent = this.passiveSamples.filter((sample) => sample.time >= newestTime - 40)
    const core = recent.filter((sample) => distance(sample.position, estimate) <= 0.032)
    const ring = recent.filter((sample) => {
      const radius = distance(sample.position, estimate)
      return radius >= 0.045 && radius <= 0.12
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
    const recent = this.estimateHistory.slice(-8)
    if (recent.length === 0) return { radius: 1, span: 0, count: 0 }
    const center = scale(
      recent.reduce((total, item) => add(total, item.point), ZERO),
      1 / recent.length,
    )
    const radius = Math.sqrt(
      recent.reduce((total, item) => total + distance(item.point, center) ** 2, 0) /
        recent.length,
    )
    return {
      radius,
      span: (recent[recent.length - 1]?.time ?? 0) - (recent[0]?.time ?? 0),
      count: recent.length,
    }
  }

  private declarationReady(time: number, position: Vec2) {
    const estimate = this.estimate()
    const evidence = this.passiveEvidence()
    const stability = this.estimateStability()
    return Boolean(
      estimate &&
      this.verificationAnchors.length >= 2 &&
      (this.bestPassive?.concentration ?? 0) >= 0.68 &&
      evidence.coreCount >= 7 &&
      evidence.coreHits >= 4 &&
      evidence.ringCount >= 5 &&
      evidence.contrast >= 0.08 &&
      stability.count >= 6 &&
      stability.span >= 3.5 &&
      stability.radius <= 0.019 &&
      time - this.lastHitTime <= 4 &&
      distance(position, estimate) <= 0.065,
    )
  }

  private confidence(_time: number) {
    if (!this.bestPassive) return 0
    const evidence = this.passiveEvidence()
    const stability = this.estimateStability()
    const signal = clamp(this.bestPassive.concentration / 0.75)
    const support = clamp((evidence.coreHits + evidence.ringCount * 0.2) / 9)
    const stable = clamp(1 - stability.radius / 0.08)
    const verified = clamp(this.verificationAnchors.length / 2)
    return clamp(signal * 0.28 + support * 0.27 + stable * 0.2 + verified * 0.25)
  }

  private declaredDecision(): AlgorithmDecision {
    const estimate = this.estimate()
    return {
      direction: ZERO,
      estimate,
      confidence: Math.max(0.9, this.confidence(this.lastScanAt)),
      phase: 'PASSIVE PEAK VERIFIED',
      nativeTerminated: true,
      terminationReason: this.terminationReason,
      debug: {
        target: estimate ?? undefined,
        note: 'Active returns guided the search; declaration location and local contrast use passive samples only.',
      },
    }
  }

  private movementDecision(input: AlgorithmStepInput): AlgorithmDecision {
    const estimate = this.estimate()
    const upwind = this.upwind()
    let desired: Vec2
    let phase: string

    if (!this.everHit) {
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
      phase = 'BROAD SERIAL ACQUISITION'
    } else if (this.mode === 'burst' && input.time < this.burstUntil) {
      desired = this.burstDirection
      phase = 'INFORMED BURST'
    } else if (
      estimate &&
      (this.bestPassive?.concentration ?? 0) >= 0.72 &&
      input.time - this.lastHitTime <= 5
    ) {
      this.mode = 'search'
      const toPeak = sub(estimate, input.position)
      if (magnitude(toPeak) > 0.022) {
        desired = add(scale(normalize(toPeak), 0.7), scale(upwind, 0.3))
        phase = 'RETURN TO PASSIVE PEAK'
      } else {
        this.refineAngle += input.dt * 1.45 * this.castSide
        const radius = Math.max(0.018, 0.045 - this.verificationAnchors.length * 0.01)
        const target = add(estimate, {
          x: Math.cos(this.refineAngle) * radius,
          y: Math.sin(this.refineAngle) * radius,
        })
        desired = sub(target, input.position)
        phase = 'SNIFF-LOCKED LOCAL ARC'
      }
    } else if (input.measurement.hit || input.time - this.lastHitTime <= 1) {
      this.mode = 'search'
      desired = magnitude(this.lastGradient) > 1e-5 && this.lastGradientQuality >= 0.018
        ? add(scale(normalize(this.lastGradient), 0.34), scale(upwind, 0.82))
        : upwind
      phase = 'UPWIND TRACK'
    } else {
      this.mode = 'cast'
      const crosswind = rotate(upwind, this.castSide * Math.PI / 2)
      desired = add(scale(upwind, 0.1), scale(crosswind, 0.92))
      phase = this.bestPassive ? 'EXPANDING REACQUISITION CAST' : 'DISCOVERY CAST'
    }

    const direction = safeDirection(this.environment, input.position, desired)
    this.previousMotionWasCast = phase.endsWith('CAST')
    return {
      direction,
      estimate,
      confidence: this.confidence(input.time),
      phase,
      debug: {
        target: add(input.position, scale(direction, 0.09)),
        note: this.bestPassive
          ? `Best passive signal ${(this.bestPassive.concentration).toFixed(2)}; next intervention in ${Math.max(0, this.nextScheduledScan - input.time).toFixed(1)} s.`
          : 'Wide serial casting follows measured wind while searching for the first plume contact.',
      },
    }
  }

  step(input: AlgorithmStepInput): AlgorithmDecision {
    const actualTravel = distance(this.previousPosition, input.position)
    if (this.previousMotionWasCast) {
      this.castTravel += actualTravel
      if (this.castTravel >= this.castSpan) {
        this.castTravel = 0
        this.castSide *= -1
        this.castSpan = Math.min(0.24, this.castSpan + 0.018)
      }
    }
    this.previousPosition = copyPoint(input.position)
    this.previousMotionWasCast = false

    if (magnitude(input.measurement.wind) > 1e-7) this.lastWind = copyPoint(input.measurement.wind)
    if (this.terminated) return this.declaredDecision()

    const hitTransition =
      input.measurement.valid &&
      input.measurement.sampleMode === 'passive' &&
      input.measurement.hit &&
      !this.lastPassiveHit
    const lossTransition =
      input.measurement.valid &&
      input.measurement.sampleMode === 'passive' &&
      !input.measurement.hit &&
      this.lastPassiveHit
    if (hitTransition || lossTransition) {
      this.castTravel = 0
      this.castSpan = hitTransition ? 0.05 : 0.065
      if (lossTransition) this.castSide *= -1
    }
    this.observePassive(input)

    if (this.mode === 'scan') {
      const decision = this.awaitingProbeId === null
        ? this.issueProbe(input)
        : this.waitForProbe(input)
      if (input.measurement.valid && input.measurement.sampleMode === 'passive') {
        this.lastPassiveHit = input.measurement.hit
      }
      return decision
    }

    if (input.measurement.valid && input.measurement.sampleMode === 'passive') {
      const strongSignal = input.measurement.concentration >= 0.42
      const scanDue =
        input.time >= this.nextScheduledScan ||
        (hitTransition && input.time - this.lastScanAt >= 2.25) ||
        (strongSignal && input.time - this.lastScanAt >= 2.5)
      this.lastPassiveHit = input.measurement.hit
      if (scanDue && this.environment.activeSniffEnabled) {
        this.beginScan(input)
        return this.issueProbe(input)
      }
    }

    return this.movementDecision(input)
  }
}

export const createPulseSniffController = () => new PulseSniffController()
