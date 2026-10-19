import { DEFAULT_PHYSICS_STEP_SECONDS } from '../config'
import { SeededRandom } from '../rng'
import type { AlgorithmId, BatchResult } from '../types'

/** A two-sided interval with its denominator made explicit for reporting. */
export type ProportionInterval = { estimate: number; low: number; high: number; numerator: number; denominator: number }

export type PairedBinaryResult = {
  pairs: number
  referenceRisk: number
  candidateRisk: number
  /** Candidate minus reference: positive values favour the candidate. */
  riskDifference: number
  /** Null when the reference risk is zero (an estimable finite ratio does not exist). */
  riskRatio: number | null
  referenceOnly: number
  candidateOnly: number
  both: number
  neither: number
  mcnemarExactP: number
}

export type BootstrapInterval = { estimate: number; low: number; high: number; pairs: number; resamples: number; seed: number }

export type DeclarationSummary = {
  runs: number
  falseDeclarationProbability: ProportionInterval
  declarationCoverage: ProportionInterval
  declarationPrecision: ProportionInterval | null
}

export type FixedBudgetDecisionTime = {
  /** Mean correct-declaration time with every other terminal/nonterminal outcome charged the full budget. */
  meanPenalizedSeconds: number
  budgetSeconds: number
  observations: number
  correctDeclarations: number
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

// Acklam's rational approximation; accurate enough for confidence intervals.
const inverseNormal = (p: number) => {
  if (!(p > 0 && p < 1)) throw new RangeError('Normal probability must be in (0, 1)')
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924]
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857]
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878]
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742]
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1) }
  if (p > 0.97575) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1) }
  const q = p - 0.5; const r = q * q
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
}

/** Wilson score interval. Counts must be integers with 0 <= successes <= trials. */
export const wilsonInterval = (successes: number, trials: number, confidence = 0.95): ProportionInterval => {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || successes < 0 || trials < successes || trials < 1) throw new RangeError('Wilson interval requires 0 <= integer successes <= integer trials and trials >= 1')
  if (!(confidence > 0 && confidence < 1)) throw new RangeError('confidence must be in (0, 1)')
  const z = inverseNormal(1 - (1 - confidence) / 2); const z2 = z * z; const p = successes / trials
  const center = (p + z2 / (2 * trials)) / (1 + z2 / trials)
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials) / (1 + z2 / trials)
  return { estimate: p, low: clamp01(center - half), high: clamp01(center + half), numerator: successes, denominator: trials }
}

/** Exact two-sided binomial McNemar p-value, based only on discordant pairs. */
export const exactMcNemarP = (referenceOnly: number, candidateOnly: number) => {
  if (!Number.isInteger(referenceOnly) || !Number.isInteger(candidateOnly) || referenceOnly < 0 || candidateOnly < 0) throw new RangeError('Discordant counts must be non-negative integers')
  const n = referenceOnly + candidateOnly
  if (n === 0) return 1
  const k = Math.min(referenceOnly, candidateOnly)
  let probability = Math.pow(0.5, n) // P(X=0)
  let lower = probability
  for (let i = 0; i < k; i += 1) { probability *= (n - i) / (i + 1); lower += probability }
  return Math.min(1, 2 * lower)
}

/** Analyze aligned boolean outcomes; `true` conventionally means success. */
export const pairedBinary = (reference: readonly boolean[], candidate: readonly boolean[]): PairedBinaryResult => {
  if (reference.length !== candidate.length || reference.length === 0) throw new RangeError('Paired binary analysis requires equal non-empty arrays')
  let both = 0; let neither = 0; let referenceOnly = 0; let candidateOnly = 0
  for (let i = 0; i < reference.length; i += 1) {
    if (reference[i] && candidate[i]) both += 1
    else if (reference[i]) referenceOnly += 1
    else if (candidate[i]) candidateOnly += 1
    else neither += 1
  }
  const referenceRisk = (both + referenceOnly) / reference.length
  const candidateRisk = (both + candidateOnly) / reference.length
  return { pairs: reference.length, referenceRisk, candidateRisk, riskDifference: candidateRisk - referenceRisk, riskRatio: referenceRisk === 0 ? null : candidateRisk / referenceRisk, referenceOnly, candidateOnly, both, neither, mcnemarExactP: exactMcNemarP(referenceOnly, candidateOnly) }
}

const quantile = (values: readonly number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b); const position = (sorted.length - 1) * q; const lo = Math.floor(position); const hi = Math.ceil(position)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (position - lo)
}

