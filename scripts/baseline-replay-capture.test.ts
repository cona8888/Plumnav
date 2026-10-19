import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDefaultConfig } from '../src/sim/config'
import { createScenario } from '../src/sim/scenarios'
import type {
  AlgorithmController,
  AlgorithmEnvironment,
  AlgorithmStepInput,
} from '../src/sim/types'
import {
  BASELINE_REPLAY_ASSERTIONS_SCHEMA_VERSION,
  BASELINE_REPLAY_CAPTURE_BINDING_SCHEMA_VERSION,
  BASELINE_REPLAY_CAPTURE_SCHEMA_VERSION,
  BASELINE_REPLAY_DIAGNOSTIC_OUTPUT_SCHEMA_VERSION,
  BASELINE_REPLAY_EVALUATOR_CASES_SCHEMA_VERSION,
  BASELINE_REPLAY_HELD_OUT_TRUTH_SCHEMA_VERSION,
  BASELINE_REPLAY_REFERENCE_OUTPUT_SCHEMA_VERSION,
  BASELINE_REPLAY_SEMANTIC_JSON_VERSION,
  BASELINE_REPLAY_STANDALONE_RUN_ID,
  BASELINE_REPLAY_SUT_OUTPUT_SCHEMA_VERSION,
  BASELINE_REPLAY_TRACE_SCHEMA_VERSION,
  ReplayFixtureRecorder,
  canonicalReplayJsonValue,
  replayDecisionProjection,
  stableReplayJson,
  type ReplayEnvironmentFunctionContracts,
} from './baseline-replay-capture'

const temporaryDirectories: string[] = []

afterEach(() => {
  delete process.env.BASELINE_REPLAY_CAPTURE_DIR
  delete process.env.BASELINE_REPLAY_RUN_ID
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true })
})

const environment = (): AlgorithmEnvironment => {
  const scenario = createScenario('open', 5, createDefaultConfig('coverage', 'open'))
  const { source: _source, targetStatus: _targetStatus, ...publicScenario } = scenario
  return {
    scenario: publicScenario,
    controllerSeed: 11,
    observationModelVersion: 'deterministic-test-oracle-v1',
    observationModelSeed: 22,
    maxSpeed: 0.05,
    activeSniffEnabled: false,
    activeSniffCycleSeconds: 0.8,
    activeSniffReach: 0.06,
    sensorNoise: 0,
    isBlocked: () => false,
    windAt: () => ({ x: 1, y: 0 }),
    expectedHitRate: () => 0.2,
    safeDirection: (_from, desired) => ({ ...desired }),
    terrainMobilityScale: () => 1,
    horizontalReachForSurfaceDistance: (_direction, distance) => distance,
  }
}

const contracts: ReplayEnvironmentFunctionContracts = {
  isBlocked: { id: 'unblocked-domain-v1' },
  windAt: { id: 'constant-wind-v1', parameters: { x: 1, y: 0 } },
  expectedHitRate: { id: 'constant-rate-v1', parameters: { rate: 0.2 } },
  safeDirection: { id: 'identity-steering-v1' },
  terrainMobilityScale: { id: 'flat-mobility-v1' },
  horizontalReachForSurfaceDistance: { id: 'flat-reach-v1' },
}

const input: AlgorithmStepInput = {
  time: 0,
  dt: 0.25,
  position: { x: 0.5, y: 0.5 },
  heading: 0,
  measurement: {
    time: 0,
    concentration: 0,
    hit: false,
    wind: { x: 1, y: 0 },
    valid: true,
    sampleMode: 'passive',
  },
  observations: [],
  distance: 0,
}

const controller: AlgorithmController = {
  metadata: {
    id: 'coverage',
    index: 'T',
    name: 'test',
    shortName: 'test',
    family: 'test',
    color: '#000',
    summary: 'test',
    principle: 'test',
    sensors: [],
    assumptions: [],
    strengths: [],
    limitations: [],
    citationLabel: 'test',
    citationUrl: 'https://example.invalid',
  },
  reset: () => {},
  step: () => ({
    direction: { x: 1, y: -0 },
    estimate: null,
    confidence: 0,
    phase: 'test',
  }),
}

const recorder = (env: AlgorithmEnvironment) => new ReplayFixtureRecorder({
  fixtureId: 'C1',
  algorithmId: 'coverage',
  accessLevel: 'black-box',
  controllerSeed: env.controllerSeed,
  environment: env,
  functionContracts: contracts,
  observationModel: {
    id: env.observationModelVersion,
    usesRng: false,
    seed: null,
    controllerExposedSeed: env.observationModelSeed,
    seedUsed: false,
  },
})

