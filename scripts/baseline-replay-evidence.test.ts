import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import protocol from '../research/protocols/baseline_replay_fixture_protocol.json'
import {
  EXPECTED_BASELINE_REPLAY_FIXTURE_IDS,
  buildBundleAssertions,
  computeFixtureSummary,
  contentSha256,
  stableReplayJson,
  sha256Bytes,
  validateFixtureAssertions,
  validateHeldOutTruthBinding,
  validateProtocolCatalog,
  validateVitestFixtureReport,
} from './baseline-replay-evidence-lib.mjs'
import { verifyBaselineReplayChecksumManifest } from './run-baseline-replay-evidence.mjs'

const catalogue = validateProtocolCatalog(protocol)

const passingRecord = (assertion: {
  id: string
  required: boolean
  access: string
  comparison: string
  quantity: string | null
  tolerance: number | null
  reference_requirement: string
}) => assertion.tolerance === null
  ? {
      id: assertion.id,
      required: assertion.required,
      accessLevel: assertion.access,
      status: 'pass',
      comparison: assertion.comparison,
      quantity: assertion.quantity,
      count: 1,
      tolerance: null,
      maxAbsError: null,
      maxToleranceRatio: null,
      referenceRequirement: assertion.reference_requirement,
      reasonCode: 'non-numeric-assertion',
    }
  : {
      id: assertion.id,
      required: assertion.required,
      accessLevel: assertion.access,
      status: 'pass',
      comparison: assertion.comparison,
      quantity: assertion.quantity,
      count: 2,
      tolerance: assertion.tolerance,
      maxAbsError: 0,
      maxToleranceRatio: 0,
      referenceRequirement: assertion.reference_requirement,
      reasonCode: null,
    }

const syntheticVitestReport = () => ({
  success: true,
  numTotalTestSuites: 4,
  numPassedTestSuites: 4,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTotalTests: 18,
  numPassedTests: 18,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: [
    {
      name: '/repository/scripts/baseline-replay-reactive.test.ts',
      status: 'passed',
      assertionResults: EXPECTED_BASELINE_REPLAY_FIXTURE_IDS.slice(0, 9).map((id) => ({
        title: `[${id}] development fixture`,
        status: 'passed',
        failureMessages: [],
      })),
    },
    {
      name: '/repository/scripts/baseline-replay-bayesian.test.ts',
      status: 'passed',
      assertionResults: EXPECTED_BASELINE_REPLAY_FIXTURE_IDS.slice(9).map((id) => ({
        title: `[${id}] development fixture`,
        status: 'passed',
        failureMessages: [],
      })),
    },
  ],
})

const scientificDecision = {
  direction: { x: 1, y: 0 },
  speedScale: null,
  estimate: null,
  confidence: 0.5,
  phase: 'fixture',
  nativeTerminated: null,
  nativeAbstained: null,
  terminationReason: null,
  activeSniff: null,
  quadSniff: null,
  debug: null,
}

const syntheticCapturedFixtures = () => EXPECTED_BASELINE_REPLAY_FIXTURE_IDS.map((fixtureId) => {
  const specification = catalogue.fixtures.get(fixtureId)!
  const output = { sequence: 1, label: 'primary', decision: scientificDecision, scientificDecision }
  return {
    fixtureId,
    specification,
    output: {
      outputs: [output],
      subtraces: [
        { label: 'duplicate-reset-replay', outputs: [output] },
        { label: 'different-held-out-source', outputs: [output] },
      ],
    },
  }
})

