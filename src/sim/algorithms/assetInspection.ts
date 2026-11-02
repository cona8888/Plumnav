import { add, distance, dot, magnitude, normalize, percentile, scale, sub } from '../math'
import type { AlgorithmController, AlgorithmDecision, AlgorithmEnvironment, AlgorithmStepInput, Vec2 } from '../types'
import { ALGORITHM_METADATA } from './metadata'

type VisitEvidence = {
  stationIndex: number
  arrivedAt: number
  departedAt: number
  sampleCount: number
  hitCount: number
  clippedCount: number
  median: number | null
}
export type StationVisit = VisitEvidence & { pass: 1 | 2 }
export type VerificationVisit = VisitEvidence & { role: 'upwind' | 'crosswind-left' | 'crosswind-right' | 'fitting'; position: Vec2; windAligned: boolean }
export type WindBracket = { offsetNormalized: number; minimumWindNormalizedPerSecond: number }

const minimumWindAlignment = Math.cos(Math.PI / 6)

/** Rank mapped fittings for reinspection. The survey never declares a source. */
export class AssetInspectionController implements AlgorithmController {
  readonly metadata = ALGORITHM_METADATA['asset-inspection']
  private readonly stations: Vec2[]
  private environment!: AlgorithmEnvironment
  private visits: StationVisit[] = []
  private arrivedAt: number | null = null
  private samples: number[] = []
  private hitCount = 0
  private clippedCount = 0
  private lastSampleAt = -Infinity
  private terminal: AlgorithmDecision | null = null
  private nominatedStationIndex: number | null = null
  private windSamples: Vec2[] = []
  private screeningWinds: (Vec2 | null)[] = []
  private challenge: { stationIndex: number; downwind: Vec2; route: Pick<VerificationVisit, 'position' | 'role'>[] } | null = null
  private verificationVisits: VerificationVisit[] = []

  constructor(stations: readonly Vec2[], private readonly threshold: number, private readonly verification?: WindBracket) {
    this.stations = stations.map(p => ({ ...p }))
  }

  reset(environment: AlgorithmEnvironment) {
    if (!environment.inspectionContract || environment.scenario.kind !== 'open' ||
        environment.isBlocked(environment.scenario.robotStart)) throw new Error('Asset inspection requires a reachable start on an open SI site')
    this.environment = environment
    this.visits = []
    this.screeningWinds = []
    this.verificationVisits = []
    this.challenge = null
    this.terminal = null
    this.nominatedStationIndex = null
    this.clearVisit()
  }

  getVisits(): StationVisit[] {
    return this.visits.map(v => ({ ...v }))
  }

  getVerificationVisits(): VerificationVisit[] {
    return this.verificationVisits.map(v => ({ ...v, position: { ...v.position } }))
  }

  /** Index into the public route. A nomination requests follow-up and carries no source declaration. */
  getNominatedStationIndex(): number | null {
    return this.nominatedStationIndex
  }

  private clearVisit() {
    this.arrivedAt = null
    this.samples = []
    this.windSamples = []
    this.hitCount = 0
    this.clippedCount = 0
    this.lastSampleAt = -Infinity
  }

  private supported(v: VisitEvidence) {
    return v.sampleCount >= this.environment.inspectionContract!.minimumSamplesPerWaypoint && v.clippedCount === 0 && v.median !== null
  }

  private distinguishes(high: number, low: number) {
    return high > low && high - low >= 3 * this.environment.sensorNoise
  }

  private passWinner(visits: StationVisit[]) {
    // Censoring at a competitor can change the ranking even if the winner is fully observed.
    if (!visits.every(v => this.supported(v))) return null
    const [first, second] = [...visits].sort((a, b) => b.median! - a.median!)
    if (!first || !second) return null
    return first.hitCount >= this.environment.inspectionContract!.minimumSamplesPerWaypoint &&
      first.median! > this.threshold && this.distinguishes(first.median!, second.median!) ? first.stationIndex : null
  }

  private finish(index: number | null, reason: string): AlgorithmDecision {
    this.nominatedStationIndex = index
    this.terminal = { direction: { x: 0, y: 0 }, estimate: index === null ? null : { ...this.stations[index]! }, confidence: 0,
      phase: index === null ? 'NO FITTING FLAGGED' : 'FITTING FLAGGED FOR REINSPECTION', nativeAbstained: true, terminationReason: reason }
    return this.terminal
  }

  private measuredWind() {
    const floor = this.verification!.minimumWindNormalizedPerSecond
    if (!this.windSamples.length || this.windSamples.some(w => !Number.isFinite(magnitude(w)) || magnitude(w) < floor)) return null
    const directions = this.windSamples.map(w => scale(w, 1 / magnitude(w)))
    const sum = directions.reduce((a, b) => ({ x: a.x + b.x, y: a.y + b.y }), { x: 0, y: 0 })
    if (magnitude(sum) < 1e-9) return null
    const direction = normalize(sum)
    return directions.every(w => dot(w, direction) >= minimumWindAlignment) ? direction : null
  }