describe('baseline replay evidence capture', () => {
  it('canonicalizes finite JSON without rounding and normalizes negative zero', () => {
    expect(canonicalReplayJsonValue({ z: -0, a: [1.2345678901234567] })).toEqual({
      a: [1.2345678901234567],
      z: 0,
    })
    expect(stableReplayJson({ b: 2, a: 1 })).toBe(stableReplayJson({ a: 1, b: 2 }))
    expect(() => canonicalReplayJsonValue([Number.NaN])).toThrow(/finite numbers/)
    expect(() => canonicalReplayJsonValue([undefined])).toThrow(/not JSON data/)
    expect(replayDecisionProjection(controller.step(input))).toMatchObject({
      speedScale: null,
      nativeTerminated: null,
      terminationReason: null,
      debug: null,
    })
  })

  it('materializes separate exact trace, output, diagnostic, reference, and assertion artifacts', () => {
    const path = mkdtempSync(join(tmpdir(), 'plumenav-replay-capture-'))
    temporaryDirectories.push(path)
    process.env.BASELINE_REPLAY_CAPTURE_DIR = path
    process.env.BASELINE_REPLAY_RUN_ID = 'unit-capture-run-001'
    const env = environment()
    const capture = recorder(env)
    capture.step(controller, input, 'first')
    capture.diagnostic('state', { privateCopy: [1, 2] })
    capture.reference('arithmetic', { expected: [0.2] })
    capture.numeric({
      id: 'C1.direction',
      actual: [1, 0],
      expected: [1, 0],
      tolerance: 1e-12,
      quantity: 'normalized-direction',
    })
    capture.nonNumeric({
      id: 'C1.phase',
      passed: true,
      comparison: 'exact-string',
    })
    capture.finish()

    const expectedSchemas = {
      fixture: BASELINE_REPLAY_CAPTURE_SCHEMA_VERSION,
      trace: BASELINE_REPLAY_TRACE_SCHEMA_VERSION,
      'sut-output': BASELINE_REPLAY_SUT_OUTPUT_SCHEMA_VERSION,
      'diagnostic-output': BASELINE_REPLAY_DIAGNOSTIC_OUTPUT_SCHEMA_VERSION,
      'reference-output': BASELINE_REPLAY_REFERENCE_OUTPUT_SCHEMA_VERSION,
      assertions: BASELINE_REPLAY_ASSERTIONS_SCHEMA_VERSION,
    } as const
    const documents = Object.entries(expectedSchemas).map(([suffix, schemaVersion]) => {
      const document = JSON.parse(
        readFileSync(join(path, `C1.${suffix}.json`), 'utf8'),
      ) as Record<string, unknown>
      expect(document).toMatchObject({
        schemaVersion,
        semanticJsonVersion: BASELINE_REPLAY_SEMANTIC_JSON_VERSION,
        runId: 'unit-capture-run-001',
        captureBindingSchemaVersion: BASELINE_REPLAY_CAPTURE_BINDING_SCHEMA_VERSION,
        fixtureId: 'C1',
      })
      return document
    })
    expect(new Set(documents.map((document) => document.runId))).toEqual(
      new Set(['unit-capture-run-001']),
    )
    const bindings = new Set(documents.map((document) => document.captureBindingSha256))
    expect(bindings.size).toBe(1)
    expect([...bindings][0]).toMatch(/^[a-f0-9]{64}$/)

    for (const suffix of [
      'fixture',
      'trace',
      'sut-output',
      'diagnostic-output',
      'reference-output',
      'assertions',
    ]) {
      expect(JSON.parse(readFileSync(join(path, `C1.${suffix}.json`), 'utf8'))).toBeTruthy()
    }
    const trace = JSON.parse(readFileSync(join(path, 'C1.trace.json'), 'utf8'))
    expect(trace.steps[0].input).toEqual(input)
    const output = JSON.parse(readFileSync(join(path, 'C1.sut-output.json'), 'utf8'))
    expect(output.outputs[0].decision.direction.y).toBe(0)
  })

  it('uses an explicit deterministic standalone identity when no run id is supplied', () => {
    delete process.env.BASELINE_REPLAY_RUN_ID
    const env = environment()
    const first = recorder(env)
    first.step(controller, input)
    first.nonNumeric({ id: 'C1.standalone', passed: true, comparison: 'exact' })
    const firstResult = first.finish()

    const second = recorder(environment())
    second.step(controller, input)
    second.nonNumeric({ id: 'C1.standalone', passed: true, comparison: 'exact' })
    const secondResult = second.finish()

    expect(firstResult.fixture.runId).toBe(BASELINE_REPLAY_STANDALONE_RUN_ID)
    expect(firstResult.trace.runId).toBe(BASELINE_REPLAY_STANDALONE_RUN_ID)
    expect(firstResult.fixture.captureBindingSha256).toBe(
      secondResult.fixture.captureBindingSha256,
    )
  })

  it('binds explicit evaluator cases to the exact held-out-truth content', () => {
    const path = mkdtempSync(join(tmpdir(), 'plumenav-replay-truth-binding-'))
    temporaryDirectories.push(path)
    process.env.BASELINE_REPLAY_CAPTURE_DIR = path
    const capture = recorder(environment())
    capture.step(controller, input)
    capture.nonNumeric({ id: 'C1.bound', passed: true, comparison: 'exact' })
    capture.heldOutTruthRecord({
      truthId: 'C1-truth',
      truthClass: 'source-present',
      source: { x: 0.25, y: 0.75 },
      prespecifiedBasis: 'unit-test held-out truth',
    })
    capture.evaluatorCase({
      caseId: 'C1-terminal',
      assertionId: 'COM-06',
      role: 'held-out-terminal-evaluation',
      terminalEndpoint: 'primary',
      truthId: 'C1-truth',
      localizationThreshold: 0.05,
    })
    capture.finish()

    const cases = JSON.parse(readFileSync(join(path, 'C1.evaluator-cases.json'), 'utf8'))
    const truth = JSON.parse(readFileSync(join(path, 'C1.held-out-truth.json'), 'utf8'))
    expect(cases.schemaVersion).toBe(BASELINE_REPLAY_EVALUATOR_CASES_SCHEMA_VERSION)
    expect(truth.schemaVersion).toBe(BASELINE_REPLAY_HELD_OUT_TRUTH_SCHEMA_VERSION)
    expect(cases.heldOutTruthBindingSha256).toBe(truth.heldOutTruthBindingSha256)
    expect(truth.heldOutTruthBindingSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('separates fixture verdict from evidence tier and records numeric error explicitly', () => {
    const env = environment()
    const capture = recorder(env)
    capture.step(controller, input)
    capture.numeric({
      id: 'C1.numeric',
      actual: [1, 2],
      expected: [1, 2.1],
      tolerance: 0.05,
      quantity: 'test-value',
    })
    capture.notExecutable({
      id: 'C1.canonical',
      comparison: 'canonical-source-output',
      reasonCode: 'canonical-source-unavailable',
      referenceRequirement: 'canonical-source',
      required: false,
    })
    const result = capture.finish({ throwOnFailure: false })
    expect(result.fixture).toMatchObject({
      evidenceTier: 'development-behavior',
      claimLabel: 'development-behavior-only',
      promotionEligible: false,
      summary: { fixtureVerdict: 'fail' },
    })
    expect(result.assertions[0]).toMatchObject({ count: 2, status: 'fail' })
    expect(result.assertions[0]?.maxAbsError).toBeCloseTo(0.1, 14)
    expect(result.assertions[0]?.maxToleranceRatio).toBeCloseTo(2, 14)
    expect(result.assertions[1]).toMatchObject({
      status: 'not-executable',
      maxAbsError: null,
      reasonCode: 'canonical-source-unavailable',
    })
  })

  it('can attach an already executed source-blind harness frame without invoking the controller', () => {
    const env = environment()
    const capture = recorder(env)
    let calls = 0
    const observedController: AlgorithmController = {
      ...controller,
      step: () => {
        calls += 1
        return controller.step(input)
      },
    }
    const decision = observedController.step(input)
    capture.recordCompletedStep(input, decision, 'already-executed')
    capture.recordCompletedTrace({
      label: 'counterfactual-reset',
      environment: env,
      functionContracts: contracts,
      frames: [{ input, decision }],
    })
    capture.nonNumeric({ id: 'C1.attached', passed: true, comparison: 'exact' })
    const result = capture.finish()
    expect(calls).toBe(1)
    expect(result.trace.steps[0]).toMatchObject({ label: 'already-executed', input })
    expect(result.trace.subtraces[0]).toMatchObject({
      label: 'counterfactual-reset',
      steps: [{ input }],
    })
  })

  it('rejects duplicate assertion ids and stochastic oracles without a seed', () => {
    const env = environment()
    const capture = recorder(env)
    capture.step(controller, input)
    capture.nonNumeric({ id: 'C1.unique', passed: true, comparison: 'boolean' })
    expect(() => capture.nonNumeric({
      id: 'C1.unique',
      passed: true,
      comparison: 'boolean',
    })).toThrow(/duplicate replay assertion/i)
    expect(() => new ReplayFixtureRecorder({
      fixtureId: 'C1',
      algorithmId: 'coverage',
      accessLevel: 'black-box',
      controllerSeed: env.controllerSeed,
      environment: env,
      functionContracts: contracts,
      observationModel: {
        id: 'invalid-stochastic-oracle',
        usesRng: true,
        seed: null,
        controllerExposedSeed: env.observationModelSeed,
        seedUsed: true,
      },
    })).toThrow(/requires a scientific RNG seed/i)
  })
})
