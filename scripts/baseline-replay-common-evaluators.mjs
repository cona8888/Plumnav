/**
 * Explicit Phase 5 bundle evaluators for COM-03--COM-06.
 *
 * Applicability is selected only by versioned case records. Human-readable
 * trace labels are endpoint identifiers and are never pattern-matched to infer
 * scientific meaning. Held-out truth is read only from the separate truth
 * artifact loaded by the archive builder.
 */

export const REPLAY_COMMON_EVALUATOR_SCHEMA_VERSION =
  'gsl-baseline-replay-common-evaluator-v1'
export const REPLAY_TERMINAL_EVALUATOR_OUTPUT_SCHEMA_VERSION =
  'gsl-held-out-terminal-evaluator-output-v1'

const compareAscii = (first, second) => first < second ? -1 : first > second ? 1 : 0

const canonicalValue = (value) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Evaluator received a non-finite number')
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([first], [second]) => compareAscii(first, second))
        .map(([key, item]) => [key, canonicalValue(item)]),
    )
  }
  throw new TypeError('Evaluator received non-JSON data')
}

const exactEqual = (first, second) =>
  JSON.stringify(canonicalValue(first)) === JSON.stringify(canonicalValue(second))

const scientificProjection = (endpoint) =>
  endpoint.outputs.map((output) => output.scientificDecision)

const endpointFor = (fixture, endpointId) => {
  if (endpointId === 'primary') {
    return {
      endpointId,
      environment: fixture.trace.environment,
      steps: fixture.trace.steps ?? [],
      outputs: fixture.output.outputs ?? [],
    }
  }
  const traceMatches = (fixture.trace.subtraces ?? [])
    .filter((subtrace) => subtrace.label === endpointId)
  const outputMatches = (fixture.output.subtraces ?? [])
    .filter((subtrace) => subtrace.label === endpointId)
  if (traceMatches.length !== 1 || outputMatches.length !== 1) {
    throw new Error(
      `${fixture.fixtureId} endpoint ${endpointId} must resolve to one trace and one output`,
    )
  }
  return {
    endpointId,
    environment: traceMatches[0].environment,
    steps: traceMatches[0].steps ?? [],
    outputs: outputMatches[0].outputs ?? [],
  }
}

const inputsFor = (endpoint) => endpoint.steps.map((step) => step.input)

const truthRecordsFor = (fixture) => new Map(
  (fixture.heldOutTruth?.records ?? []).map((record) => [record.truthId, record]),
)

const containsForbiddenTruthKey = (value) => {
  const forbidden = new Set([
    'truthId',
    'truthClass',
    'heldOutTruth',
    'heldOutSource',
    'privateTruth',
  ])
  const visit = (item) => {
    if (Array.isArray(item)) return item.some(visit)
    if (!item || typeof item !== 'object') return false
    return Object.entries(item).some(([key, nested]) => forbidden.has(key) || visit(nested))
  }
  return visit(value)
}

const validDistinctResets = (caseRecord) =>
  Number.isInteger(caseRecord.primaryResetOrdinal) &&
  Number.isInteger(caseRecord.peerResetOrdinal) &&
  caseRecord.primaryResetOrdinal > 0 &&
  caseRecord.peerResetOrdinal > 0 &&
  caseRecord.primaryResetOrdinal !== caseRecord.peerResetOrdinal

const result = (status, cases, details = {}) => ({
  status,
  count: cases.length,
  details: { evaluatorSchemaVersion: REPLAY_COMMON_EVALUATOR_SCHEMA_VERSION, ...details, cases },
})

const declaredCases = (fixtures, assertionId) => fixtures.flatMap((fixture) =>
  (fixture.evaluatorCases?.cases ?? [])
    .filter((caseRecord) => caseRecord.assertionId === assertionId)
    .map((caseRecord) => ({ fixture, caseRecord })),
)

