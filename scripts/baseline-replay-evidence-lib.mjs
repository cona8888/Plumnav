import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { arch, platform, release, version as operatingSystemVersion } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import {
  evaluateDeclaredReplayCases,
} from './baseline-replay-common-evaluators.mjs'

const execFileAsync = promisify(execFile)

export const BASELINE_REPLAY_RESULT_SCHEMA_VERSION =
  'gsl-baseline-replay-result-v1'
export const BASELINE_REPLAY_INDEX_SCHEMA_VERSION =
  'gsl-baseline-replay-evidence-index-v1'
export const BASELINE_REPLAY_RUNNER_SCHEMA_VERSION =
  'gsl-baseline-replay-runner-v2'
export const BASELINE_REPLAY_CAPTURE_BINDING_SCHEMA_VERSION =
  'gsl-baseline-replay-capture-binding-v1'
export const BASELINE_REPLAY_SEMANTIC_JSON_VERSION =
  'gsl-semantic-json-v1'
export const BASELINE_REPLAY_EVALUATOR_CASES_SCHEMA_VERSIONS = Object.freeze([
  'gsl-baseline-replay-evaluator-cases-v1',
  'gsl-baseline-replay-evaluator-cases-v2',
])
export const BASELINE_REPLAY_HELD_OUT_TRUTH_SCHEMA_VERSIONS = Object.freeze([
  'gsl-held-out-truth-v1',
  'gsl-held-out-truth-v2',
])
export const EXPECTED_BASELINE_REPLAY_FIXTURE_IDS = Object.freeze([
  'C1', 'C2', 'C3',
  'S1', 'S2', 'S3',
  'Z1', 'Z2', 'Z3',
  'I1', 'I2', 'I3',
  'M1', 'M2', 'M3',
  'P1', 'P2', 'P3',
])

export const REQUIRED_CAPTURE_SUFFIXES = Object.freeze([
  'fixture',
  'trace',
  'sut-output',
  'assertions',
])
export const OPTIONAL_CAPTURE_SUFFIXES = Object.freeze([
  'diagnostic-output',
  'reference-output',
  'evaluator-cases',
  'held-out-truth',
])

const compareAscii = (first, second) => first < second ? -1 : first > second ? 1 : 0

export const canonicalizeReplayValue = (value, path = '$') => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`)
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
        throw new TypeError(`${path}[${index}] is not finite JSON data`)
      }
      return canonicalizeReplayValue(item, `${path}[${index}]`)
    })
  }
  if (value && typeof value === 'object') {
    const output = {}
    for (const [key, item] of Object.entries(value).sort(([first], [second]) =>
      compareAscii(first, second))) {
      if (item === undefined) continue
      if (typeof item === 'function' || typeof item === 'symbol') {
        throw new TypeError(`${path}.${key} is not finite JSON data`)
      }
      output[key] = canonicalizeReplayValue(item, `${path}.${key}`)
    }
    return output
  }
  throw new TypeError(`${path} is not finite JSON data`)
}

export const stableReplayJson = (value) =>
  `${JSON.stringify(canonicalizeReplayValue(value), null, 2)}\n`

export const sha256Bytes = (value) => createHash('sha256').update(value).digest('hex')
export const semanticSha256 = (value) => sha256Bytes(stableReplayJson(value))

export const contentSha256 = (value, excludedKeys = ['generatedAtUtc', 'contentSha256']) => {
  const excluded = new Set(excludedKeys)
  const content = Object.fromEntries(
    Object.entries(value).filter(([key]) => !excluded.has(key)),
  )
  return semanticSha256(content)
}

export const validateProtocolCatalog = (protocol) => {
  if (![
    'phase3-baseline-replay-fixture-v3',
    'phase5-baseline-replay-fixture-v4',
  ].includes(protocol.schema_version)) {
    throw new Error(`Unsupported replay protocol schema ${protocol.schema_version}`)
  }
  const fixtures = new Map()
  const assertionIds = new Set()
  for (const algorithm of protocol.fixtures ?? []) {
    for (const trace of algorithm.traces ?? []) {
      if (fixtures.has(trace.id)) throw new Error(`Duplicate protocol fixture ${trace.id}`)
      const assertions = new Map()
      for (const assertion of trace.assertions ?? []) {
        if (assertionIds.has(assertion.id)) {
          throw new Error(`Duplicate protocol assertion ${assertion.id}`)
        }
        assertionIds.add(assertion.id)
        assertions.set(assertion.id, assertion)
      }
      if (assertions.size === 0) throw new Error(`${trace.id} has no protocol assertions`)
      fixtures.set(trace.id, {
        algorithmId: algorithm.algorithm_id,
        honestLabel: algorithm.honest_label,
        promotionBlocker: algorithm.promotion_blocker,
        requiredCanonicalEvidence: algorithm.required_canonical_evidence,
        accessLevel: trace.access,
        description: trace.description,
        assertions,
      })
    }
  }
  const actualFixtureIds = [...fixtures.keys()].sort(compareAscii)
  const expectedFixtureIds = [...EXPECTED_BASELINE_REPLAY_FIXTURE_IDS].sort(compareAscii)
  if (stableReplayJson(actualFixtureIds) !== stableReplayJson(expectedFixtureIds)) {
    throw new Error(
      `Protocol fixture mismatch: expected ${expectedFixtureIds.join(', ')}, got ${actualFixtureIds.join(', ')}`,
    )
  }
  if (assertionIds.size !== 54) {
    throw new Error(`Expected 54 fixture assertions, received ${assertionIds.size}`)
  }
  const commonAssertions = new Map()
  for (const assertion of protocol.common_assertions ?? []) {
    if (assertionIds.has(assertion.id) || commonAssertions.has(assertion.id)) {
      throw new Error(`Duplicate common assertion ${assertion.id}`)
    }
    commonAssertions.set(assertion.id, assertion)
  }
  if (commonAssertions.size !== 6) {
    throw new Error(`Expected 6 common assertions, received ${commonAssertions.size}`)
  }
  return {
    fixtures,
    commonAssertions,
    informationMatrix: protocol.information_matrix ?? {},
  }
}

const sameNullableNumber = (actual, expected) =>
  actual === expected || (actual === null && expected === null)

export const computeFixtureSummary = (assertions) => {
  const required = assertions.filter((assertion) => assertion.required)
  const requiredPass = required.filter((assertion) => assertion.status === 'pass').length
  const requiredFail = required.filter((assertion) => assertion.status === 'fail').length
  const requiredNotExecutable = required.filter(
    (assertion) => assertion.status === 'not-executable',
  ).length
  const fixtureVerdict = requiredFail > 0
    ? 'fail'
    : requiredNotExecutable > 0
      ? 'not-executable'
      : 'pass'
  return { fixtureVerdict, requiredPass, requiredFail, requiredNotExecutable }
}

const requireFiniteNumber = (value, name) => {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`)
}