  private afterSurvey(input: AlgorithmStepInput, hold: AlgorithmDecision) {
    const first = this.passWinner(this.visits.filter(v => v.pass === 1))
    const second = this.passWinner(this.visits.filter(v => v.pass === 2))
    if (first === null || first !== second) return this.finish(null, 'Two passes yielded insufficient or inconsistent fitting evidence')
    if (!this.verification) return this.finish(first, 'Repeatable enhancement at a mapped fitting warrants reinspection')

    // Orient the control bracket from the latest settled wind measured at the candidate.
    const initialWind = this.screeningWinds[first]
    const downwind = this.screeningWinds[this.stations.length + first]
    if (!downwind || !initialWind || dot(initialWind, downwind) < minimumWindAlignment) {
      return this.finish(null, 'Wind at the screening candidate was too weak or variable')
    }
    const origin = this.stations[first]!
    const offset = this.verification.offsetNormalized
    // Map axes are east and south; the left control is left of an observer looking downwind.
    const left = { x: downwind.y * offset, y: -downwind.x * offset }
    const route: Pick<VerificationVisit, 'position' | 'role'>[] = [
      { role: 'upwind', position: sub(origin, scale(downwind, offset)) },
      { role: 'crosswind-left', position: add(origin, left) },
      { role: 'crosswind-right', position: sub(origin, left) },
      { role: 'fitting', position: origin },
    ]
    if (route.some(waypoint => this.environment.isBlocked(waypoint.position)) ||
        this.stations.some((p, i) => i !== first && distance(p, origin) <= 2 * offset)) {
      return this.finish(null, 'An isolated and accessible wind bracket was unavailable')
    }
    const length = route.reduce((total, waypoint, i) =>
      total + distance(i ? route[i - 1]!.position : input.position, waypoint.position), 0)
    const nominalTime = length / this.environment.maxSpeed + route.length * this.environment.inspectionContract!.dwellSeconds
    if (input.time + nominalTime > this.environment.durationSeconds) return this.finish(null, 'Insufficient time for the complete wind bracket')
    this.challenge = { stationIndex: first, route, downwind }
    return hold
  }

  private completeControl(visit: VerificationVisit, hold: AlgorithmDecision) {
    this.verificationVisits.push(visit)
    if (!this.supported(visit) || !visit.windAligned) {
      return this.finish(null, `Insufficient samples, clipping or wind change at the ${visit.role} position`)
    }
    const screeningLow = Math.min(...this.visits.filter(v => v.stationIndex === visit.stationIndex).map(v => v.median!))
    if (visit.role !== 'fitting') {
      // No later reading can restore the required three-centre contrast when either earlier centre fails it.
      return this.distinguishes(screeningLow, visit.median!) ? hold : this.finish(null,
        `The fitting did not reproducibly exceed the ${visit.role} control`)
    }
    const centreLow = Math.min(visit.median!, screeningLow)
    const clear = visit.hitCount >= this.environment.inspectionContract!.minimumSamplesPerWaypoint &&
      centreLow > this.threshold && this.verificationVisits.slice(0, -1).every(v => this.distinguishes(centreLow, v.median!))
    return clear ? this.finish(visit.stationIndex, 'All three fitting medians exceeded all three settled control medians')
      : this.finish(null, 'The fitting revisit did not reproduce the required control contrasts')
  }

  step(input: AlgorithmStepInput): AlgorithmDecision {
    if (this.terminal) return this.terminal
    const policy = this.environment.inspectionContract!
    const stationIndex = this.challenge?.stationIndex ?? this.visits.length % this.stations.length
    const pass = this.visits.length < this.stations.length ? 1 : 2
    const waypoint = this.challenge?.route[this.verificationVisits.length]
    const target = waypoint?.position ?? this.stations[stationIndex]!
    const remaining = distance(input.position, target)
    const phase = waypoint ? `VERIFY ${waypoint.role.toUpperCase()} FITTING ${stationIndex + 1}` : `PASS ${pass} FITTING ${stationIndex + 1}`
    const hold: AlgorithmDecision = { direction: { x: 0, y: 0 }, estimate: null, confidence: 0,
      phase: `DWELL ${phase}`, debug: { target: { ...target } } }
    if (remaining > policy.arrivalRadiusNormalized) {
      this.clearVisit()
      return { ...hold, direction: normalize(sub(target, input.position)), phase: `TRAVEL ${phase}`,
        speedScale: Math.min(1, remaining / (this.environment.maxSpeed * input.dt)) }
    }
    this.arrivedAt ??= input.time
    const elapsed = input.time - this.arrivedAt
    const m = input.measurement
    // Check the individual clipping flags. The scalar mean alone can hide a saturated inlet.
    if (m.time >= this.arrivedAt + policy.settlingSeconds && m.time <= input.time && m.valid && m.sampleMode === 'passive' && m.localInletReadings?.length === 4 &&
        m.time - this.lastSampleAt >= policy.sampleSpacingSeconds - 1e-9) {
      this.lastSampleAt = m.time
      if (m.localInletReadings.some(r => r.saturated)) {
        this.clippedCount++
      } else {
        this.samples.push(m.concentration)
        if (m.hit && m.concentration > this.threshold) this.hitCount++
        if (this.verification) this.windSamples.push({ ...m.wind })
      }
    }
    if (elapsed + 1e-9 < policy.dwellSeconds) return hold
    const visit = { stationIndex, arrivedAt: this.arrivedAt, departedAt: input.time,
      sampleCount: this.samples.length + this.clippedCount, hitCount: this.hitCount, clippedCount: this.clippedCount,
      median: this.samples.length ? percentile(this.samples, 0.5) : null }
    const wind = this.verification ? this.measuredWind() : null
    const reference = this.challenge?.downwind
    const windAligned = Boolean(wind && reference && this.windSamples.every(w =>
      dot(scale(w, 1 / magnitude(w)), reference) >= minimumWindAlignment))
    this.clearVisit()
    if (this.challenge && waypoint) {
      return this.completeControl({ ...visit, role: waypoint.role, position: { ...input.position }, windAligned }, hold)
    }
    this.visits.push({ ...visit, pass })
    if (this.verification) this.screeningWinds.push(wind)
    return this.visits.length < 2 * this.stations.length ? hold : this.afterSurvey(input, hold)
  }
}
