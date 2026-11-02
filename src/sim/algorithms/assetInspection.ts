import { distance, normalize, percentile, sub } from '../math'
import type { AlgorithmController, AlgorithmDecision, AlgorithmEnvironment, AlgorithmStepInput, Vec2 } from '../types'
import { ALGORITHM_METADATA } from './metadata'

export type StationVisit = {
  pass: 1 | 2
  stationIndex: number
  arrivedAt: number
  departedAt: number
  sampleCount: number
  hitCount: number
  clippedCount: number
  median: number | null
}

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

  constructor(stations: readonly Vec2[], private readonly threshold: number) {
    this.stations = stations.map(p => ({ ...p }))
  }

  reset(environment: AlgorithmEnvironment) {
    if (!environment.inspectionContract || environment.scenario.kind !== 'open' ||
        environment.isBlocked(environment.scenario.robotStart)) throw new Error('Asset inspection requires a reachable start on an open SI site')
    this.environment = environment
    this.visits = []
    this.terminal = null
    this.nominatedStationIndex = null
    this.clearVisit()
  }

  getVisits(): StationVisit[] {
    return this.visits.map(v => ({ ...v }))
  }

  /** Index into the public route. A nomination requests follow-up and carries no source declaration. */
  getNominatedStationIndex(): number | null {
    return this.nominatedStationIndex
  }

  private clearVisit() {
    this.arrivedAt = null
    this.samples = []
    this.hitCount = 0
    this.clippedCount = 0
    this.lastSampleAt = -Infinity
  }

  private passWinner(visits: StationVisit[]) {
    const minimum = this.environment.inspectionContract!.minimumSamplesPerWaypoint
    // Censoring at a competitor can change the ranking even if the winner is fully observed.
    if (visits.some(v => v.sampleCount < minimum || v.median === null || v.clippedCount > 0)) return null
    const [first, second] = [...visits].sort((a, b) => b.median! - a.median!)
    if (!first || !second) return null
    const margin = first.median! - second.median!
    return first.hitCount >= minimum && first.median! > this.threshold && margin > 0 && margin >= 3 * this.environment.sensorNoise
      ? first.stationIndex : null
  }

  private finish(): AlgorithmDecision {
    const first = this.passWinner(this.visits.filter(v => v.pass === 1))
    const second = this.passWinner(this.visits.filter(v => v.pass === 2))
    this.nominatedStationIndex = first !== null && first === second ? first : null
    const fitting = this.nominatedStationIndex === null ? null : this.stations[this.nominatedStationIndex]!
    return { direction: { x: 0, y: 0 }, estimate: fitting && { ...fitting }, confidence: 0,
      phase: fitting ? 'FITTING FLAGGED FOR REINSPECTION' : 'NO FITTING FLAGGED',
      nativeAbstained: true,
      terminationReason: fitting ? 'Repeatable enhancement at a mapped fitting warrants reinspection'
        : 'Two passes yielded insufficient or inconsistent fitting evidence' }
  }

  step(input: AlgorithmStepInput): AlgorithmDecision {
    if (this.terminal) return this.terminal
    const policy = this.environment.inspectionContract!
    const stationIndex = this.visits.length % this.stations.length
    const pass = this.visits.length < this.stations.length ? 1 : 2
    const target = this.stations[stationIndex]!
    const remaining = distance(input.position, target)
    const phase = `PASS ${pass} FITTING ${stationIndex + 1}`
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
      }
    }
    if (elapsed + 1e-9 < policy.dwellSeconds) return hold
    this.visits.push({ pass, stationIndex, arrivedAt: this.arrivedAt, departedAt: input.time,
      sampleCount: this.samples.length + this.clippedCount, hitCount: this.hitCount, clippedCount: this.clippedCount,
      median: this.samples.length ? percentile(this.samples, 0.5) : null })
    this.clearVisit()
    if (this.visits.length < 2 * this.stations.length) return hold
    this.terminal = this.finish()
    return this.terminal
  }
}
