import { percentile } from './math'

/** All signal limits have the units of the supplied gas channel. */
export type BaselinePolicy = {
  flushSeconds: number
  spacingSeconds: number
  maximumGapSeconds: number
  minimumSamples: number
  minimumSpan: number
  maximumSpan: number
  maximumDrift: number
  margin: number
}

type BlankReading = {
  time: number
  value: number
  inReference: boolean
  valid: boolean
  clipped?: boolean
  contaminated?: boolean
}

type Rejection = 'insufficient-blank' | 'contamination-flag' | 'clipping' | 'flat-signal' | 'excessive-range' | 'drifting-blank'
export type FrozenBaseline = Readonly<{
  status: 'ready' | 'rejected'
  reason: Rejection | null
  threshold: number | null
  count: number
  minimum: number | null
  maximum: number | null
  drift: number | null
}>

/** Finish commissioning before search. A gap or an excursion from the known
 * reference restarts the flush and sampling clock. Rejection never means clean air. */
export class BlankBaseline {
  private readonly policy: BaselinePolicy
  private lastTime = -Infinity
  private since: number | null = null
  private lastSampleTime = -Infinity
  private samples: number[] = []
  private minimum = Infinity
  private maximum = -Infinity
  private veto: Rejection | null = null
  private frozen: FrozenBaseline | null = null

  constructor(policy: BaselinePolicy) {
    if (!policy || ![policy.flushSeconds, policy.spacingSeconds, policy.maximumGapSeconds, policy.minimumSamples,
      policy.minimumSpan, policy.maximumSpan, policy.maximumDrift, policy.margin].every(v => Number.isFinite(v) && v >= 0) || policy.spacingSeconds <= 0 ||
        policy.maximumGapSeconds <= 0 || policy.margin <= 0 || !Number.isInteger(policy.minimumSamples) ||
        policy.minimumSamples < 4 || policy.maximumSpan <= policy.minimumSpan) throw new Error('Invalid baseline policy')
    this.policy = { ...policy }
  }

  private restart() {
    this.since = null
    this.lastSampleTime = -Infinity
    this.samples = []
    this.minimum = Infinity
    this.maximum = -Infinity
  }

  observe(r: BlankReading) {
    if (this.frozen) throw new Error('Baseline has been frozen')
    if (!Number.isFinite(r.time) || r.time < this.lastTime) throw new Error('Invalid baseline clock')
    if (r.inReference && (r.clipped || r.contaminated)) this.veto = r.clipped ? 'clipping' : 'contamination-flag'
    if (r.time === this.lastTime) return
    const gap = r.time - this.lastTime
    this.lastTime = r.time
    if (!r.inReference || !r.valid || !Number.isFinite(r.value)) {
      this.restart()
      return
    }
    if (gap > this.policy.maximumGapSeconds) this.restart()
    this.since ??= r.time
    if (r.time - this.since < this.policy.flushSeconds) return
    this.minimum = Math.min(this.minimum, r.value)
    this.maximum = Math.max(this.maximum, r.value)
    if (r.time - this.lastSampleTime >= this.policy.spacingSeconds) {
      this.samples.push(r.value)
      this.lastSampleTime = r.time
    }
  }

  finish(): FrozenBaseline {
    if (this.frozen) return this.frozen
    const count = this.samples.length
    const half = Math.floor(count / 2)
    const drift = half ? Math.abs(percentile(this.samples.slice(-half), 0.5) - percentile(this.samples.slice(0, half), 0.5)) : null
    let reason = this.veto
    if (!reason && count < this.policy.minimumSamples) reason = 'insufficient-blank'
    if (!reason && percentile(this.samples, 1) - percentile(this.samples, 0) < this.policy.minimumSpan) reason = 'flat-signal'
    if (!reason && this.maximum - this.minimum > this.policy.maximumSpan) reason = 'excessive-range'
    if (!reason && drift !== null && drift > this.policy.maximumDrift) reason = 'drifting-blank'
    this.frozen = Object.freeze({ status: reason ? 'rejected' : 'ready', reason,
      threshold: reason ? null : this.maximum + this.policy.margin, count, drift,
      minimum: count ? this.minimum : null, maximum: count ? this.maximum : null })
    return this.frozen
  }
}

/** Null denotes a missing/invalid observation or unavailable calibration. */
export function baselineHit(baseline: FrozenBaseline, value: number, valid: boolean): boolean | null {
  return baseline.status === 'ready' && baseline.threshold !== null && valid && Number.isFinite(value)
    ? value > baseline.threshold : null
}