/** Percentile bootstrap CI for the mean of paired candidate-reference differences. */
export const bootstrapPairedMeanDifference = (reference: readonly number[], candidate: readonly number[], options: { resamples?: number; seed?: number; confidence?: number } = {}): BootstrapInterval => {
  if (reference.length !== candidate.length || reference.length === 0 || reference.some((x) => !Number.isFinite(x)) || candidate.some((x) => !Number.isFinite(x))) throw new RangeError('Paired bootstrap requires equal non-empty finite arrays')
  const resamples = options.resamples ?? 10_000; const seed = options.seed ?? 0x5eed1234; const confidence = options.confidence ?? 0.95
  if (!Number.isInteger(resamples) || resamples < 1 || !(confidence > 0 && confidence < 1)) throw new RangeError('Invalid bootstrap options')
  const differences = reference.map((x, i) => candidate[i]! - x); const estimate = differences.reduce((a, b) => a + b, 0) / differences.length
  const random = new SeededRandom(seed); const boot: number[] = []
  for (let b = 0; b < resamples; b += 1) { let sum = 0; for (let i = 0; i < differences.length; i += 1) sum += differences[random.integer(0, differences.length)]!; boot.push(sum / differences.length) }
  const alpha = (1 - confidence) / 2
  return { estimate, low: quantile(boot, alpha), high: quantile(boot, 1 - alpha), pairs: differences.length, resamples, seed }
}

/**
 * Deterministic percentile bootstrap CI for the paired success risk difference
 * (candidate success probability minus reference success probability). This
 * resamples whole pairs, so it retains the within-seed dependence ignored by
 * independent-proportions intervals. It is suitable for the benchmark's
 * moderate pair counts; report the seed and resample count with the interval.
 */
export const bootstrapPairedRiskDifference = (
  reference: readonly boolean[],
  candidate: readonly boolean[],
  options: { resamples?: number; seed?: number; confidence?: number } = {},
): BootstrapInterval => bootstrapPairedMeanDifference(reference.map(Number), candidate.map(Number), options)

/** Treats absent/incorrect declarations as no declaration, never as correct abstention. */
export const summarizeDeclarations = (declared: readonly boolean[], falseDeclared: readonly boolean[], confidence = 0.95): DeclarationSummary => {
  if (declared.length !== falseDeclared.length || declared.length === 0) throw new RangeError('Declaration analysis requires equal non-empty arrays')
  let declarations = 0; let falseCount = 0
  for (let i = 0; i < declared.length; i += 1) { if (falseDeclared[i] && !declared[i]) throw new RangeError('A false declaration must also be a declaration'); if (declared[i]) declarations += 1; if (falseDeclared[i]) falseCount += 1 }
  return { runs: declared.length, falseDeclarationProbability: wilsonInterval(falseCount, declared.length, confidence), declarationCoverage: wilsonInterval(declarations, declared.length, confidence), declarationPrecision: declarations ? wilsonInterval(declarations - falseCount, declarations, confidence) : null }
}

/**
 * Fixed-budget decision-time summary. Correct declarations contribute their
 * observed time; wrong declarations, abstentions and nondeclarations contribute
 * the full mission budget. This is deliberately not labelled RMST because those
 * outcomes are competing decisions rather than noninformative censoring.
 */
export const fixedBudgetDecisionTime = (
  eventTimes: readonly (number | null)[],
  budget: number,
): FixedBudgetDecisionTime => {
  if (!(Number.isFinite(budget) && budget > 0) || eventTimes.length === 0) {
    throw new RangeError('Fixed-budget decision time requires a positive finite budget and at least one observation')
  }
  let sum = 0; let events = 0
  for (const time of eventTimes) { if (time !== null && (!Number.isFinite(time) || time < 0)) throw new RangeError('Event times must be finite non-negative numbers or null'); const observed = time !== null && time <= budget; if (observed) events += 1; sum += observed ? time : budget }
  return {
    meanPenalizedSeconds: sum / eventTimes.length,
    budgetSeconds: budget,
    observations: eventTimes.length,
    correctDeclarations: events,
  }
}