const evaluateCom03 = (fixtures) => {
  const evaluated = []
  const coveredAlgorithms = new Set()
  let mismatch = false
  for (const { fixture, caseRecord } of declaredCases(fixtures, 'COM-03')) {
    const primary = endpointFor(fixture, caseRecord.primaryEndpoint)
    const peer = endpointFor(fixture, caseRecord.peerEndpoint)
    const truth = truthRecordsFor(fixture)
    const primaryTruth = truth.get(caseRecord.primaryTruthId)
    const peerTruth = truth.get(caseRecord.peerTruthId)
    const checks = {
      explicitRole: caseRecord.role === 'held-out-truth-pair',
      resetIdentityDistinct: validDistinctResets(caseRecord),
      environmentsEqual: exactEqual(primary.environment, peer.environment),
      visibleInputsEqual: exactEqual(inputsFor(primary), inputsFor(peer)),
      scientificOutputsEqual: exactEqual(
        scientificProjection(primary),
        scientificProjection(peer),
      ),
      truthRecordsPresent: primaryTruth !== undefined && peerTruth !== undefined,
      truthIdsDistinct: caseRecord.primaryTruthId !== caseRecord.peerTruthId,
      truthValuesDistinct: primaryTruth !== undefined && peerTruth !== undefined &&
        !exactEqual(primaryTruth, peerTruth),
      controllerArtifactsTruthFree: !containsForbiddenTruthKey({
        trace: fixture.trace,
        output: fixture.output,
      }),
    }
    const passed = Object.values(checks).every(Boolean)
    mismatch ||= !passed
    if (passed) coveredAlgorithms.add(fixture.specification.algorithmId)
    evaluated.push({
      caseId: caseRecord.caseId,
      fixtureId: fixture.fixtureId,
      algorithmId: fixture.specification.algorithmId,
      primaryEndpoint: caseRecord.primaryEndpoint,
      peerEndpoint: caseRecord.peerEndpoint,
      primaryTruthId: caseRecord.primaryTruthId,
      peerTruthId: caseRecord.peerTruthId,
      checks,
      passed,
    })
  }
  const expectedAlgorithms = [...new Set(
    fixtures.map((fixture) => fixture.specification.algorithmId),
  )].sort(compareAscii)
  const covered = [...coveredAlgorithms].sort(compareAscii)
  if (mismatch) return result('fail', evaluated, { expectedAlgorithms, covered })
  if (!exactEqual(covered, expectedAlgorithms)) {
    return result('not-executable', evaluated, {
      reasonCode: 'incomplete-held-out-truth-pair-coverage',
      expectedAlgorithms,
      covered,
    })
  }
  return result('pass', evaluated, { expectedAlgorithms, covered })
}

const evaluateCom04 = (fixtures) => {
  const evaluated = []
  const coveredFixtures = new Set()
  let mismatch = false
  for (const { fixture, caseRecord } of declaredCases(fixtures, 'COM-04')) {
    const primary = endpointFor(fixture, caseRecord.primaryEndpoint)
    const peer = endpointFor(fixture, caseRecord.peerEndpoint)
    const checks = {
      explicitRole: caseRecord.role === 'fresh-reset-duplicate',
      freshControllerInstancesDeclared: caseRecord.freshControllerInstances === true,
      resetIdentityDistinct: validDistinctResets(caseRecord),
      environmentsEqual: exactEqual(primary.environment, peer.environment),
      visibleInputsEqual: exactEqual(inputsFor(primary), inputsFor(peer)),
      scientificOutputsEqual: exactEqual(
        scientificProjection(primary),
        scientificProjection(peer),
      ),
    }
    const passed = Object.values(checks).every(Boolean)
    mismatch ||= !passed
    if (passed) coveredFixtures.add(fixture.fixtureId)
    evaluated.push({
      caseId: caseRecord.caseId,
      fixtureId: fixture.fixtureId,
      algorithmId: fixture.specification.algorithmId,
      primaryEndpoint: caseRecord.primaryEndpoint,
      peerEndpoint: caseRecord.peerEndpoint,
      checks,
      passed,
    })
  }
  const expectedFixtures = fixtures.map((fixture) => fixture.fixtureId).sort(compareAscii)
  const covered = [...coveredFixtures].sort(compareAscii)
  if (mismatch) return result('fail', evaluated, { expectedFixtures, covered })
  if (!exactEqual(covered, expectedFixtures)) {
    return result('not-executable', evaluated, {
      reasonCode: 'incomplete-duplicate-replay-coverage',
      expectedFixtures,
      covered,
    })
  }
  return result('pass', evaluated, { expectedFixtures, covered })
}

