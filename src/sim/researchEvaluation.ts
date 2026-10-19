import type { MetricSnapshot, SimulationConfig, Vec2 } from './types'

/** Offline scoring only. Never pass this truth object to a controller. */
export type LeakTruth = {
  geometricSource: Vec2 | null
  activeEmission: boolean
  /** Determined by independent sensing/coverage validation, never by observed hits. */
  detectability: 'validated-detectable' | 'validated-undetectable' | 'unknown'
}

export type LeakDecision =
  | { kind: 'declare'; timeSeconds: number; estimate: Vec2 | null }
  | { kind: 'no-leak'; timeSeconds: number; evidenceId?: string }
  | { kind: 'none' }

export type LeakOutcome =
  | 'pending' | 'correct-localization' | 'wrong-localization'
  | 'false-leak-declaration' | 'supported-no-leak' | 'false-rejection'
  | 'unresolved-abstention' | 'unresolved-deadline'

export const LEAK_EVALUATION_VERSION = 'active-leak-decision-v1'

/**
 * A no-leak result is conditional on a prevalidated survey/detection contract.
 * An allowlisted evidence ID must identify an independently audited record
 * for THIS survey and a specified detectable source class. An empty list is
 * the conservative default: an existing controller's abstention is unresolved.
 * This scorer verifies identity, not the scientific validity of that record.
 */
export function evaluateLeakDecision(input: {
  truth: LeakTruth
  decision: LeakDecision
  elapsedSeconds: number
  deadlineSeconds: number
  toleranceNormalized: number
  acceptedRejectionEvidenceIds?: readonly string[]
}) {
  const { truth, decision, elapsedSeconds, deadlineSeconds, toleranceNormalized } = input
  if (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0 ||
      !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 ||
      !Number.isFinite(toleranceNormalized) || toleranceNormalized <= 0) {
    throw new RangeError('Invalid decision clock or localization tolerance')
  }
  const validPoint = (p: Vec2) => Number.isFinite(p.x) && Number.isFinite(p.y) &&
    p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1
  if (truth.geometricSource && !validPoint(truth.geometricSource)) {
    throw new RangeError('Source must be a finite point in the unit domain')
  }
  if (truth.activeEmission && !truth.geometricSource) {
    throw new Error('An active leak requires a defined localization target')
  }
  if (decision.kind !== 'none' && (!Number.isFinite(decision.timeSeconds) ||
      decision.timeSeconds < 0 || decision.timeSeconds > Math.min(elapsedSeconds, deadlineSeconds) + 1e-9)) {
    throw new RangeError('Terminal decision must occur inside the observed mission')
  }
  let outcome: LeakOutcome
  let localizationErrorNormalized: number | null = null
  if (decision.kind === 'declare') {
    if (!truth.activeEmission) outcome = 'false-leak-declaration'
    else {
      const estimate = decision.estimate
      localizationErrorNormalized = estimate && validPoint(estimate)
        ? Math.hypot(estimate.x - truth.geometricSource!.x, estimate.y - truth.geometricSource!.y)
        : null
      outcome = localizationErrorNormalized !== null && localizationErrorNormalized <= toleranceNormalized
        ? 'correct-localization' : 'wrong-localization'
    }
  } else if (decision.kind === 'no-leak') {
    const supported = Boolean(decision.evidenceId &&
      input.acceptedRejectionEvidenceIds?.includes(decision.evidenceId))
    outcome = !supported ? 'unresolved-abstention'
      : truth.activeEmission ? 'false-rejection' : 'supported-no-leak'
  } else outcome = elapsedSeconds >= deadlineSeconds - 1e-9 ? 'unresolved-deadline' : 'pending'
  return {
    schemaVersion: LEAK_EVALUATION_VERSION,
    outcome,
    localizationErrorNormalized,
    eventTimeSeconds: decision.kind === 'none' ? null : decision.timeSeconds,
    observedTimeSeconds: decision.kind === 'none'
      ? Math.min(elapsedSeconds, deadlineSeconds) : decision.timeSeconds,
    /** Only a budget end without a decision is administrative censoring. */
    administrativeCensoring: outcome === 'unresolved-deadline',
    /** Wrong declarations and unsupported early stops must not disappear from time analysis. */
    competingEvent: decision.kind !== 'none' && outcome !== 'correct-localization',
    detectability: truth.detectability,
  }
}

/** Retrospective adapter: preserves native metrics; supplies NO rejection certificate. */
export function evaluateArchivedLeakRun(config: SimulationConfig, metrics: MetricSnapshot, source: Vec2 | null) {
  if (metrics.targetStatus !== config.targetStatus) throw new Error('Target-status mismatch')
  if (metrics.nativeDeclaration && metrics.nativeAbstention) throw new Error('Conflicting native decisions')
  const requireTime = (value: number | null) => {
    if (value === null) throw new Error('Missing terminal event time')
    return value
  }
  const decision: LeakDecision = metrics.nativeDeclaration
    ? { kind: 'declare', timeSeconds: requireTime(metrics.declarationTimeSeconds), estimate: metrics.estimate }
    : metrics.nativeAbstention
      ? { kind: 'no-leak', timeSeconds: requireTime(metrics.abstentionTimeSeconds) }
      : { kind: 'none' }
  return evaluateLeakDecision({
    truth: { geometricSource: source,
      activeEmission: config.targetStatus === 'emitting' && config.emissionRateScale > 0,
      detectability: 'unknown' },
    decision, elapsedSeconds: metrics.elapsedSeconds, deadlineSeconds: config.durationSeconds,
    toleranceNormalized: config.successThreshold,
  })
}