/** Holm step-down adjustment. Null p-values are retained and excluded from the family. */
export const holmAdjust = (pValues: readonly (number | null)[]) => {
  const valid = pValues.map((p, index) => ({ p, index })).filter((x): x is { p: number; index: number } => x.p !== null)
  if (valid.some(({ p }) => !Number.isFinite(p) || p < 0 || p > 1)) throw new RangeError('p-values must be in [0, 1] or null')
  valid.sort((a, b) => a.p - b.p); const adjusted: (number | null)[] = pValues.map(() => null); let previous = 0
  valid.forEach(({ p, index }, rank) => { previous = Math.max(previous, Math.min(1, p * (valid.length - rank))); adjusted[index] = previous })
  return adjusted
}

export type PairedBatchResults = {
  pairs: number
  unmatchedReference: number
  unmatchedCandidate: number
  /** Proximity of the current estimate to truth, independent of terminal declaration. */
  success: PairedBinaryResult
  /** Paired percentile-bootstrap CI for candidate minus reference proximity-success risk. */
  successRiskDifference: BootstrapInterval
  normalizedErrorDifference: BootstrapInterval
  referenceDeclarations: DeclarationSummary
  candidateDeclarations: DeclarationSummary
  /** Correct-declaration time with every other outcome charged the full checkpoint budget. */
  referenceCorrectDeclarationDecisionTime: FixedBudgetDecisionTime
  candidateCorrectDeclarationDecisionTime: FixedBudgetDecisionTime
}

export type PairedAbsentSafetyResults = {
  pairs: number
  unmatchedReference: number
  unmatchedCandidate: number
  /** Undesired event; a positive candidate-minus-reference difference is worse. */
  spuriousDeclaration: PairedBinaryResult
  spuriousDeclarationRiskDifference: BootstrapInterval
  /** Desired fixed-budget outcome; a positive difference favours the candidate. */
  correctRejection: PairedBinaryResult
  correctRejectionRiskDifference: BootstrapInterval
  /** Explicit controller decision only; deadline silence is not counted here. */
  correctAbstention: PairedBinaryResult
  correctAbstentionRiskDifference: BootstrapInterval
}

// Deliberately enumerate all simulation fields that can change an outcome.
// `algorithmId` is excluded because it defines the two arms; checkpoint is
// represented separately to make its role obvious. Stable JSON avoids relying
// on caller object property insertion order (notably for placement overrides).
const batchPairKey = (result: BatchResult) => {
  const c = result.config
  return JSON.stringify({
    seed: result.seed,
    checkpointSeconds: result.checkpointSeconds,
    scenarioKind: result.scenarioKind,
    targetStatus: c.targetStatus,
    sourceSeed: c.sourceSeed,
    controllerSeed: c.controllerSeed,
    observationModelSeed: c.observationModelSeed,
    observationModelVersion: result.observationModelVersion,
    sourcePositionOverride: c.sourcePositionOverride ? [c.sourcePositionOverride.x, c.sourcePositionOverride.y] : null,
    robotStartPositionOverride: c.robotStartPositionOverride ? [c.robotStartPositionOverride.x, c.robotStartPositionOverride.y] : null,
    robotStartHeadingDegrees: c.robotStartHeadingDegrees ?? null,
    domainMeters: c.domainMeters,
    durationSeconds: c.durationSeconds,
    fixedDt: c.fixedDt,
    physicsStepSeconds: c.physicsStepSeconds ?? DEFAULT_PHYSICS_STEP_SECONDS,
    robotSpeed: c.robotSpeed,
    sensorProfileId: c.sensorProfileId,
    sensorPpmPerNormalizedUnit: c.sensorPpmPerNormalizedUnit,
    sensorDetectionFloor: c.sensorDetectionFloor,
    sensorNoise: c.sensorNoise,
    sensorLag: c.sensorLag,
    windNoise: c.windNoise,
    sensorThresholdScale: c.sensorThresholdScale,
    sensorSaturation: c.sensorSaturation,
    sensorFalsePositiveRate: c.sensorFalsePositiveRate,
    sensorFalseNegativeRate: c.sensorFalseNegativeRate,
    quadChannelNoiseCorrelation: c.quadChannelNoiseCorrelation,
    quadChannelGainMismatch: c.quadChannelGainMismatch,
    quadChannelCrossTalk: c.quadChannelCrossTalk,
    quadChannelLagMismatch: c.quadChannelLagMismatch,
    activeSniffEnabled: c.activeSniffEnabled,
    activeSniffStrength: c.activeSniffStrength,
    activeSniffReach: c.activeSniffReach,
    activeSniffCycleSeconds: c.activeSniffCycleSeconds,
    physicsMode: c.physicsMode,
    gridResolution: c.gridResolution,
    windDirectionDegrees: c.windDirectionDegrees,
    windSpeedScale: c.windSpeedScale,
    turbulenceScale: c.turbulenceScale,
    gustStrength: c.gustStrength,
    diffusivityScale: c.diffusivityScale,
    emissionRateScale: c.emissionRateScale,
    obstacleComplexityLevel: c.obstacleComplexityLevel,
    terrainSlopeDegrees: c.terrainSlopeDegrees,
    terrainUphillDirectionDegrees: c.terrainUphillDirectionDegrees,
    gasBuoyancy: c.gasBuoyancy,
    terrainGasDriftScale: c.terrainGasDriftScale,
    robotSlopeLimitDegrees: c.robotSlopeLimitDegrees,
    successThreshold: c.successThreshold,
    stopOnNativeDeclaration: c.stopOnNativeDeclaration,
  })
}