const stripMeasuredWind = (inputs) => inputs.map((input) => ({
  ...input,
  measurement: input.measurement
    ? { ...input.measurement, wind: '__ignored-measured-wind__' }
    : input.measurement,
  observations: (input.observations ?? []).map((observation) => ({
    ...observation,
    wind: '__ignored-measured-wind__',
  })),
}))

const measuredWindProjection = (inputs) => inputs.map((input) => ({
  measurement: input.measurement?.wind ?? null,
  observations: (input.observations ?? []).map((observation) => observation.wind ?? null),
}))

const stripExpectedHitRate = (environment) => ({
  ...environment,
  functions: {
    ...environment.functions,
    expectedHitRate: '__ignored-expected-hit-rate__',
  },
})

const evaluateCom05 = (fixtures, informationMatrix) => {
  const expectedPairs = Object.entries(informationMatrix ?? {})
    .flatMap(([algorithmId, entry]) => (entry.ignored ?? []).map(
      (ignoredField) => `${algorithmId}:${ignoredField}`,
    ))
    .sort(compareAscii)
  const evaluated = []
  const coveredPairs = new Set()
  let mismatch = false
  for (const { fixture, caseRecord } of declaredCases(fixtures, 'COM-05')) {
    const primary = endpointFor(fixture, caseRecord.primaryEndpoint)
    const peer = endpointFor(fixture, caseRecord.peerEndpoint)
    const primaryInputs = inputsFor(primary)
    const peerInputs = inputsFor(peer)
    const pair = `${fixture.specification.algorithmId}:${caseRecord.ignoredField}`
    let nonTargetInputsEqual = false
    let nonTargetEnvironmentEqual = false
    let declaredMutationOccurred = false
    if (caseRecord.ignoredField === 'measured-wind') {
      nonTargetInputsEqual = exactEqual(
        stripMeasuredWind(primaryInputs),
        stripMeasuredWind(peerInputs),
      )
      nonTargetEnvironmentEqual = exactEqual(primary.environment, peer.environment)
      declaredMutationOccurred = !exactEqual(
        measuredWindProjection(primaryInputs),
        measuredWindProjection(peerInputs),
      )
    } else if (caseRecord.ignoredField === 'expectedHitRate') {
      nonTargetInputsEqual = exactEqual(primaryInputs, peerInputs)
      nonTargetEnvironmentEqual = exactEqual(
        stripExpectedHitRate(primary.environment),
        stripExpectedHitRate(peer.environment),
      )
      declaredMutationOccurred = !exactEqual(
        primary.environment?.functions?.expectedHitRate,
        peer.environment?.functions?.expectedHitRate,
      )
    }
    const checks = {
      explicitRole: caseRecord.role === 'ignored-field-metamorphic',
      pairDeclaredByProtocol: expectedPairs.includes(pair),
      resetIdentityDistinct: validDistinctResets(caseRecord),
      nonTargetInputsEqual,
      nonTargetEnvironmentEqual,
      declaredMutationOccurred,
      scientificOutputsEqual: exactEqual(
        scientificProjection(primary),
        scientificProjection(peer),
      ),
    }
    const passed = Object.values(checks).every(Boolean)
    mismatch ||= !passed
    if (passed) coveredPairs.add(pair)
    evaluated.push({
      caseId: caseRecord.caseId,
      fixtureId: fixture.fixtureId,
      algorithmId: fixture.specification.algorithmId,
      ignoredField: caseRecord.ignoredField,
      primaryEndpoint: caseRecord.primaryEndpoint,
      peerEndpoint: caseRecord.peerEndpoint,
      checks,
      passed,
    })
  }
  const covered = [...coveredPairs].sort(compareAscii)
  if (mismatch) return result('fail', evaluated, { expectedPairs, covered })
  if (!exactEqual(covered, expectedPairs)) {
    return result('not-executable', evaluated, {
      reasonCode: 'incomplete-information-matrix-metamorphic-coverage',
      expectedPairs,
      covered,
    })
  }
  return result('pass', evaluated, { expectedPairs, covered })
}