export const validateFixtureAssertions = (fixtureId, records, specification) => {
  if (!Array.isArray(records)) throw new Error(`${fixtureId} assertions are not an array`)
  const byId = new Map()
  for (const record of records) {
    if (byId.has(record.id)) throw new Error(`${fixtureId} duplicates assertion ${record.id}`)
    byId.set(record.id, record)
  }
  const expectedIds = [...specification.assertions.keys()].sort(compareAscii)
  const actualIds = [...byId.keys()].sort(compareAscii)
  if (stableReplayJson(actualIds) !== stableReplayJson(expectedIds)) {
    throw new Error(
      `${fixtureId} assertion catalogue mismatch: expected ${expectedIds.join(', ')}, got ${actualIds.join(', ')}`,
    )
  }
  for (const assertionId of expectedIds) {
    const record = byId.get(assertionId)
    const expected = specification.assertions.get(assertionId)
    if (record.required !== expected.required) {
      throw new Error(`${assertionId} required flag differs from protocol`)
    }
    if (record.accessLevel !== expected.access) {
      throw new Error(`${assertionId} access ${record.accessLevel} differs from ${expected.access}`)
    }
    if (record.comparison !== expected.comparison) {
      throw new Error(`${assertionId} comparison ${record.comparison} differs from ${expected.comparison}`)
    }
    if (record.quantity !== expected.quantity) {
      throw new Error(`${assertionId} quantity ${record.quantity} differs from ${expected.quantity}`)
    }
    if (!sameNullableNumber(record.tolerance, expected.tolerance)) {
      throw new Error(`${assertionId} tolerance ${record.tolerance} differs from ${expected.tolerance}`)
    }
    if (record.referenceRequirement !== expected.reference_requirement) {
      throw new Error(`${assertionId} reference requirement differs from protocol`)
    }
    if (!['pass', 'fail', 'not-executable'].includes(record.status)) {
      throw new Error(`${assertionId} has invalid status ${record.status}`)
    }
    const numeric = expected.tolerance !== null && record.status !== 'not-executable'
    if (numeric) {
      if (!Number.isInteger(record.count) || record.count <= 0) {
        throw new Error(`${assertionId} numeric count must be a positive integer`)
      }
      requireFiniteNumber(record.maxAbsError, `${assertionId} maxAbsError`)
      if (expected.tolerance > 0) {
        requireFiniteNumber(record.maxToleranceRatio, `${assertionId} maxToleranceRatio`)
      } else if (record.maxToleranceRatio !== 0 && record.maxToleranceRatio !== null) {
        throw new Error(`${assertionId} zero-tolerance ratio must be zero or null`)
      }
      const numericallyPassed = record.maxAbsError <= expected.tolerance
      if ((record.status === 'pass') !== numericallyPassed) {
        throw new Error(`${assertionId} status contradicts its exported numeric error`)
      }
    } else if (record.status === 'not-executable') {
      if (!record.reasonCode) throw new Error(`${assertionId} not-executable lacks a reason`)
      if (record.count !== null || record.maxAbsError !== null || record.maxToleranceRatio !== null) {
        throw new Error(`${assertionId} not-executable must not report executed errors`)
      }
    } else {
      if (!Number.isInteger(record.count) || record.count <= 0) {
        throw new Error(`${assertionId} non-numeric assertion must report its comparison count`)
      }
      if (record.maxAbsError !== null || record.maxToleranceRatio !== null) {
        throw new Error(`${assertionId} non-numeric assertion has a numeric error`)
      }
    }
  }
  return computeFixtureSummary(records)
}