/**
 * Pairs two algorithms from raw BatchResult records. Only identical seed/scenario/configuration
 * keys are compared. Duplicate keys are rejected; unmatched records are reported, not silently
 * re-paired. The caller may restrict to one stratum with `include` before comparing.
 */
export const analyzePairedBatchResults = (
  results: readonly BatchResult[],
  referenceAlgorithm: AlgorithmId,
  candidateAlgorithm: AlgorithmId,
  options: { include?: (result: BatchResult) => boolean; bootstrapSeed?: number; bootstrapResamples?: number } = {},
): PairedBatchResults => {
  if (referenceAlgorithm === candidateAlgorithm) throw new RangeError('Reference and candidate algorithms must differ')
  const reference = new Map<string, BatchResult>(); const candidate = new Map<string, BatchResult>()
  for (const result of results) {
    if (options.include && !options.include(result)) continue
    const target = result.algorithmId === referenceAlgorithm ? reference : result.algorithmId === candidateAlgorithm ? candidate : null
    if (!target) continue
    const key = batchPairKey(result)
    if (target.has(key)) throw new RangeError(`Duplicate batch pair key for ${result.algorithmId}: ${key}`)
    target.set(key, result)
  }
  const pairs: Array<[BatchResult, BatchResult]> = []
  for (const [key, left] of reference) { const right = candidate.get(key); if (right) pairs.push([left, right]) }
  if (pairs.length === 0) throw new RangeError('No complete paired BatchResult records were found')
  if (pairs.some(([x, y]) => x.config.targetStatus === 'absent' || y.config.targetStatus === 'absent')) {
    throw new RangeError('Localization-error analysis requires source-present trials; analyze target-absent safety outcomes separately')
  }
  const requireSuccess = (result: BatchResult) => {
    if (result.metrics.success === null) throw new RangeError('Source-present proximity success is missing')
    return result.metrics.success
  }
  const requireError = (result: BatchResult) => {
    if (result.metrics.normalizedError === null) throw new RangeError('Source-present localization error is missing')
    return result.metrics.normalizedError
  }
  const refSuccess = pairs.map(([x]) => requireSuccess(x)); const candidateSuccess = pairs.map(([, x]) => requireSuccess(x))
  const refDeclared = pairs.map(([x]) => x.metrics.nativeDeclaration); const candidateDeclared = pairs.map(([, x]) => x.metrics.nativeDeclaration)
  const refFalse = pairs.map(([x]) => x.metrics.falseDeclarations > 0); const candidateFalse = pairs.map(([, x]) => x.metrics.falseDeclarations > 0)
  const correctTime = (result: BatchResult) => result.metrics.nativeDeclaration && result.metrics.falseDeclarations === 0 ? result.metrics.declarationTimeSeconds : null
  // Checkpoints are part of the pair key, so a shared budget is guaranteed within each pair.
  const budget = pairs[0]![0].checkpointSeconds
  if (!pairs.every(([x, y]) => x.checkpointSeconds === budget && y.checkpointSeconds === budget)) throw new RangeError('Fixed-budget decision time requires a common checkpoint budget; analyze strata separately')
  return {
    pairs: pairs.length,
    unmatchedReference: [...reference.keys()].filter((key) => !candidate.has(key)).length,
    unmatchedCandidate: [...candidate.keys()].filter((key) => !reference.has(key)).length,
    success: pairedBinary(refSuccess, candidateSuccess),
    successRiskDifference: bootstrapPairedRiskDifference(refSuccess, candidateSuccess, { seed: options.bootstrapSeed, resamples: options.bootstrapResamples }),
    normalizedErrorDifference: bootstrapPairedMeanDifference(pairs.map(([x]) => requireError(x)), pairs.map(([, x]) => requireError(x)), { seed: options.bootstrapSeed, resamples: options.bootstrapResamples }),
    referenceDeclarations: summarizeDeclarations(refDeclared, refFalse),
    candidateDeclarations: summarizeDeclarations(candidateDeclared, candidateFalse),
    referenceCorrectDeclarationDecisionTime: fixedBudgetDecisionTime(pairs.map(([x]) => correctTime(x)), budget),
    candidateCorrectDeclarationDecisionTime: fixedBudgetDecisionTime(pairs.map(([, x]) => correctTime(x)), budget),
  }
}