const evaluateCom06 = (fixtures) => {
  const evaluated = []
  for (const { fixture, caseRecord } of declaredCases(fixtures, 'COM-06')) {
    const endpoint = endpointFor(fixture, caseRecord.terminalEndpoint)
    const truth = truthRecordsFor(fixture).get(caseRecord.truthId)
    const outputs = scientificProjection(endpoint)
    const transitions = outputs
      .map((decision, index) => ({ decision, index }))
      .filter(({ decision, index }) =>
        decision.nativeTerminated === true &&
        (index === 0 || outputs[index - 1]?.nativeTerminated !== true),
      )
    const terminal = transitions[0]?.decision
    const thresholdValid = Number.isFinite(caseRecord.localizationThreshold) &&
      caseRecord.localizationThreshold > 0
    const declaredClass = terminal === undefined
      ? null
      : terminal.nativeAbstained === true
        ? 'source-absent'
        : 'source-present'
    const classificationCorrect = truth !== undefined && declaredClass === truth.truthClass
    const localizationError = truth?.truthClass === 'source-present' &&
      truth.source !== null && terminal?.estimate !== null && terminal?.estimate !== undefined
      ? Math.hypot(
          terminal.estimate.x - truth.source.x,
          terminal.estimate.y - truth.source.y,
        )
      : null
    const withinThreshold = localizationError === null || !thresholdValid
      ? false
      : localizationError <= caseRecord.localizationThreshold
    const checks = {
      explicitRole: caseRecord.role === 'held-out-terminal-evaluation',
      truthRecordPresent: truth !== undefined,
      exactlyOneTerminalTransition: transitions.length === 1,
      thresholdValid,
      classificationCorrect,
      localizationExecutable: truth?.truthClass === 'source-absent' || localizationError !== null,
      localizationWithinThreshold: truth?.truthClass === 'source-absent' || withinThreshold,
    }
    const passed = Object.values(checks).every(Boolean)
    evaluated.push({
      caseId: caseRecord.caseId,
      fixtureId: fixture.fixtureId,
      algorithmId: fixture.specification.algorithmId,
      terminalEndpoint: caseRecord.terminalEndpoint,
      terminalSequence: transitions[0] === undefined ? null : transitions[0].index + 1,
      truthId: caseRecord.truthId,
      truthClass: truth?.truthClass ?? null,
      declaredClass,
      declaredEstimate: terminal?.estimate ?? null,
      classificationCorrect,
      localizationError,
      localizationThreshold: caseRecord.localizationThreshold,
      withinThreshold,
      checks,
      passed,
    })
  }
  const status = evaluated.length === 0
    ? 'not-executable'
    : evaluated.every((entry) => entry.passed)
      ? 'pass'
      : 'fail'
  const runIds = [...new Set(fixtures.map((fixture) => fixture.runId))]
  return {
    assertion: result(status, evaluated, {
      ...(evaluated.length === 0
        ? { reasonCode: 'no-designated-native-terminal-declarations' }
        : {}),
      classificationPassCount: evaluated.filter((entry) => entry.classificationCorrect).length,
      localizationPassCount: evaluated.filter((entry) => entry.withinThreshold).length,
    }),
    artifact: {
      schemaVersion: REPLAY_TERMINAL_EVALUATOR_OUTPUT_SCHEMA_VERSION,
      semanticJsonVersion: 'gsl-semantic-json-v1',
      evaluatorSchemaVersion: REPLAY_COMMON_EVALUATOR_SCHEMA_VERSION,
      evaluatorImplementation: 'scripts/baseline-replay-common-evaluators.mjs',
      runId: runIds.length === 1 ? runIds[0] : null,
      claimLabel: 'development-behavior-only',
      cases: evaluated,
      summary: {
        status,
        caseCount: evaluated.length,
        classificationPassCount: evaluated.filter((entry) => entry.classificationCorrect).length,
        localizationPassCount: evaluated.filter((entry) => entry.withinThreshold).length,
      },
    },
  }
}

export const evaluateDeclaredReplayCases = (fixtures, informationMatrix) => {
  const allCases = fixtures.flatMap((fixture) => fixture.evaluatorCases?.cases ?? [])
  const ids = new Set()
  for (const caseRecord of allCases) {
    if (ids.has(caseRecord.caseId)) {
      throw new Error(`Duplicate evaluator case id ${caseRecord.caseId}`)
    }
    ids.add(caseRecord.caseId)
  }
  const terminal = evaluateCom06(fixtures)
  return {
    com03: evaluateCom03(fixtures),
    com04: evaluateCom04(fixtures),
    com05: evaluateCom05(fixtures, informationMatrix),
    com06: terminal.assertion,
    terminalEvaluatorArtifact: terminal.artifact,
  }
}