describe('baseline replay evidence schema and normalization', () => {
  it('freezes 18 fixtures, 54 fixture assertions, and 6 bundle assertions', () => {
    expect([...catalogue.fixtures.keys()]).toEqual(EXPECTED_BASELINE_REPLAY_FIXTURE_IDS)
    expect([...catalogue.fixtures.values()].reduce(
      (total, fixture) => total + fixture.assertions.size,
      0,
    )).toBe(54)
    expect(catalogue.commonAssertions.size).toBe(6)
  })

  it('requires every fixture assertion exactly once with protocol-exact metadata', () => {
    const specification = catalogue.fixtures.get('C1')!
    const records = [...specification.assertions.values()].map(passingRecord)
    expect(validateFixtureAssertions('C1', records, specification)).toEqual({
      fixtureVerdict: 'pass',
      requiredPass: 4,
      requiredFail: 0,
      requiredNotExecutable: 0,
    })

    const missing = records.slice(1)
    expect(() => validateFixtureAssertions('C1', missing, specification)).toThrow(
      /assertion catalogue mismatch/i,
    )
    const mismatched = structuredClone(records)
    mismatched[0]!.comparison = 'edited-comparison'
    expect(() => validateFixtureAssertions('C1', mismatched, specification)).toThrow(
      /differs from/i,
    )
  })

  it('keeps failure, unavailability, evidence tier, and promotion logically separate', () => {
    expect(computeFixtureSummary([
      { required: true, status: 'pass' },
      { required: true, status: 'not-executable' },
    ])).toMatchObject({ fixtureVerdict: 'not-executable' })
    expect(computeFixtureSummary([
      { required: true, status: 'fail' },
      { required: true, status: 'not-executable' },
    ])).toMatchObject({ fixtureVerdict: 'fail' })
  })

  it('requires one uniquely prefixed Vitest harness result per fixture', () => {
    expect(validateVitestFixtureReport(syntheticVitestReport()).size).toBe(18)
    const duplicate = syntheticVitestReport()
    duplicate.testResults[0]!.assertionResults.push({
      ...duplicate.testResults[0]!.assertionResults[0]!,
    })
    expect(() => validateVitestFixtureReport(duplicate)).toThrow(/duplicates fixture/i)
    const unsuccessful = syntheticVitestReport()
    unsuccessful.success = false
    expect(() => validateVitestFixtureReport(unsuccessful)).toThrow(/successful run/i)
    const failedSuite = syntheticVitestReport()
    failedSuite.testResults[0]!.status = 'failed'
    expect(() => validateVitestFixtureReport(failedSuite)).toThrow(/has status failed/i)
  })

  it('computes common invariants but leaves undeclared matrix/evaluator prerequisites unavailable', () => {
    const common = buildBundleAssertions(
      syntheticCapturedFixtures(),
      catalogue.commonAssertions,
    )
    expect(common.assertions.map((assertion) => `${assertion.id}:${assertion.status}`)).toEqual([
      'COM-01:pass',
      'COM-02:pass',
      'COM-03:pass',
      'COM-04:pass',
      'COM-05:not-executable',
      'COM-06:not-executable',
    ])
    expect(common.summary).toMatchObject({
      fixtureVerdict: 'not-executable',
      requiredPass: 4,
      requiredNotExecutable: 2,
    })
  })

  it('uses finite ASCII-stable semantic JSON and excludes operational timestamps from content digests', () => {
    expect(stableReplayJson({ z: -0, a: [1.2345678901234567] })).toBe(
      stableReplayJson({ a: [1.2345678901234567], z: 0 }),
    )
    expect(contentSha256({ generatedAtUtc: 'first', value: 1 })).toBe(
      contentSha256({ generatedAtUtc: 'second', value: 1 }),
    )
    expect(() => stableReplayJson({ invalid: Number.NaN })).toThrow(/non-finite/i)
  })

  it('rejects altered held-out truth after evaluator-case binding', () => {
    const common = {
      schemaVersion: 'gsl-held-out-truth-v2',
      semanticJsonVersion: 'gsl-semantic-json-v1',
      runId: 'unit-run',
      captureBindingSchemaVersion: 'gsl-baseline-replay-capture-binding-v1',
      captureBindingSha256: 'a'.repeat(64),
      fixtureId: 'C1',
      records: [{
        truthId: 'truth-a',
        truthClass: 'source-present',
        source: { x: 0.2, y: 0.3 },
        prespecifiedBasis: 'unit test',
      }],
      controllerFacingArtifactsExcluded: true,
    }
    const digest = sha256Bytes(stableReplayJson(common))
    const heldOutTruth = { ...common, heldOutTruthBindingSha256: digest }
    const evaluatorCases = {
      schemaVersion: 'gsl-baseline-replay-evaluator-cases-v2',
      heldOutTruthBindingSha256: digest,
    }
    expect(validateHeldOutTruthBinding({
      fixtureId: 'C1', evaluatorCases, heldOutTruth,
    })).toBe(digest)
    const alteredTruth = structuredClone(heldOutTruth)
    alteredTruth.records[0]!.source.x = 0.9
    expect(() => validateHeldOutTruthBinding({
      fixtureId: 'C1', evaluatorCases, heldOutTruth: alteredTruth,
    })).toThrow(/does not match its content/i)
  })

  it('verifies the exact detached archive inventory and rejects byte tampering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'baseline-replay-checksum-test-'))
    try {
      const bytes = Buffer.from('exact replay artifact\n')
      await writeFile(join(directory, 'artifact.txt'), bytes)
      await writeFile(
        join(directory, 'SHA256SUMS'),
        `${sha256Bytes(bytes)}  artifact.txt\n`,
      )
      await expect(verifyBaselineReplayChecksumManifest(directory)).resolves.toMatchObject({
        checksummedFileCount: 1,
      })
      await writeFile(join(directory, 'artifact.txt'), 'tampered\n')
      await expect(verifyBaselineReplayChecksumManifest(directory)).rejects.toThrow(
        /SHA-256 mismatch/i,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
