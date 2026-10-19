import {
  bootstrapPairedMeanDifference,
  bootstrapPairedRiskDifference,
  fixedBudgetDecisionTime,
  holmAdjust,
  pairedBinary,
  summarizeDeclarations,
  type BootstrapInterval,
  type DeclarationSummary,
  type PairedBinaryResult,
  type FixedBudgetDecisionTime,
} from '../src/sim/stats/pairedBenchmark'
import {
  BENCHMARK_ARMS,
  type BenchmarkArmId,
  type PartitionName,
} from './headless-benchmark'
import type {
  TargetStatus,
  TerminalOutcome,
} from '../src/sim/types'

export type HeadlessResultRow = {
  manifestSha256: string
  partition: PartitionName
  scenarioId: string
  scenario: string
  targetStatus: TargetStatus
  terminalOutcome: TerminalOutcome
  orientationBin: string
  replicate: number
  methodArm: BenchmarkArmId
  seed: number
  sourceSeed: number
  controllerSeed: number
  observationModelSeed: number
  observationModelVersion: string
  sourceX: number
  sourceY: number
  robotStartX: number
  robotStartY: number
  robotStartHeadingDegrees: number
  windDirectionDegrees: number
  physicsMode: string
  gridResolution: number
  physicsStepSeconds: number
  effectivePhysicsStepSeconds: number | null
  quadChannelNoiseCorrelation: number
  quadChannelGainMismatch: number
  quadChannelCrossTalk: number
  quadChannelLagMismatch: number
  checkpointSeconds: number
  success: boolean
  normalizedError: number
  nativeDeclaration: boolean
  declarationTimeSeconds: number | null
  falseDeclarations: number
}

export type HeadlessComparison = {
  partition: PartitionName
  scenario: string
  checkpointSeconds: number
  candidateArm: BenchmarkArmId
  referenceArm: BenchmarkArmId
  pairs: number
  unmatchedCandidate: number
  unmatchedReference: number
  estimateSuccess: PairedBinaryResult
  estimateSuccessRiskDifference: BootstrapInterval
  /** Holm-adjusted exact McNemar p-value for the primary correct-declaration endpoint. */
  correctDeclarationHolmP: number
  correctDeclaration: PairedBinaryResult
  correctDeclarationRiskDifference: BootstrapInterval
  normalizedErrorDifference: BootstrapInterval
  candidateDeclarations: DeclarationSummary
  referenceDeclarations: DeclarationSummary
  candidateCorrectDeclarationDecisionTime: FixedBudgetDecisionTime
  referenceCorrectDeclarationDecisionTime: FixedBudgetDecisionTime
}

export type HeadlessAnalysis = {
  schemaVersion: 'headless-analysis-v3'
  candidateArm: BenchmarkArmId
  includedPartitions: PartitionName[]
  /** Only this prespecified primary checkpoint enters comparisons/Holm; earlier checkpoints are not independent tests. */
  primaryCheckpointRule: 'maximum checkpoint within each partition and scenario'
  primaryEndpoint: 'correct terminal declaration by the primary checkpoint (source-present scenarios only)'
  bootstrapResamples: number
  comparisons: HeadlessComparison[]
}

const REQUIRED_COLUMNS = [
  'manifest_sha256',
  'partition',
  'scenario_id',
  'orientation_bin',
  'replicate',
  'method_arm',
  'seed',
  'source_seed',
  'controller_seed',
  'controller_observation_model_seed',
  'controller_observation_model_version',
  'target_status',
  'source_x_normalized',
  'source_y_normalized',
  'robot_start_x_normalized',
  'robot_start_y_normalized',
  'robot_start_heading_deg',
  'wind_direction_toward_deg',
  'physics_mode',
  'grid_resolution',
  'physics_step_s',
  'effective_physics_step_s',
  'quad_channel_noise_correlation',
  'quad_channel_gain_mismatch',
  'quad_channel_crosstalk',
  'quad_channel_lag_mismatch',
  'scenario',
  'checkpoint_s',
  'terminal_outcome',
  'proximity_success',
  'normalized_error',
  'native_declaration',
  'declaration_time_s',
  'false_declarations',
] as const