/**
 * Paired no-target safety analysis. Source-present and present-zero-emission
 * records are excluded by construction, and unresolved checkpoints are
 * rejected so deadline silence cannot be prematurely labelled a rejection.
 */
export const analyzePairedAbsentSafetyResults = (
  results: readonly BatchResult[],
  referenceAlgorithm: AlgorithmId,
  candidateAlgorithm: AlgorithmId,
  options: {
    include?: (result: BatchResult) => boolean
    bootstrapSeed?: number
    bootstrapResamples?: number
  } = {},
): PairedAbsentSafetyResults => {
  if (referenceAlgorithm === candidateAlgorithm) {
    throw new RangeError('Reference and candidate algorithms must differ')
  }
  const absentResults = results.filter((result) =>
    result.config.targetStatus === 'absent' && (!options.include || options.include(result)),
  )
  const reference = new Map<string, BatchResult>()
  const candidate = new Map<string, BatchResult>()
  for (const result of absentResults) {
    const target = result.algorithmId === referenceAlgorithm
      ? reference
      : result.algorithmId === candidateAlgorithm
        ? candidate
        : null
    if (!target) continue
    const key = batchPairKey(result)
    if (target.has(key)) {
      throw new RangeError(`Duplicate no-target batch pair key for ${result.algorithmId}: ${key}`)
    }
    target.set(key, result)
  }
  const pairs: Array<[BatchResult, BatchResult]> = []
  for (const [key, left] of reference) {
    const right = candidate.get(key)
    if (right) pairs.push([left, right])
  }
  if (pairs.length === 0) throw new RangeError('No complete paired target-absent records were found')
  if (pairs.some(([left, right]) =>
    left.metrics.correctRejection === null || right.metrics.correctRejection === null)) {
    throw new RangeError('Target-absent safety analysis requires resolved terminal checkpoints')
  }
  const referenceSpurious = pairs.map(([result]) => result.metrics.spuriousDeclaration)
  const candidateSpurious = pairs.map(([, result]) => result.metrics.spuriousDeclaration)
  const referenceRejection = pairs.map(([result]) => result.metrics.correctRejection === true)
  const candidateRejection = pairs.map(([, result]) => result.metrics.correctRejection === true)
  const referenceAbstention = pairs.map(([result]) => result.metrics.correctAbstention)
  const candidateAbstention = pairs.map(([, result]) => result.metrics.correctAbstention)
  const seed = options.bootstrapSeed
  return {
    pairs: pairs.length,
    unmatchedReference: [...reference.keys()].filter((key) => !candidate.has(key)).length,
    unmatchedCandidate: [...candidate.keys()].filter((key) => !reference.has(key)).length,
    spuriousDeclaration: pairedBinary(referenceSpurious, candidateSpurious),
    spuriousDeclarationRiskDifference: bootstrapPairedRiskDifference(
      referenceSpurious,
      candidateSpurious,
      { seed, resamples: options.bootstrapResamples },
    ),
    correctRejection: pairedBinary(referenceRejection, candidateRejection),
    correctRejectionRiskDifference: bootstrapPairedRiskDifference(
      referenceRejection,
      candidateRejection,
      { seed: seed === undefined ? undefined : (seed ^ 0x9e3779b9) >>> 0, resamples: options.bootstrapResamples },
    ),
    correctAbstention: pairedBinary(referenceAbstention, candidateAbstention),
    correctAbstentionRiskDifference: bootstrapPairedRiskDifference(
      referenceAbstention,
      candidateAbstention,
      { seed: seed === undefined ? undefined : (seed ^ 0x4f1bbcdc) >>> 0, resamples: options.bootstrapResamples },
    ),
  }
}