export const loadCanonicalJsonArtifact = async (path) => {
  const bytes = await readFile(path)
  const text = bytes.toString('utf8')
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`)
  }
  const semanticBytes = stableReplayJson(data)
  if (text !== semanticBytes) {
    throw new Error(`${path} does not use gsl-semantic-json-v1 canonical bytes`)
  }
  return {
    sourcePath: path,
    bytes,
    fileSha256: sha256Bytes(bytes),
    semanticSha256: sha256Bytes(semanticBytes),
    byteLength: bytes.byteLength,
    data,
  }
}

/**
 * Phase 5 v2 binds each explicit evaluator-case manifest to the exact
 * evaluator-only truth content it uses. V1 remains readable solely so the
 * first immutable Phase 5 archive generation can still be verified.
 */
export const validateHeldOutTruthBinding = ({ fixtureId, evaluatorCases, heldOutTruth }) => {
  const evaluatorIsV2 = evaluatorCases?.schemaVersion ===
    'gsl-baseline-replay-evaluator-cases-v2'
  const truthIsV2 = heldOutTruth?.schemaVersion === 'gsl-held-out-truth-v2'
  if (evaluatorIsV2 !== truthIsV2) {
    throw new Error(`${fixtureId} evaluator cases and held-out truth use mixed binding schemas`)
  }
  if (!evaluatorIsV2) return null
  if (heldOutTruth === null || evaluatorCases === null) {
    throw new Error(`${fixtureId} v2 evaluator/truth binding requires both artifacts`)
  }
  const expected = semanticSha256({
    schemaVersion: heldOutTruth.schemaVersion,
    semanticJsonVersion: heldOutTruth.semanticJsonVersion,
    runId: heldOutTruth.runId,
    captureBindingSchemaVersion: heldOutTruth.captureBindingSchemaVersion,
    captureBindingSha256: heldOutTruth.captureBindingSha256,
    fixtureId: heldOutTruth.fixtureId,
    records: heldOutTruth.records,
    controllerFacingArtifactsExcluded: heldOutTruth.controllerFacingArtifactsExcluded,
  })
  if (heldOutTruth.heldOutTruthBindingSha256 !== expected) {
    throw new Error(`${fixtureId} held-out truth binding digest does not match its content`)
  }
  if (evaluatorCases.heldOutTruthBindingSha256 !== expected) {
    throw new Error(`${fixtureId} evaluator cases are not bound to the held-out truth content`)
  }
  return expected
}

const artifactDescriptor = (artifact, archivePath) => ({
  path: archivePath,
  fileSha256: artifact.fileSha256,
  semanticSha256: artifact.semanticSha256,
  byteLength: artifact.byteLength,
})

const countTraceSteps = (trace) =>
  (trace.steps?.length ?? 0) +
  (trace.subtraces ?? []).reduce((sum, subtrace) => sum + (subtrace.steps?.length ?? 0), 0)

const countOutputSteps = (output) =>
  (output.outputs?.length ?? 0) +
  (output.subtraces ?? []).reduce((sum, subtrace) => sum + (subtrace.outputs?.length ?? 0), 0)

export const loadCapturedFixture = async ({ captureDirectory, fixtureId, specification }) => {
  const artifacts = {}
  for (const suffix of REQUIRED_CAPTURE_SUFFIXES) {
    artifacts[suffix] = await loadCanonicalJsonArtifact(
      join(captureDirectory, `${fixtureId}.${suffix}.json`),
    )
  }
  for (const suffix of OPTIONAL_CAPTURE_SUFFIXES) {
    try {
      artifacts[suffix] = await loadCanonicalJsonArtifact(
        join(captureDirectory, `${fixtureId}.${suffix}.json`),
      )
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      artifacts[suffix] = null
    }
  }

  const fixture = artifacts.fixture.data
  const expectedSchemas = {
    fixture: ['gsl-baseline-replay-capture-v1'],
    trace: ['gsl-controller-trace-v1'],
    'sut-output': ['gsl-baseline-replay-sut-output-v1'],
    assertions: ['gsl-baseline-replay-assertions-v1'],
    'diagnostic-output': ['gsl-baseline-replay-diagnostic-output-v1'],
    'reference-output': ['gsl-baseline-replay-reference-output-v1'],
    'evaluator-cases': BASELINE_REPLAY_EVALUATOR_CASES_SCHEMA_VERSIONS,
    'held-out-truth': BASELINE_REPLAY_HELD_OUT_TRUTH_SCHEMA_VERSIONS,
  }
  for (const [suffix, artifact] of Object.entries(artifacts)) {
    if (artifact === null) continue
    if (!expectedSchemas[suffix].includes(artifact.data.schemaVersion)) {
      throw new Error(`${fixtureId} ${suffix} schema ${artifact.data.schemaVersion} is unsupported`)
    }
    if (artifact.data.semanticJsonVersion !== BASELINE_REPLAY_SEMANTIC_JSON_VERSION) {
      throw new Error(`${fixtureId} ${suffix} semantic JSON version is unsupported`)
    }
  }
  if (fixture.fixtureId !== fixtureId || fixture.algorithmId !== specification.algorithmId) {
    throw new Error(`${fixtureId} fixture metadata does not match the protocol catalogue`)
  }
  if (fixture.accessLevel !== specification.accessLevel) {
    throw new Error(`${fixtureId} fixture access level differs from the protocol`)
  }
  if (fixture.evidenceTier !== 'development-behavior' ||
      fixture.claimLabel !== 'development-behavior-only' ||
      fixture.promotionEligible !== false) {
    throw new Error(`${fixtureId} attempted to exceed development evidence tier`)
  }
  const binding = {
    runId: fixture.runId,
    captureBindingSchemaVersion: fixture.captureBindingSchemaVersion,
    captureBindingSha256: fixture.captureBindingSha256,
  }
  if (typeof binding.runId !== 'string' || binding.runId.trim() === '' ||
      binding.captureBindingSchemaVersion !== BASELINE_REPLAY_CAPTURE_BINDING_SCHEMA_VERSION) {
    throw new Error(`${fixtureId} has an invalid capture binding identity`)
  }
  const expectedBindingSha256 = semanticSha256({
    schemaVersion: BASELINE_REPLAY_CAPTURE_BINDING_SCHEMA_VERSION,
    semanticJsonVersion: BASELINE_REPLAY_SEMANTIC_JSON_VERSION,
    fixtureId,
    algorithmId: fixture.algorithmId,
    accessLevel: fixture.accessLevel,
    evidenceTier: fixture.evidenceTier,
    controllerSeed: fixture.controllerSeed,
    observationModel: fixture.observationModel,
    environment: fixture.environment,
  })
  if (binding.captureBindingSha256 !== expectedBindingSha256) {
    throw new Error(`${fixtureId} capture binding digest does not match immutable identity`)
  }
  for (const [suffix, artifact] of Object.entries(artifacts)) {
    if (artifact === null) continue
    for (const [field, expected] of Object.entries(binding)) {
      if (artifact.data[field] !== expected) {
        throw new Error(`${fixtureId} ${suffix} differs on capture binding ${field}`)
      }
    }
    if (artifact.data.fixtureId !== fixtureId) {
      throw new Error(`${fixtureId} ${suffix} artifact identity mismatch`)
    }
  }
  const trace = artifacts.trace.data
  const output = artifacts['sut-output'].data
  const assertionDocument = artifacts.assertions.data
  if (trace.fixtureId !== fixtureId || output.fixtureId !== fixtureId ||
      assertionDocument.fixtureId !== fixtureId) {
    throw new Error(`${fixtureId} artifact identity mismatch`)
  }
  if (!exactJsonEqual(trace.environment, fixture.environment)) {
    throw new Error(`${fixtureId} trace environment differs from the bound fixture environment`)
  }
  const validateStepAlignment = (tracePart, outputPart, label) => {
    const steps = tracePart ?? []
    const outputs = outputPart ?? []
    if (steps.length !== outputs.length) {
      throw new Error(`${fixtureId} ${label} step/output cardinality differs`)
    }
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      const decision = outputs[index]
      if (step.sequence !== index + 1 || decision.sequence !== index + 1 ||
          step.sequence !== decision.sequence || step.label !== decision.label) {
        throw new Error(`${fixtureId} ${label} sequence/label alignment failed at ${index + 1}`)
      }
    }
  }
  validateStepAlignment(trace.steps, output.outputs, 'primary trace')
  const traceSubtraces = trace.subtraces ?? []
  const outputSubtraces = output.subtraces ?? []
  if (traceSubtraces.length !== outputSubtraces.length) {
    throw new Error(`${fixtureId} subtrace cardinality differs`)
  }
  for (let index = 0; index < traceSubtraces.length; index += 1) {
    const traceSubtrace = traceSubtraces[index]
    const outputSubtrace = outputSubtraces[index]
    if (traceSubtrace.label !== outputSubtrace.label) {
      throw new Error(`${fixtureId} subtrace label alignment failed at ${index + 1}`)
    }
    validateStepAlignment(
      traceSubtrace.steps,
      outputSubtrace.outputs,
      `subtrace ${traceSubtrace.label}`,
    )
  }
  const traceSteps = countTraceSteps(trace)
  const outputSteps = countOutputSteps(output)
  if (traceSteps <= 0 || traceSteps !== outputSteps) {
    throw new Error(`${fixtureId} trace/output step counts differ (${traceSteps}/${outputSteps})`)
  }
  if (trace.environment?.controllerSeed !== fixture.controllerSeed) {
    throw new Error(`${fixtureId} controller seed differs between fixture and trace`)
  }
  if (trace.environment?.observationModelSeed !==
      fixture.observationModel?.controllerExposedSeed) {
    throw new Error(`${fixtureId} observation-model seed differs between fixture and trace`)
  }
  const summary = validateFixtureAssertions(
    fixtureId,
    assertionDocument.assertions,
    specification,
  )
  if (stableReplayJson(summary) !== stableReplayJson(fixture.summary)) {
    throw new Error(`${fixtureId} stored summary does not match assertion verdicts`)
  }
  const executedDiagnostic = assertionDocument.assertions.some((assertion) =>
    assertion.accessLevel.includes('diagnostic') && assertion.status !== 'not-executable')
  if (executedDiagnostic && artifacts['diagnostic-output'] === null) {
    throw new Error(`${fixtureId} executed diagnostic assertions without diagnostic output`)
  }
  if (artifacts['diagnostic-output'] !== null &&
      !Array.isArray(artifacts['diagnostic-output'].data.outputs)) {
    throw new Error(`${fixtureId} diagnostic output document is malformed`)
  }
  if (artifacts['reference-output'] !== null &&
      (!Array.isArray(artifacts['reference-output'].data.outputs) ||
       artifacts['reference-output'].data.outputs.length === 0)) {
    throw new Error(`${fixtureId} reference output document is empty or malformed`)
  }
  if (artifacts['evaluator-cases'] !== null &&
      (!Array.isArray(artifacts['evaluator-cases'].data.cases) ||
       artifacts['evaluator-cases'].data.algorithmId !== fixture.algorithmId)) {
    throw new Error(`${fixtureId} evaluator case document is malformed`)
  }
  if (artifacts['held-out-truth'] !== null &&
      (!Array.isArray(artifacts['held-out-truth'].data.records) ||
       artifacts['held-out-truth'].data.controllerFacingArtifactsExcluded !== true)) {
    throw new Error(`${fixtureId} held-out truth document is malformed`)
  }
  validateHeldOutTruthBinding({
    fixtureId,
    evaluatorCases: artifacts['evaluator-cases']?.data ?? null,
    heldOutTruth: artifacts['held-out-truth']?.data ?? null,
  })
  return {
    fixtureId,
    runId: binding.runId,
    specification,
    fixture,
    trace,
    output,
    evaluatorCases: artifacts['evaluator-cases']?.data ?? null,
    heldOutTruth: artifacts['held-out-truth']?.data ?? null,
    assertions: assertionDocument.assertions,
    summary,
    artifacts,
    traceSteps,
    artifactDescriptors: Object.fromEntries(
      Object.entries(artifacts)
        .filter(([, artifact]) => artifact !== null)
        .map(([suffix, artifact]) => [
          suffix,
          artifactDescriptor(artifact, `artifacts/${fixtureId}.${suffix}.json`),
        ]),
    ),
  }
}

export const validateVitestFixtureReport = (report) => {
  if (report?.success !== true) {
    throw new Error('Replay Vitest report does not record a successful run')
  }
  const expectedSuites = new Set([
    'scripts/baseline-replay-reactive.test.ts',
    'scripts/baseline-replay-bayesian.test.ts',
  ])
  const actualSuites = new Set()
  for (const suite of report.testResults ?? []) {
    const normalizedName = String(suite.name ?? '').replaceAll('\\', '/')
    const matchingSuite = [...expectedSuites].find((expected) =>
      normalizedName === expected || normalizedName.endsWith(`/${expected}`))
    if (!matchingSuite) throw new Error(`Unexpected replay test suite ${suite.name}`)
    if (actualSuites.has(matchingSuite)) {
      throw new Error(`Replay report duplicates suite ${matchingSuite}`)
    }
    if (suite.status !== 'passed') {
      throw new Error(`Replay suite ${matchingSuite} has status ${suite.status}`)
    }
    actualSuites.add(matchingSuite)
  }
  if (stableReplayJson([...actualSuites].sort(compareAscii)) !==
      stableReplayJson([...expectedSuites].sort(compareAscii))) {
    throw new Error('Replay Vitest report does not contain exactly the two frozen fixture suites')
  }
  const results = (report.testResults ?? []).flatMap((suite) =>
    (suite.assertionResults ?? []).map((assertion) => ({ suite, assertion })),
  )
  const byId = new Map()
  for (const result of results) {
    const match = /^\[([CSZIMP][123])\](?:\s|$)/.exec(result.assertion.title ?? '')
    if (!match) throw new Error(`Replay test lacks a fixture prefix: ${result.assertion.title}`)
    const fixtureId = match[1]
    if (byId.has(fixtureId)) throw new Error(`Vitest report duplicates fixture ${fixtureId}`)
    if (result.assertion.status !== 'passed') {
      throw new Error(`Replay harness ${fixtureId} has status ${result.assertion.status}`)
    }
    byId.set(fixtureId, {
      title: result.assertion.title,
      status: result.assertion.status,
      failureMessages: result.assertion.failureMessages ?? [],
    })
  }
  const actual = [...byId.keys()].sort(compareAscii)
  const expected = [...EXPECTED_BASELINE_REPLAY_FIXTURE_IDS].sort(compareAscii)
  if (stableReplayJson(actual) !== stableReplayJson(expected)) {
    throw new Error(`Vitest fixture IDs mismatch: expected ${expected.join(', ')}, got ${actual.join(', ')}`)
  }
  const exactCounts = {
    // Vitest 3 reports two file suites plus two top-level describe suites.
    numTotalTestSuites: 4,
    numPassedTestSuites: 4,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 18,
    numPassedTests: 18,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
  }
  for (const [field, expectedCount] of Object.entries(exactCounts)) {
    if (report[field] !== expectedCount) {
      throw new Error(`Replay Vitest report ${field}=${report[field]} differs from ${expectedCount}`)
    }
  }
  return byId
}

const numericAssertion = ({ specification, actual, tolerance, details }) => {
  const maxAbsError = Math.max(...actual.map((value) => Math.max(0, value)))
  return {
    id: specification.id,
    required: specification.required,
    accessLevel: specification.access,
    status: maxAbsError <= tolerance ? 'pass' : 'fail',
    comparison: specification.comparison,
    quantity: specification.quantity,
    count: actual.length,
    tolerance,
    maxAbsError,
    maxToleranceRatio: tolerance > 0 ? maxAbsError / tolerance : maxAbsError === 0 ? 0 : null,
    referenceRequirement: specification.reference_requirement,
    reasonCode: maxAbsError <= tolerance ? null : 'tolerance-exceeded',
    details,
  }
}

const nonNumericAssertion = ({ specification, passed, details, failureReason = 'exact-mismatch' }) => ({
  id: specification.id,
  required: specification.required,
  accessLevel: specification.access,
  status: passed ? 'pass' : 'fail',
  comparison: specification.comparison,
  quantity: specification.quantity,
  count: 1,
  tolerance: specification.tolerance,
  maxAbsError: null,
  maxToleranceRatio: null,
  referenceRequirement: specification.reference_requirement,
  reasonCode: passed ? 'non-numeric-assertion' : failureReason,
  details,
})

const notExecutableAssertion = ({ specification, reasonCode, details }) => ({
  id: specification.id,
  required: specification.required,
  accessLevel: specification.access,
  status: 'not-executable',
  comparison: specification.comparison,
  quantity: specification.quantity,
  count: null,
  tolerance: specification.tolerance,
  maxAbsError: null,
  maxToleranceRatio: null,
  referenceRequirement: specification.reference_requirement,
  reasonCode,
  details,
})

const everyOutput = (captured) => [
  ...(captured.output.outputs ?? []),
  ...(captured.output.subtraces ?? []).flatMap((subtrace) => subtrace.outputs ?? []),
]

const scientificOutputs = (outputs) => outputs.map((output) => output.scientificDecision)

const exactJsonEqual = (first, second) => stableReplayJson(first) === stableReplayJson(second)

export const buildBundleAssertions = (
  capturedFixtures,
  commonSpecification,
  informationMatrix = {},
) => {
  const decisions = capturedFixtures.flatMap((fixture) => everyOutput(fixture))
  if (decisions.length === 0) throw new Error('Cannot build bundle assertions without decisions')
  const com01 = commonSpecification.get('COM-01')
  const directionExcesses = decisions.map((output) => {
    const { x, y } = output.decision.direction
    return Math.max(0, Math.hypot(x, y) - 1)
  })
  const com01Result = numericAssertion({
    specification: com01,
    actual: directionExcesses,
    tolerance: com01.tolerance,
    details: { decisionsScanned: decisions.length },
  })

  const com02 = commonSpecification.get('COM-02')
  const boundExcesses = []
  for (const output of decisions) {
    const decision = output.decision
    boundExcesses.push(Math.max(0, -decision.confidence, decision.confidence - 1))
    if (decision.estimate !== null) {
      boundExcesses.push(
        Math.max(0, -decision.estimate.x, decision.estimate.x - 1),
        Math.max(0, -decision.estimate.y, decision.estimate.y - 1),
      )
    }
  }
  const com02Result = numericAssertion({
    specification: com02,
    actual: boundExcesses,
    tolerance: com02.tolerance,
    details: { decisionsScanned: decisions.length },
  })

  // Backward-compatible rebuild path for the immutable Phase 4 archive. New
  // Phase 5 captures always carry explicit evaluator-case artifacts and never
  // enter this label-based legacy branch.
  if (!capturedFixtures.some((fixture) => fixture.evaluatorCases != null)) {
    const pairedAssertion = (id, labelPattern, requiredCoverage, missingReason) => {
      const specification = commonSpecification.get(id)
      const pairs = []
      const covered = new Set()
      let mismatch = false
      for (const fixture of capturedFixtures) {
        const primary = scientificOutputs(fixture.output.outputs ?? [])
        for (const subtrace of fixture.output.subtraces ?? []) {
          if (!labelPattern.test(subtrace.label)) continue
          const peer = scientificOutputs(subtrace.outputs ?? [])
          const equal = exactJsonEqual(primary, peer)
          pairs.push({ fixtureId: fixture.fixtureId, label: subtrace.label, equal })
          if (equal) covered.add(requiredCoverage === 'algorithm'
            ? fixture.specification.algorithmId
            : fixture.fixtureId)
          else mismatch = true
        }
      }
      const expectedCount = requiredCoverage === 'algorithm' ? 6 : 18
      if (mismatch) {
        return nonNumericAssertion({
          specification,
          passed: false,
          details: { pairs },
          failureReason: 'paired-projection-mismatch',
        })
      }
      if (covered.size < expectedCount) {
        return notExecutableAssertion({
          specification,
          reasonCode: missingReason,
          details: { covered: [...covered].sort(compareAscii), expectedCount, pairs },
        })
      }
      return nonNumericAssertion({ specification, passed: true, details: { pairs } })
    }
    const com03Result = pairedAssertion(
      'COM-03',
      /held[-_ ]?out|different-held-out-source/i,
      'algorithm',
      'incomplete-held-out-truth-pair-coverage',
    )
    const com04Result = pairedAssertion(
      'COM-04',
      /duplicate/i,
      'fixture',
      'incomplete-duplicate-replay-coverage',
    )
    const com05Result = notExecutableAssertion({
      specification: commonSpecification.get('COM-05'),
      reasonCode: 'complete-information-matrix-metamorphic-coverage-not-declared',
      details: {
        requiredIgnoredFieldPairs: [
          'coverage:measured-wind',
          'surge-cast:expectedHitRate',
          'zigzag-spiral:measured-wind',
          'zigzag-spiral:expectedHitRate',
          'infotaxis:measured-wind',
          'smc-kl:measured-wind',
        ],
      },
    })
    const terminalDecisions = decisions.filter(
      (output) => output.decision.nativeTerminated === true,
    )
    const com06Result = notExecutableAssertion({
      specification: commonSpecification.get('COM-06'),
      reasonCode: terminalDecisions.length > 0
        ? 'held-out-terminal-evaluator-artifact-unavailable'
        : 'no-applicable-native-terminal-declarations',
      details: { nativeTerminalDecisionCount: terminalDecisions.length },
    })
    const assertions = [
      com01Result,
      com02Result,
      com03Result,
      com04Result,
      com05Result,
      com06Result,
    ]
    return {
      assertions,
      summary: computeFixtureSummary(assertions),
      terminalEvaluatorArtifact: null,
    }
  }

  const evaluated = evaluateDeclaredReplayCases(capturedFixtures, informationMatrix)
  const materializeEvaluatorAssertion = (id, evaluation) => {
    const specification = commonSpecification.get(id)
    if (evaluation.status === 'not-executable') {
      return notExecutableAssertion({
        specification,
        reasonCode: evaluation.details.reasonCode ?? 'no-applicable-declared-cases',
        details: evaluation.details,
      })
    }
    return {
      id: specification.id,
      required: specification.required,
      accessLevel: specification.access,
      status: evaluation.status,
      comparison: specification.comparison,
      quantity: specification.quantity,
      count: Math.max(1, evaluation.count),
      tolerance: specification.tolerance,
      maxAbsError: null,
      maxToleranceRatio: null,
      referenceRequirement: specification.reference_requirement,
      reasonCode: evaluation.status === 'pass' ? null : 'declared-evaluator-case-failed',
      details: evaluation.details,
    }
  }
  const com03Result = materializeEvaluatorAssertion('COM-03', evaluated.com03)
  const com04Result = materializeEvaluatorAssertion('COM-04', evaluated.com04)
  const com05Result = materializeEvaluatorAssertion('COM-05', evaluated.com05)
  const com06Result = materializeEvaluatorAssertion('COM-06', evaluated.com06)
  const assertions = [com01Result, com02Result, com03Result, com04Result, com05Result, com06Result]
  return {
    assertions,
    summary: computeFixtureSummary(assertions),
    terminalEvaluatorArtifact: evaluated.terminalEvaluatorArtifact,
  }
}

const recursivelyListFiles = async (root, include) => {
  const output = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((first, second) => compareAscii(first.name, second.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && include(path)) output.push(path)
    }
  }
  await visit(root)
  return output
}

const inventoryForPaths = async (repositoryRoot, paths) => {
  const inventory = []
  for (const path of [...paths].sort(compareAscii)) {
    const bytes = await readFile(path)
    inventory.push({
      path: relative(repositoryRoot, path).replaceAll('\\', '/'),
      sha256: sha256Bytes(bytes),
      byteLength: bytes.byteLength,
    })
  }
  return inventory
}

const inventoryDigest = (files) => semanticSha256(files)

const sha256File = (path) => new Promise((resolvePromise, reject) => {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.once('error', reject)
  stream.once('end', () => resolvePromise(hash.digest('hex')))
})

const gitCommand = async (repositoryRoot, arguments_) => {
  const result = await execFileAsync(
    'git',
    ['-C', repositoryRoot, ...arguments_],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  return result.stdout.trimEnd()
}

const collectGitProvenance = async (repositoryRoot) => {
  try {
    if (await gitCommand(repositoryRoot, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      return {
        repositoryAvailable: false,
        commit: null,
        state: 'not-a-work-tree',
        canonicalPromotionAllowed: false,
      }
    }
  } catch (error) {
    return {
      repositoryAvailable: false,
      commit: null,
      state: 'git-unavailable-or-not-a-work-tree',
      errorCode: error.code ?? null,
      canonicalPromotionAllowed: false,
    }
  }

  let commit = null
  try {
    commit = await gitCommand(repositoryRoot, ['rev-parse', '--verify', 'HEAD'])
  } catch {
    // A repository with no first commit is a valid, explicitly recorded state.
  }
  let branch = null
  try {
    branch = await gitCommand(repositoryRoot, ['symbolic-ref', '--short', '-q', 'HEAD'])
  } catch {
    // Detached and unborn repositories may not expose a symbolic branch.
  }
  const porcelain = await gitCommand(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ])
  const statusLineCount = porcelain === '' ? 0 : porcelain.split('\n').length
  return {
    repositoryAvailable: true,
    commit,
    branch,
    state: commit === null ? 'unborn' : statusLineCount === 0 ? 'clean' : 'dirty',
    dirty: statusLineCount > 0,
    statusLineCount,
    statusSha256: sha256Bytes(`${porcelain}\n`),
    reason: commit === null
      ? 'Repository has no resolvable HEAD; the archived execution-source snapshot and content-addressed inventories are authoritative.'
      : null,
    canonicalPromotionAllowed: false,
  }
}

const readResolvedPackage = async (repositoryRoot, packageName) => {
  const candidates = [
    join(repositoryRoot, 'node_modules', packageName, 'package.json'),
    join(repositoryRoot, 'node_modules/.pnpm/node_modules', packageName, 'package.json'),
  ]
  let bytes
  for (const candidate of candidates) {
    try {
      bytes = await readFile(candidate)
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (bytes === undefined) throw new Error(`Cannot resolve installed package ${packageName}`)
  const manifest = JSON.parse(bytes.toString('utf8'))
  return {
    name: manifest.name,
    version: manifest.version,
    packageJsonSha256: sha256Bytes(bytes),
  }
}

export const collectReplayProvenance = async (repositoryRoot) => {
  const simulationFiles = await recursivelyListFiles(
    join(repositoryRoot, 'src/sim'),
    (path) => /\.(ts|tsx)$/.test(path) && !/\.test\.(ts|tsx)$/.test(path),
  )
  const implementationFiles = await inventoryForPaths(repositoryRoot, simulationFiles)
  const fixtureFiles = await inventoryForPaths(repositoryRoot, [
    join(repositoryRoot, 'scripts/baseline-replay-reactive.test.ts'),
    join(repositoryRoot, 'scripts/baseline-replay-bayesian.test.ts'),
    join(repositoryRoot, 'scripts/baseline-replay-reference-kernels.ts'),
  ])
  const runnerFiles = await inventoryForPaths(repositoryRoot, [
    join(repositoryRoot, 'scripts/baseline-replay-capture.ts'),
    join(repositoryRoot, 'scripts/baseline-replay-evidence-lib.mjs'),
    join(repositoryRoot, 'scripts/baseline-replay-common-evaluators.mjs'),
    join(repositoryRoot, 'scripts/run-baseline-replay-evidence.mjs'),
    join(repositoryRoot, 'scripts/vitest.headless.config.ts'),
  ])
  const adapterFiles = await inventoryForPaths(repositoryRoot, [
    join(repositoryRoot, 'scripts/baseline-replay-diagnostics.ts'),
  ])
  const protocolFiles = await inventoryForPaths(repositoryRoot, [
    join(repositoryRoot, 'research/protocols/baseline_replay_fixture_protocol.json'),
    join(repositoryRoot, 'research/protocols/baseline_replay_fixture_protocol.md'),
  ])
  const protocolDocument = JSON.parse(await readFile(
    join(repositoryRoot, 'research/protocols/baseline_replay_fixture_protocol.json'),
    'utf8',
  ))
  const dependencyFiles = await inventoryForPaths(repositoryRoot, [
    join(repositoryRoot, 'package.json'),
    join(repositoryRoot, 'pnpm-lock.yaml'),
  ])
  const executionConfigFiles = await inventoryForPaths(repositoryRoot, [
    join(repositoryRoot, 'pnpm-workspace.yaml'),
    join(repositoryRoot, 'tsconfig.json'),
    join(repositoryRoot, 'tsconfig.app.json'),
    join(repositoryRoot, 'tsconfig.node.json'),
  ])
  const resolvedPackages = []
  for (const packageName of ['vitest', 'vite', 'typescript', 'esbuild']) {
    resolvedPackages.push(await readResolvedPackage(repositoryRoot, packageName))
  }
  resolvedPackages.sort((first, second) => compareAscii(first.name, second.name))
  const git = await collectGitProvenance(repositoryRoot)
  const nodeExecutableStat = await stat(process.execPath)
  const nodeExecutableSha256 = await sha256File(process.execPath)
  return {
    git,
    implementation: { files: implementationFiles, bundleSha256: inventoryDigest(implementationFiles) },
    fixtureDefinitions: { files: fixtureFiles, bundleSha256: inventoryDigest(fixtureFiles) },
    runner: { schemaVersion: BASELINE_REPLAY_RUNNER_SCHEMA_VERSION, files: runnerFiles, bundleSha256: inventoryDigest(runnerFiles) },
    diagnosticAdapter: { schemaVersion: 'baseline-replay-diagnostic-v2', files: adapterFiles, bundleSha256: inventoryDigest(adapterFiles) },
    protocol: { schemaVersion: protocolDocument.schema_version, files: protocolFiles, bundleSha256: inventoryDigest(protocolFiles) },
    dependencies: { files: dependencyFiles, bundleSha256: inventoryDigest(dependencyFiles) },
    executionConfiguration: {
      files: executionConfigFiles,
      bundleSha256: inventoryDigest(executionConfigFiles),
      packageManager: JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')).packageManager,
      resolvedPackages,
      resolvedPackagesSha256: semanticSha256(resolvedPackages),
    },
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      executablePath: process.execPath,
      executableSha256: nodeExecutableSha256,
      executableByteLength: nodeExecutableStat.size,
      operatingSystem: operatingSystemVersion(),
      operatingSystemRelease: release(),
      platform: platform(),
      architecture: arch(),
    },
  }
}

export const createFixtureResult = ({ captured, provenance, vitestResult }) => {
  const fixtureDefinitionPath = captured.fixtureId[0].match(/[CSZ]/)
    ? 'scripts/baseline-replay-reactive.test.ts'
    : 'scripts/baseline-replay-bayesian.test.ts'
  const fixtureDefinition = provenance.fixtureDefinitions.files.find(
    (file) => file.path === fixtureDefinitionPath,
  )
  const diagnosticUsed = captured.assertions.some((assertion) =>
    assertion.accessLevel.includes('diagnostic') && assertion.status !== 'not-executable')
  const referenceArtifact = captured.artifactDescriptors['reference-output'] ?? null
  return {
    schemaVersion: BASELINE_REPLAY_RESULT_SCHEMA_VERSION,
    protocol: {
      schemaVersion: provenance.protocol.schemaVersion,
      bundleSha256: provenance.protocol.bundleSha256,
    },
    fixture: {
      algorithmId: captured.specification.algorithmId,
      fixtureId: captured.fixtureId,
      accessLevel: captured.specification.accessLevel,
      description: captured.specification.description,
      honestAlgorithmLabel: captured.specification.honestLabel,
      fixtureDefinition: fixtureDefinition ?? null,
      requiredAssertionIds: [...captured.specification.assertions.keys()].sort(compareAscii),
    },
    execution: {
      status: vitestResult.status === 'passed' ? 'complete' : 'harness-failed',
      harnessTitle: vitestResult.title,
      runnerSchemaVersion: provenance.runner.schemaVersion,
      runnerBundleSha256: provenance.runner.bundleSha256,
      implementationBundleSha256: provenance.implementation.bundleSha256,
      git: provenance.git,
      dependencyBundleSha256: provenance.dependencies.bundleSha256,
      runtime: provenance.runtime,
    },
    trace: {
      schemaVersion: captured.trace.schemaVersion,
      steps: captured.traceSteps,
      ...captured.artifactDescriptors.trace,
    },
    observationModel: captured.fixture.observationModel,
    adapter: diagnosticUsed
      ? {
          schemaVersion: provenance.diagnosticAdapter.schemaVersion,
          sourceBundleSha256: provenance.diagnosticAdapter.bundleSha256,
          output: captured.artifactDescriptors['diagnostic-output'] ?? null,
          productionEnvironmentExcluded: true,
          nonIntervening: true,
        }
      : null,
    reference: {
      origin: 'development-spec',
      independentOfSystemUnderTest: false,
      source: fixtureDefinition ?? null,
      output: referenceArtifact,
      primaryCanonicalSourceExecuted: false,
    },
    artifacts: captured.artifactDescriptors,
    assertions: captured.assertions,
    summary: {
      ...captured.summary,
      evidenceTier: 'development-behavior',
      claimLabel: 'development-behavior-only',
      promotionEligible: false,
      promotionBlockers: [
        captured.specification.promotionBlocker,
        'No equation-reference or canonical-source replay was executed.',
      ],
    },
  }
}