const finite = (label: string, value: string) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite, received ${value}`)
  return parsed
}

const binary = (label: string, value: string) => {
  if (value !== '0' && value !== '1') throw new Error(`${label} must be 0 or 1, received ${value}`)
  return value === '1'
}

/** The simulator exporter emits scalar fields without embedded commas. */
export const parseHeadlessResultsCsv = (csv: string): HeadlessResultRow[] => {
  const lines = csv.trim().split(/\r?\n/)
  const header = lines[0]?.split(',') ?? []
  if (new Set(header).size !== header.length) throw new Error('CSV header contains duplicate columns')
  const index = new Map(header.map((column, position) => [column, position]))
  for (const column of REQUIRED_COLUMNS) {
    if (!index.has(column)) throw new Error(`Missing benchmark column: ${column}`)
  }
  const value = (columns: string[], column: typeof REQUIRED_COLUMNS[number]) =>
    columns[index.get(column)!] ?? ''
  return lines.slice(1).filter(Boolean).map((line, rowIndex) => {
    const columns = line.split(',')
    if (columns.length !== header.length) {
      throw new Error(`CSV row ${rowIndex + 2} has ${columns.length} fields; expected ${header.length}`)
    }
    const partition = value(columns, 'partition')
    if (!['development', 'validation', 'test'].includes(partition)) {
      throw new Error(`Invalid partition: ${partition}`)
    }
    const targetStatus = value(columns, 'target_status') as TargetStatus
    if (!['emitting', 'zero-emission', 'absent'].includes(targetStatus)) {
      throw new Error(`Invalid target_status: ${targetStatus}`)
    }
    if (targetStatus === 'absent') {
      throw new Error('The source-present headless analyzer cannot parse target-absent rows; use the safety analysis path')
    }
    const methodArm = value(columns, 'method_arm')
    if (!BENCHMARK_ARMS.some((arm) => arm.id === methodArm)) {
      throw new Error(`Invalid method_arm: ${methodArm}`)
    }
    const terminalOutcome = value(columns, 'terminal_outcome') as TerminalOutcome
    if (![
      'pending',
      'correct-declaration',
      'wrong-declaration',
      'missed-source-abstention',
      'deadline-nondeclaration-present',
    ].includes(terminalOutcome)) {
      throw new Error(`Invalid source-present terminal_outcome: ${terminalOutcome}`)
    }
    const declarationTime = value(columns, 'declaration_time_s')
    const effectivePhysicsStep = value(columns, 'effective_physics_step_s')
    const nativeDeclaration = binary('native_declaration', value(columns, 'native_declaration'))
    const parsedDeclarationTime = declarationTime === ''
      ? null
      : finite('declaration_time_s', declarationTime)
    const replicate = finite('replicate', value(columns, 'replicate'))
    const checkpointSeconds = finite('checkpoint_s', value(columns, 'checkpoint_s'))
    const falseDeclarations = finite('false_declarations', value(columns, 'false_declarations'))
    if (!Number.isInteger(replicate) || replicate < 0) throw new Error(`replicate must be a non-negative integer, received ${replicate}`)
    if (!(checkpointSeconds > 0)) throw new Error(`checkpoint_s must be positive, received ${checkpointSeconds}`)
    if (!Number.isInteger(falseDeclarations) || falseDeclarations < 0) throw new Error(`false_declarations must be a non-negative integer, received ${falseDeclarations}`)
    if (nativeDeclaration !== (parsedDeclarationTime !== null)) throw new Error('native_declaration and declaration_time_s must be present together')
    if (falseDeclarations > 0 && !nativeDeclaration) throw new Error('false_declarations requires native_declaration')
    if (nativeDeclaration !== ['correct-declaration', 'wrong-declaration'].includes(terminalOutcome)) {
      throw new Error('terminal_outcome and native_declaration are inconsistent')
    }
    if (
      (terminalOutcome === 'correct-declaration' && falseDeclarations !== 0) ||
      (terminalOutcome === 'wrong-declaration' && falseDeclarations === 0)
    ) {
      throw new Error('terminal_outcome and false_declarations are inconsistent')
    }
    return {
      manifestSha256: value(columns, 'manifest_sha256'),
      partition: partition as PartitionName,
      scenarioId: value(columns, 'scenario_id'),
      scenario: value(columns, 'scenario'),
      targetStatus,
      terminalOutcome,
      orientationBin: value(columns, 'orientation_bin'),
      replicate,
      methodArm: methodArm as BenchmarkArmId,
      seed: finite('seed', value(columns, 'seed')),
      sourceSeed: finite('source_seed', value(columns, 'source_seed')),
      controllerSeed: finite('controller_seed', value(columns, 'controller_seed')),
      observationModelSeed: finite(
        'controller_observation_model_seed',
        value(columns, 'controller_observation_model_seed'),
      ),
      observationModelVersion: value(columns, 'controller_observation_model_version'),
      sourceX: finite('source_x_normalized', value(columns, 'source_x_normalized')),
      sourceY: finite('source_y_normalized', value(columns, 'source_y_normalized')),
      robotStartX: finite('robot_start_x_normalized', value(columns, 'robot_start_x_normalized')),
      robotStartY: finite('robot_start_y_normalized', value(columns, 'robot_start_y_normalized')),
      robotStartHeadingDegrees: finite('robot_start_heading_deg', value(columns, 'robot_start_heading_deg')),
      windDirectionDegrees: finite('wind_direction_toward_deg', value(columns, 'wind_direction_toward_deg')),
      physicsMode: value(columns, 'physics_mode'),
      gridResolution: finite('grid_resolution', value(columns, 'grid_resolution')),
      physicsStepSeconds: finite('physics_step_s', value(columns, 'physics_step_s')),
      effectivePhysicsStepSeconds: effectivePhysicsStep === ''
        ? null
        : finite('effective_physics_step_s', effectivePhysicsStep),
      quadChannelNoiseCorrelation: finite('quad_channel_noise_correlation', value(columns, 'quad_channel_noise_correlation')),
      quadChannelGainMismatch: finite('quad_channel_gain_mismatch', value(columns, 'quad_channel_gain_mismatch')),
      quadChannelCrossTalk: finite('quad_channel_crosstalk', value(columns, 'quad_channel_crosstalk')),
      quadChannelLagMismatch: finite('quad_channel_lag_mismatch', value(columns, 'quad_channel_lag_mismatch')),
      checkpointSeconds,
      success: binary('proximity_success', value(columns, 'proximity_success')),
      normalizedError: finite('normalized_error', value(columns, 'normalized_error')),
      nativeDeclaration,
      declarationTimeSeconds: parsedDeclarationTime,
      falseDeclarations,
    }
  })
}

const stringSeed = (value: string) => {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

/** Full manifest cell identity: never pair different partitions/layouts/checkpoints. */
const pairKey = (row: HeadlessResultRow) =>
  JSON.stringify([
    row.manifestSha256,
    row.partition,
    row.scenarioId,
    row.targetStatus,
    row.orientationBin,
    row.replicate,
    row.checkpointSeconds,
    row.seed,
    row.sourceSeed,
    row.controllerSeed,
    row.observationModelSeed,
    row.observationModelVersion,
    row.sourceX,
    row.sourceY,
    row.robotStartX,
    row.robotStartY,
    row.robotStartHeadingDegrees,
    row.windDirectionDegrees,
    row.physicsMode,
    row.gridResolution,
    row.physicsStepSeconds,
    row.effectivePhysicsStepSeconds,
    row.quadChannelNoiseCorrelation,
    row.quadChannelGainMismatch,
    row.quadChannelCrossTalk,
    row.quadChannelLagMismatch,
  ])

const correctDeclaration = (row: HeadlessResultRow) =>
  row.terminalOutcome === 'correct-declaration'

const mapByPair = (rows: readonly HeadlessResultRow[], arm: BenchmarkArmId) => {
  const map = new Map<string, HeadlessResultRow>()
  for (const row of rows) {
    if (row.methodArm !== arm) continue
    const key = pairKey(row)
    if (map.has(key)) throw new Error(`Duplicate ${arm} pair key: ${key}`)
    map.set(key, row)
  }
  return map
}

export const analyzeHeadlessRows = (
  rows: readonly HeadlessResultRow[],
  options: {
    candidateArm?: BenchmarkArmId
    referenceArms?: readonly BenchmarkArmId[]
    bootstrapResamples?: number
    /** Confirmatory inference defaults to the untouched test partition only. */
    includePartitions?: readonly PartitionName[]
  } = {},
): HeadlessAnalysis => {
  if (rows.length === 0) throw new Error('No benchmark rows were supplied')
  const includePartitions = options.includePartitions ?? ['test']
  const includedRows = rows.filter((row) => includePartitions.includes(row.partition))
  if (includedRows.length === 0) {
    throw new Error(`No rows were found in the requested partitions: ${includePartitions.join(', ')}`)
  }
  const manifestDigests = new Set(includedRows.map((row) => row.manifestSha256))
  if (manifestDigests.size !== 1 || manifestDigests.has('')) {
    throw new Error('Analysis requires exactly one non-empty manifest SHA-256 digest')
  }
  const candidateArm = options.candidateArm ?? 'quad-active'
  const allArms = [...new Set(includedRows.map((row) => row.methodArm))]
  const referenceArms = options.referenceArms ?? allArms.filter((arm) => arm !== candidateArm)
  const bootstrapResamples = options.bootstrapResamples ?? 10_000
  const strata = new Map<string, HeadlessResultRow[]>()
  for (const row of includedRows) {
    const key = `${row.partition}|${row.scenario}`
    const group = strata.get(key) ?? []
    group.push(row)
    strata.set(key, group)
  }

  const comparisons: HeadlessComparison[] = []
  for (const group of strata.values()) {
    const checkpointSeconds = Math.max(...group.map((row) => row.checkpointSeconds))
    const finalRows = group.filter((row) => row.checkpointSeconds === checkpointSeconds)
    const candidateMap = mapByPair(finalRows, candidateArm)
    if (candidateMap.size === 0) throw new Error(`Candidate arm ${candidateArm} is missing`)
    const groupComparisons: Array<Omit<HeadlessComparison, 'correctDeclarationHolmP'>> = []
    for (const referenceArm of referenceArms) {
      const referenceMap = mapByPair(finalRows, referenceArm)
      if (referenceMap.size === 0) continue
      const pairs: Array<[HeadlessResultRow, HeadlessResultRow]> = []
      for (const [key, candidate] of candidateMap) {
        const reference = referenceMap.get(key)
        if (reference) pairs.push([reference, candidate])
      }
      if (pairs.length === 0) continue
      const referenceSuccess = pairs.map(([reference]) => reference.success)
      const candidateSuccess = pairs.map(([, candidate]) => candidate.success)
      const referenceCorrect = pairs.map(([reference]) => correctDeclaration(reference))
      const candidateCorrect = pairs.map(([, candidate]) => correctDeclaration(candidate))
      const seedBase = stringSeed(
        `${pairs[0]![1].partition}|${pairs[0]![1].scenario}|${candidateArm}|${referenceArm}|${checkpointSeconds}`,
      )
      const declared = (side: 0 | 1) => pairs.map((pair) => pair[side].nativeDeclaration)
      const falseDeclared = (side: 0 | 1) => pairs.map((pair) => pair[side].falseDeclarations > 0)
      const eventTimes = (side: 0 | 1) => pairs.map((pair) => {
        const row = pair[side]
        return correctDeclaration(row) ? row.declarationTimeSeconds : null
      })
      groupComparisons.push({
        partition: pairs[0]![1].partition,
        scenario: pairs[0]![1].scenario,
        checkpointSeconds,
        candidateArm,
        referenceArm,
        pairs: pairs.length,
        unmatchedCandidate: [...candidateMap.keys()].filter((key) => !referenceMap.has(key)).length,
        unmatchedReference: [...referenceMap.keys()].filter((key) => !candidateMap.has(key)).length,
        estimateSuccess: pairedBinary(referenceSuccess, candidateSuccess),
        estimateSuccessRiskDifference: bootstrapPairedRiskDifference(
          referenceSuccess,
          candidateSuccess,
          { seed: seedBase, resamples: bootstrapResamples },
        ),
        correctDeclaration: pairedBinary(referenceCorrect, candidateCorrect),
        correctDeclarationRiskDifference: bootstrapPairedRiskDifference(
          referenceCorrect,
          candidateCorrect,
          { seed: (seedBase ^ 0x4f1bbcdc) >>> 0, resamples: bootstrapResamples },
        ),
        normalizedErrorDifference: bootstrapPairedMeanDifference(
          pairs.map(([reference]) => reference.normalizedError),
          pairs.map(([, candidate]) => candidate.normalizedError),
          { seed: (seedBase ^ 0x9e3779b9) >>> 0, resamples: bootstrapResamples },
        ),
        candidateDeclarations: summarizeDeclarations(declared(1), falseDeclared(1)),
        referenceDeclarations: summarizeDeclarations(declared(0), falseDeclared(0)),
        candidateCorrectDeclarationDecisionTime: fixedBudgetDecisionTime(eventTimes(1), checkpointSeconds),
        referenceCorrectDeclarationDecisionTime: fixedBudgetDecisionTime(eventTimes(0), checkpointSeconds),
      })
    }
    const adjusted = holmAdjust(
      groupComparisons.map((comparison) => comparison.correctDeclaration.mcnemarExactP),
    )
    groupComparisons.forEach((comparison, index) => comparisons.push({
      ...comparison,
      correctDeclarationHolmP: adjusted[index] ?? 1,
    }))
  }

  return {
    schemaVersion: 'headless-analysis-v3',
    candidateArm,
    includedPartitions: [...includePartitions],
    primaryCheckpointRule: 'maximum checkpoint within each partition and scenario',
    primaryEndpoint: 'correct terminal declaration by the primary checkpoint (source-present scenarios only)',
    bootstrapResamples,
    comparisons,
  }
}

export const headlessAnalysisToCsv = (analysis: HeadlessAnalysis) => {
  const header = [
    'partition', 'scenario', 'checkpoint_s', 'candidate_arm', 'reference_arm',
    'pairs', 'unmatched_candidate', 'unmatched_reference',
    'proximity_success_risk_difference', 'proximity_success_risk_difference_ci_low',
    'proximity_success_risk_difference_ci_high', 'proximity_success_risk_ratio',
    'proximity_success_mcnemar_exact_p',
    'correct_declaration_risk_difference',
    'correct_declaration_risk_difference_ci_low',
    'correct_declaration_risk_difference_ci_high',
    'correct_declaration_mcnemar_exact_p',
    'correct_declaration_mcnemar_holm_p',
    'normalized_error_mean_difference', 'normalized_error_ci_low',
    'normalized_error_ci_high', 'candidate_false_declaration_probability',
    'reference_false_declaration_probability',
    'candidate_declaration_coverage', 'reference_declaration_coverage',
    'candidate_correct_declaration_fixed_budget_time_s',
    'reference_correct_declaration_fixed_budget_time_s',
  ]
  const rows = analysis.comparisons.map((comparison) => [
    comparison.partition,
    comparison.scenario,
    comparison.checkpointSeconds,
    comparison.candidateArm,
    comparison.referenceArm,
    comparison.pairs,
    comparison.unmatchedCandidate,
    comparison.unmatchedReference,
    comparison.estimateSuccessRiskDifference.estimate,
    comparison.estimateSuccessRiskDifference.low,
    comparison.estimateSuccessRiskDifference.high,
    comparison.estimateSuccess.riskRatio ?? '',
    comparison.estimateSuccess.mcnemarExactP,
    comparison.correctDeclarationRiskDifference.estimate,
    comparison.correctDeclarationRiskDifference.low,
    comparison.correctDeclarationRiskDifference.high,
    comparison.correctDeclaration.mcnemarExactP,
    comparison.correctDeclarationHolmP,
    comparison.normalizedErrorDifference.estimate,
    comparison.normalizedErrorDifference.low,
    comparison.normalizedErrorDifference.high,
    comparison.candidateDeclarations.falseDeclarationProbability.estimate,
    comparison.referenceDeclarations.falseDeclarationProbability.estimate,
    comparison.candidateDeclarations.declarationCoverage.estimate,
    comparison.referenceDeclarations.declarationCoverage.estimate,
    comparison.candidateCorrectDeclarationDecisionTime.meanPenalizedSeconds,
    comparison.referenceCorrectDeclarationDecisionTime.meanPenalizedSeconds,
  ].join(','))
  return `${header.join(',')}\n${rows.join('\n')}\n`
}
