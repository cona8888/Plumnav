/**
 * Test-only capture for comparator replay evidence.
 *
 * The recorder invokes a controller exactly once per recorded step and copies
 * only already-materialised inputs/outputs. It is outside the production
 * AlgorithmEnvironment and does not inspect truth, call an RNG, or modify a
 * controller decision. Evidence files are emitted only when the runner sets
 * BASELINE_REPLAY_CAPTURE_DIR.
 */
import {
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type {
  AlgorithmController,
  AlgorithmDecision,
  AlgorithmEnvironment,
  AlgorithmStepInput,
} from '../src/sim/types'

export const BASELINE_REPLAY_CAPTURE_SCHEMA_VERSION =
  'gsl-baseline-replay-capture-v1' as const
export const BASELINE_REPLAY_TRACE_SCHEMA_VERSION =
  'gsl-controller-trace-v1' as const
export const BASELINE_REPLAY_SEMANTIC_JSON_VERSION =
  'gsl-semantic-json-v1' as const
export const BASELINE_REPLAY_SUT_OUTPUT_SCHEMA_VERSION =
  'gsl-baseline-replay-sut-output-v1' as const
export const BASELINE_REPLAY_ASSERTIONS_SCHEMA_VERSION =
  'gsl-baseline-replay-assertions-v1' as const
export const BASELINE_REPLAY_DIAGNOSTIC_OUTPUT_SCHEMA_VERSION =
  'gsl-baseline-replay-diagnostic-output-v1' as const
export const BASELINE_REPLAY_REFERENCE_OUTPUT_SCHEMA_VERSION =
  'gsl-baseline-replay-reference-output-v1' as const
export const BASELINE_REPLAY_CAPTURE_BINDING_SCHEMA_VERSION =
  'gsl-baseline-replay-capture-binding-v1' as const
export const BASELINE_REPLAY_EVALUATOR_CASES_SCHEMA_VERSION =
  'gsl-baseline-replay-evaluator-cases-v2' as const
export const BASELINE_REPLAY_HELD_OUT_TRUTH_SCHEMA_VERSION =
  'gsl-held-out-truth-v2' as const
export const BASELINE_REPLAY_STANDALONE_RUN_ID =
  'standalone-direct-unit-capture-v1' as const

export type ReplayAccessLevel = 'black-box' | 'black-box+diagnostic' | 'diagnostic'
export type ReplayAssertionStatus = 'pass' | 'fail' | 'not-executable'
export type ReplayEvidenceTier =
  | 'development-behavior'
  | 'equation-reference'
  | 'canonical-source'

export type ReplayFunctionContract = {
  id: string
  equation?: string
  parameters?: unknown
  sourceReference?: string
}

export type ReplayEnvironmentFunctionContracts = {
  isBlocked: ReplayFunctionContract
  windAt: ReplayFunctionContract
  expectedHitRate: ReplayFunctionContract
  safeDirection: ReplayFunctionContract
  terrainMobilityScale: ReplayFunctionContract
  horizontalReachForSurfaceDistance: ReplayFunctionContract
}

export type ReplayObservationModel = {
  id: string
  usesRng: boolean
  /** Scientific RNG seed; null for a deterministic seedless oracle. */
  seed: number | null
  /** Required controller-interface seed, even when the oracle is seedless. */
  controllerExposedSeed: number
  seedUsed: boolean
  equation?: string
  parameters?: unknown
}

export type ReplayAssertionRecord = {
  id: string
  required: boolean
  accessLevel: ReplayAccessLevel
  status: ReplayAssertionStatus
  comparison: string
  quantity: string | null
  count: number | null
  tolerance: number | null
  maxAbsError: number | null
  maxToleranceRatio: number | null
  referenceRequirement: 'development-spec' | 'equation-reference' | 'canonical-source'
  reasonCode: string | null
  details?: unknown
}

export type ReplayEvaluatorEndpoint = 'primary' | string

export type ReplayEvaluatorCase =
  | {
      caseId: string
      assertionId: 'COM-03'
      role: 'held-out-truth-pair'
      primaryEndpoint: ReplayEvaluatorEndpoint
      peerEndpoint: ReplayEvaluatorEndpoint
      primaryResetOrdinal: number
      peerResetOrdinal: number
      primaryTruthId: string
      peerTruthId: string
    }
  | {
      caseId: string
      assertionId: 'COM-04'
      role: 'fresh-reset-duplicate'
      primaryEndpoint: ReplayEvaluatorEndpoint
      peerEndpoint: ReplayEvaluatorEndpoint
      primaryResetOrdinal: number
      peerResetOrdinal: number
      freshControllerInstances: true
    }
  | {
      caseId: string
      assertionId: 'COM-05'
      role: 'ignored-field-metamorphic'
      primaryEndpoint: ReplayEvaluatorEndpoint
      peerEndpoint: ReplayEvaluatorEndpoint
      primaryResetOrdinal: number
      peerResetOrdinal: number
      ignoredField: 'measured-wind' | 'expectedHitRate'
    }
  | {
      caseId: string
      assertionId: 'COM-06'
      role: 'held-out-terminal-evaluation'
      terminalEndpoint: ReplayEvaluatorEndpoint
      truthId: string
      localizationThreshold: number
    }

export type ReplayHeldOutTruth = {
  truthId: string
  truthClass: 'source-present' | 'source-absent'
  source: { x: number; y: number } | null
  prespecifiedBasis: string
}

type RecorderOptions = {
  fixtureId: string
  algorithmId: string
  accessLevel: ReplayAccessLevel
  controllerSeed: number
  environment: AlgorithmEnvironment
  functionContracts: ReplayEnvironmentFunctionContracts
  observationModel: ReplayObservationModel
  evidenceTier?: ReplayEvidenceTier
  notes?: string[]
}

type NumericCheck = {
  id: string
  actual: number | readonly number[]
  expected: number | readonly number[]
  tolerance: number
  quantity: string
  required?: boolean
  accessLevel?: ReplayAccessLevel
  comparison?: string
  referenceRequirement?: ReplayAssertionRecord['referenceRequirement']
  details?: unknown
}

type NonNumericCheck = {
  id: string
  passed: boolean
  comparison: string
  required?: boolean
  accessLevel?: ReplayAccessLevel
  referenceRequirement?: ReplayAssertionRecord['referenceRequirement']
  details?: unknown
  failureReasonCode?: string
}

type NotExecutableCheck = {
  id: string
  comparison: string
  reasonCode: string
  required?: boolean
  accessLevel?: ReplayAccessLevel
  referenceRequirement?: ReplayAssertionRecord['referenceRequirement']
  quantity?: string
  tolerance?: number
  details?: unknown
}

const compareAscii = (first: string, second: string) =>
  first < second ? -1 : first > second ? 1 : 0

/**
 * Versioned JSON-data canonicalization: finite numbers, -0 -> 0, ASCII-sorted
 * object keys, preserved array order and no implicit undefined/function loss.
 * It is intentionally named rather than presented as full RFC 8785 JCS.
 */
export const canonicalReplayJsonValue = (value: unknown, path = '$'): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers`)
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
        throw new TypeError(`${path}[${index}] is not JSON data`)
      }
      return canonicalReplayJsonValue(item, `${path}[${index}]`)
    })
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => compareAscii(first, second))) {
      // Optional object fields are absent in JSON; never coerce them to null.
      if (item === undefined) continue
      if (typeof item === 'function' || typeof item === 'symbol') {
        throw new TypeError(`${path}.${key} is not JSON data`)
      }
      output[key] = canonicalReplayJsonValue(item, `${path}.${key}`)
    }
    return output
  }
  throw new TypeError(`${path} is not JSON data`)
}

export const stableReplayJson = (value: unknown) =>
  `${JSON.stringify(canonicalReplayJsonValue(value), null, 2)}\n`

const jsonCopy = <T>(value: T): T => canonicalReplayJsonValue(value) as T

const replaySemanticSha256 = (value: unknown) =>
  createHash('sha256').update(stableReplayJson(value), 'utf8').digest('hex')

const resolveReplayRunId = () => {
  const configured = process.env.BASELINE_REPLAY_RUN_ID
  if (configured === undefined) return BASELINE_REPLAY_STANDALONE_RUN_ID
  const normalized = configured.trim()
  if (normalized.length === 0) {
    throw new Error('BASELINE_REPLAY_RUN_ID must not be empty when it is set')
  }
  return normalized
}

/** Null-normalized projection prevents optional decision fields from silently
 * disappearing in a scientific comparison while retaining the raw JSON-data
 * object beside it for implementation provenance. */
export const replayDecisionProjection = (decision: AlgorithmDecision) => jsonCopy({
  direction: decision.direction,
  speedScale: decision.speedScale ?? null,
  estimate: decision.estimate,
  confidence: decision.confidence,
  phase: decision.phase,
  nativeTerminated: decision.nativeTerminated ?? null,
  nativeAbstained: decision.nativeAbstained ?? null,
  terminationReason: decision.terminationReason ?? null,
  activeSniff: decision.activeSniff ?? null,
  quadSniff: decision.quadSniff ?? null,
  debug: decision.debug
    ? {
        target: decision.debug.target ?? null,
        grid: decision.debug.grid ?? null,
        particles: decision.debug.particles ?? null,
        candidates: decision.debug.candidates ?? null,
        note: decision.debug.note ?? null,
      }
    : null,
})

export const replayScientificDecisionProjection = (decision: AlgorithmDecision) => {
  const projection = replayDecisionProjection(decision)
  if (projection.debug) projection.debug.note = null
  return projection
}

const environmentSnapshot = (
  environment: AlgorithmEnvironment,
  functions: ReplayEnvironmentFunctionContracts,
) => {
  const scenario = environment.scenario as AlgorithmEnvironment['scenario'] & {
    source?: unknown
    targetStatus?: unknown
  }
  if ('source' in scenario || 'targetStatus' in scenario) {
    throw new Error('Replay environment snapshot must not contain private source truth')
  }
  return jsonCopy({
    scenario,
    controllerSeed: environment.controllerSeed,
    observationModelVersion: environment.observationModelVersion,
    observationModelSeed: environment.observationModelSeed,
    maxSpeed: environment.maxSpeed,
    activeSniffEnabled: environment.activeSniffEnabled,
    activeSniffCycleSeconds: environment.activeSniffCycleSeconds,
    activeSniffReach: environment.activeSniffReach,
    sensorNoise: environment.sensorNoise,
    functions,
  })
}

const writeAtomicJson = (path: string, value: unknown) => {
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, stableReplayJson(value), 'utf8')
  renameSync(temporaryPath, path)
}

const assertionSummary = (assertions: readonly ReplayAssertionRecord[]) => {
  const required = assertions.filter((assertion) => assertion.required)
  const requiredPass = required.filter((assertion) => assertion.status === 'pass').length
  const requiredFail = required.filter((assertion) => assertion.status === 'fail').length
  const requiredNotExecutable = required.filter(
    (assertion) => assertion.status === 'not-executable',
  ).length
  const fixtureVerdict: ReplayAssertionStatus = requiredFail > 0
    ? 'fail'
    : requiredNotExecutable > 0
      ? 'not-executable'
      : 'pass'
  return { fixtureVerdict, requiredPass, requiredFail, requiredNotExecutable }
}

export class ReplayFixtureRecorder {
  private readonly assertions: ReplayAssertionRecord[] = []
  private readonly assertionIds = new Set<string>()
  private readonly traceSteps: Array<{ sequence: number; label: string; input: AlgorithmStepInput }> = []
  private readonly sutOutputs: Array<{
    sequence: number
    label: string
    decision: ReturnType<typeof replayDecisionProjection>
    scientificDecision: ReturnType<typeof replayScientificDecisionProjection>
    rawDecision: AlgorithmDecision
  }> = []
  private readonly diagnosticOutputs: Array<{ label: string; value: unknown }> = []
  private readonly referenceOutputs: Array<{ label: string; value: unknown }> = []
  private readonly evaluatorCases: ReplayEvaluatorCase[] = []
  private readonly evaluatorCaseIds = new Set<string>()
  private readonly heldOutTruth: ReplayHeldOutTruth[] = []
  private readonly heldOutTruthIds = new Set<string>()
  private readonly subtraces: Array<{
    label: string
    environment: unknown
    cadenceContract: string
    steps: Array<{ sequence: number; label: string; input: AlgorithmStepInput }>
  }> = []
  private readonly subtraceOutputs: Array<{
    label: string
    outputs: Array<{
      sequence: number
      label: string
      decision: ReturnType<typeof replayDecisionProjection>
      scientificDecision: ReturnType<typeof replayScientificDecisionProjection>
      rawDecision: AlgorithmDecision
    }>
  }> = []
  private readonly primaryEnvironment: ReturnType<typeof environmentSnapshot>
  private readonly observationModel: ReplayObservationModel
  private readonly runId: string
  private readonly captureBindingSha256: string
  private finished = false

  constructor(private readonly options: RecorderOptions) {
    if (!/^[CSZIMP][123]$/.test(options.fixtureId)) {
      throw new Error(`Invalid replay fixture id ${options.fixtureId}`)
    }
    if (options.controllerSeed !== options.environment.controllerSeed) {
      throw new Error('Recorder controller seed does not match AlgorithmEnvironment')
    }
    if (
      options.observationModel.controllerExposedSeed !==
      options.environment.observationModelSeed
    ) {
      throw new Error('Recorder observation-model seed does not match AlgorithmEnvironment')
    }
    if (options.observationModel.usesRng && options.observationModel.seed === null) {
      throw new Error('A stochastic observation model requires a scientific RNG seed')
    }
    if (!options.observationModel.usesRng && options.observationModel.seedUsed) {
      throw new Error('A seedless deterministic observation model cannot report seedUsed=true')
    }
    this.primaryEnvironment = environmentSnapshot(options.environment, options.functionContracts)
    this.observationModel = jsonCopy(options.observationModel)
    this.runId = resolveReplayRunId()
    this.captureBindingSha256 = replaySemanticSha256({
      schemaVersion: BASELINE_REPLAY_CAPTURE_BINDING_SCHEMA_VERSION,
      semanticJsonVersion: BASELINE_REPLAY_SEMANTIC_JSON_VERSION,
      fixtureId: options.fixtureId,
      algorithmId: options.algorithmId,
      accessLevel: options.accessLevel,
      evidenceTier: options.evidenceTier ?? 'development-behavior',
      controllerSeed: options.controllerSeed,
      observationModel: this.observationModel,
      environment: this.primaryEnvironment,
    })
  }

  private documentBinding() {
    return {
      runId: this.runId,
      captureBindingSchemaVersion: BASELINE_REPLAY_CAPTURE_BINDING_SCHEMA_VERSION,
      captureBindingSha256: this.captureBindingSha256,
    }
  }

  step<TController extends AlgorithmController>(
    controller: TController,
    input: AlgorithmStepInput,
    label = `step-${this.traceSteps.length + 1}`,
  ) {
    if (this.finished) throw new Error('Cannot record a step after finish()')
    // The controller is invoked exactly once. Copying happens before/after and
    // consumes no controller/environment randomness.
    const decision = controller.step(input)
    this.recordCompletedStep(input, decision, label)
    return decision
  }

  /**
   * Attach an input/output pair already executed by a source-blind fixture
   * harness. This never invokes the controller and is useful when the harness
   * itself also performs paired deterministic/metamorphic replays.
   */
  recordCompletedStep(
    input: AlgorithmStepInput,
    decision: AlgorithmDecision,
    label = `step-${this.traceSteps.length + 1}`,
  ) {
    if (this.finished) throw new Error('Cannot record a completed step after finish()')
    const sequence = this.traceSteps.length + 1
    this.traceSteps.push({ sequence, label, input: jsonCopy(input) })
    this.sutOutputs.push({
      sequence,
      label,
      decision: replayDecisionProjection(decision),
      scientificDecision: replayScientificDecisionProjection(decision),
      rawDecision: jsonCopy(decision),
    })
  }

  /**
   * Materialize a counterfactual/peer subtrace that used a separately reset
   * controller or environment. Keeping the reset environment beside its steps
   * avoids concatenating incompatible seed/oracle streams into one trace.
   */
  recordCompletedTrace(options: {
    label: string
    environment: AlgorithmEnvironment
    functionContracts: ReplayEnvironmentFunctionContracts
    frames: ReadonlyArray<{ input: AlgorithmStepInput; decision: AlgorithmDecision }>
    cadenceContract?: string
  }) {
    if (this.finished) throw new Error('Cannot record a completed trace after finish()')
    if (options.frames.length === 0) throw new Error(`${options.label} contains no replay frames`)
    const steps = options.frames.map((frame, index) => ({
      sequence: index + 1,
      label: `${options.label}-step-${index + 1}`,
      input: jsonCopy(frame.input),
    }))
    const outputs = options.frames.map((frame, index) => ({
      sequence: index + 1,
      label: `${options.label}-step-${index + 1}`,
      decision: replayDecisionProjection(frame.decision),
      scientificDecision: replayScientificDecisionProjection(frame.decision),
      rawDecision: jsonCopy(frame.decision),
    }))
    this.subtraces.push({
      label: options.label,
      environment: environmentSnapshot(options.environment, options.functionContracts),
      cadenceContract: options.cadenceContract ??
        'Each input is the exact value consumed by the separately reset subtrace controller.',
      steps,
    })
    this.subtraceOutputs.push({ label: options.label, outputs })
  }

  diagnostic(label: string, value: unknown) {
    if (this.finished) throw new Error('Cannot record a diagnostic after finish()')
    this.diagnosticOutputs.push({ label, value: jsonCopy(value) })
  }

  reference(label: string, value: unknown) {
    if (this.finished) throw new Error('Cannot record a reference after finish()')
    this.referenceOutputs.push({ label, value: jsonCopy(value) })
  }

  evaluatorCase(record: ReplayEvaluatorCase) {
    if (this.finished) throw new Error('Cannot add an evaluator case after finish()')
    if (this.evaluatorCaseIds.has(record.caseId)) {
      throw new Error(`Duplicate replay evaluator case ${record.caseId}`)
    }
    this.evaluatorCaseIds.add(record.caseId)
    this.evaluatorCases.push(jsonCopy(record))
  }

  heldOutTruthRecord(record: ReplayHeldOutTruth) {
    if (this.finished) throw new Error('Cannot add held-out truth after finish()')
    if (this.heldOutTruthIds.has(record.truthId)) {
      throw new Error(`Duplicate held-out truth id ${record.truthId}`)
    }
    if (
      (record.truthClass === 'source-present' && record.source === null) ||
      (record.truthClass === 'source-absent' && record.source !== null)
    ) {
      throw new Error(`${record.truthId} truth class and source value disagree`)
    }
    this.heldOutTruthIds.add(record.truthId)
    this.heldOutTruth.push(jsonCopy(record))
  }

  numeric(check: NumericCheck) {
    const actual = typeof check.actual === 'number' ? [check.actual] : [...check.actual]
    const expected = typeof check.expected === 'number' ? [check.expected] : [...check.expected]
    if (actual.length === 0 || actual.length !== expected.length) {
      throw new Error(`${check.id} numeric vectors must have the same non-zero length`)
    }
    if (!Number.isFinite(check.tolerance) || check.tolerance < 0) {
      throw new Error(`${check.id} has an invalid numeric tolerance`)
    }
    const errors = actual.map((value, index) => {
      const reference = expected[index]
      if (!Number.isFinite(value) || !Number.isFinite(reference)) {
        throw new Error(`${check.id} compared a non-finite number`)
      }
      return Math.abs(value - reference)
    })
    const maxAbsError = Math.max(...errors)
    const passed = maxAbsError <= check.tolerance
    const maxToleranceRatio = check.tolerance > 0
      ? maxAbsError / check.tolerance
      : maxAbsError === 0
        ? 0
        : null
    this.addAssertion({
      id: check.id,
      required: check.required ?? true,
      accessLevel: check.accessLevel ?? this.options.accessLevel,
      status: passed ? 'pass' : 'fail',
      comparison: check.comparison ?? 'numeric-vector',
      quantity: check.quantity,
      count: actual.length,
      tolerance: check.tolerance,
      maxAbsError,
      maxToleranceRatio,
      referenceRequirement: check.referenceRequirement ?? 'development-spec',
      reasonCode: passed ? null : 'tolerance-exceeded',
      ...(check.details === undefined ? {} : { details: jsonCopy(check.details) }),
    })
  }

  nonNumeric(check: NonNumericCheck) {
    this.addAssertion({
      id: check.id,
      required: check.required ?? true,
      accessLevel: check.accessLevel ?? this.options.accessLevel,
      status: check.passed ? 'pass' : 'fail',
      comparison: check.comparison,
      quantity: null,
      count: 1,
      tolerance: null,
      maxAbsError: null,
      maxToleranceRatio: null,
      referenceRequirement: check.referenceRequirement ?? 'development-spec',
      reasonCode: check.passed ? 'non-numeric-assertion' : (check.failureReasonCode ?? 'boolean-mismatch'),
      ...(check.details === undefined ? {} : { details: jsonCopy(check.details) }),
    })
  }

  notExecutable(check: NotExecutableCheck) {
    if (!check.reasonCode) throw new Error(`${check.id} requires a not-executable reason code`)
    this.addAssertion({
      id: check.id,
      required: check.required ?? true,
      accessLevel: check.accessLevel ?? this.options.accessLevel,
      status: 'not-executable',
      comparison: check.comparison,
      quantity: check.quantity ?? null,
      count: null,
      tolerance: check.tolerance ?? null,
      maxAbsError: null,
      maxToleranceRatio: null,
      referenceRequirement: check.referenceRequirement ?? 'development-spec',
      reasonCode: check.reasonCode,
      ...(check.details === undefined ? {} : { details: jsonCopy(check.details) }),
    })
  }

  private addAssertion(assertion: ReplayAssertionRecord) {
    if (this.finished) throw new Error('Cannot add an assertion after finish()')
    if (this.assertionIds.has(assertion.id)) {
      throw new Error(`Duplicate replay assertion id ${assertion.id}`)
    }
    this.assertionIds.add(assertion.id)
    this.assertions.push(jsonCopy(assertion))
  }

  finish(options: { throwOnFailure?: boolean } = {}) {
    if (this.finished) throw new Error('Replay fixture recorder finished twice')
    this.finished = true
    if (this.assertions.length === 0) throw new Error('Replay fixture recorded no assertions')
    if (this.traceSteps.length === 0) throw new Error('Replay fixture recorded no controller steps')
    const summary = assertionSummary(this.assertions)
    const environment = this.primaryEnvironment
    const heldOutTruthBindingSha256 = this.heldOutTruth.length > 0
      ? replaySemanticSha256({
          schemaVersion: BASELINE_REPLAY_HELD_OUT_TRUTH_SCHEMA_VERSION,
          semanticJsonVersion: BASELINE_REPLAY_SEMANTIC_JSON_VERSION,
          ...this.documentBinding(),
          fixtureId: this.options.fixtureId,
          records: this.heldOutTruth,
          controllerFacingArtifactsExcluded: true,
        })
      : null
    const fixture = {
      schemaVersion: BASELINE_REPLAY_CAPTURE_SCHEMA_VERSION,
      semanticJsonVersion: BASELINE_REPLAY_SEMANTIC_JSON_VERSION,
      ...this.documentBinding(),
      fixtureId: this.options.fixtureId,
      algorithmId: this.options.algorithmId,
      accessLevel: this.options.accessLevel,
      evidenceTier: this.options.evidenceTier ?? 'development-behavior',
      claimLabel: 'development-behavior-only',
      promotionEligible: false,
      controllerSeed: this.options.controllerSeed,
      observationModel: this.observationModel,
      environment,
      notes: [...(this.options.notes ?? [])],
      summary,
    }
    const trace = {
      schemaVersion: BASELINE_REPLAY_TRACE_SCHEMA_VERSION,
      semanticJsonVersion: BASELINE_REPLAY_SEMANTIC_JSON_VERSION,
      ...this.documentBinding(),
      fixtureId: this.options.fixtureId,
      environment,
      cadenceContract:
        'Each recorded input is the exact value passed to step; when a valid current measurement is an observation, it is already present in observations.',
      steps: this.traceSteps,
      subtraces: this.subtraces,
    }
    const captureDirectory = process.env.BASELINE_REPLAY_CAPTURE_DIR
    if (captureDirectory) {
      mkdirSync(captureDirectory, { recursive: true })
      const prefix = join(captureDirectory, this.options.fixtureId)
      writeAtomicJson(`${prefix}.fixture.json`, fixture)
      writeAtomicJson(`${prefix}.trace.json`, trace)
      writeAtomicJson(`${prefix}.sut-output.json`, {
        schemaVersion: BASELINE_REPLAY_SUT_OUTPUT_SCHEMA_VERSION,
        semanticJsonVersion: BASELINE_REPLAY_SEMANTIC_JSON_VERSION,
        ...this.documentBinding(),
        fixtureId: this.options.fixtureId,
        outputs: this.sutOutputs,
        subtraces: this.subtraceOutputs,
      })
      writeAtomicJson(`${prefix}.assertions.json`, {
        schemaVersion: BASELINE_REPLAY_ASSERTIONS_SCHEMA_VERSION,
        semanticJsonVersion: BASELINE_REPLAY_SEMANTIC_JSON_VERSION,
        ...this.documentBinding(),
        fixtureId: this.options.fixtureId,
        assertions: this.assertions,
      })
      if (this.diagnosticOutputs.length > 0) {
        writeAtomicJson(`${prefix}.diagnostic-output.json`, {
          schemaVersion: BASELINE_REPLAY_DIAGNOSTIC_OUTPUT_SCHEMA_VERSION,
          semanticJsonVersion: BASELINE_REPLAY_SEMANTIC_JSON_VERSION,
          ...this.documentBinding(),
          fixtureId: this.options.fixtureId,
          outputs: this.diagnosticOutputs,
        })
      }
      if (this.referenceOutputs.length > 0) {
        writeAtomicJson(`${prefix}.reference-output.json`, {
          schemaVersion: BASELINE_REPLAY_REFERENCE_OUTPUT_SCHEMA_VERSION,
          semanticJsonVersion: BASELINE_REPLAY_SEMANTIC_JSON_VERSION,
          ...this.documentBinding(),
          fixtureId: this.options.fixtureId,
          outputs: this.referenceOutputs,
        })
      }
      if (this.evaluatorCases.length > 0) {
        writeAtomicJson(`${prefix}.evaluator-cases.json`, {
          schemaVersion: BASELINE_REPLAY_EVALUATOR_CASES_SCHEMA_VERSION,
          semanticJsonVersion: BASELINE_REPLAY_SEMANTIC_JSON_VERSION,
          ...this.documentBinding(),
          fixtureId: this.options.fixtureId,
          algorithmId: this.options.algorithmId,
          heldOutTruthBindingSha256,
          cases: this.evaluatorCases,
        })
      }
      if (this.heldOutTruth.length > 0) {
        writeAtomicJson(`${prefix}.held-out-truth.json`, {
          schemaVersion: BASELINE_REPLAY_HELD_OUT_TRUTH_SCHEMA_VERSION,
          semanticJsonVersion: BASELINE_REPLAY_SEMANTIC_JSON_VERSION,
          ...this.documentBinding(),
          fixtureId: this.options.fixtureId,
          heldOutTruthBindingSha256,
          records: this.heldOutTruth,
          controllerFacingArtifactsExcluded: true,
        })
      }
    }
    if ((options.throwOnFailure ?? true) && summary.fixtureVerdict === 'fail') {
      const failed = this.assertions
        .filter((assertion) => assertion.required && assertion.status === 'fail')
        .map((assertion) => assertion.id)
      throw new Error(`Replay fixture ${this.options.fixtureId} failed: ${failed.join(', ')}`)
    }
    return jsonCopy({ fixture, trace, assertions: this.assertions })
  }
}
