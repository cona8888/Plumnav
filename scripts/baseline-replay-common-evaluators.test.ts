import { describe, expect, it } from 'vitest'
import { evaluateDeclaredReplayCases } from './baseline-replay-common-evaluators.mjs'

const decision = (nativeTerminated: boolean) => ({
  direction: { x: nativeTerminated ? 0 : 1, y: 0 },
  speedScale: null,
  estimate: { x: 0.4, y: 0.6 },
  confidence: 0.8,
  phase: nativeTerminated ? 'DECLARED' : 'SEARCH',
  nativeTerminated,
  nativeAbstained: null,
  terminationReason: null,
  activeSniff: null,
  quadSniff: null,
  debug: null,
})

const input = (wind: { x: number; y: number }) => ({
  time: 1,
  dt: 0.25,
  position: { x: 0.4, y: 0.6 },
  heading: 0,
  distance: 0,
  measurement: {
    time: 1,
    concentration: 1,
    hit: true,
    wind,
    valid: true,
    sampleMode: 'passive',
  },
  observations: [{
    time: 1,
    position: { x: 0.4, y: 0.6 },
    concentration: 1,
    hit: true,
    wind,
    valid: true,
    sampleMode: 'passive',
  }],
})

const makeFixture = () => {
  const environment = {
    controllerSeed: 1,
    functions: { expectedHitRate: { id: 'rate-a' }, safeDirection: { id: 'safe-a' } },
  }
  const primaryInputs = [input({ x: 0, y: 0 }), { ...input({ x: 0, y: 0 }), time: 2 }]
  const primaryDecisions = [decision(false), decision(true)]
  const endpoint = (label: string, inputs: typeof primaryInputs, outputs = primaryDecisions) => {
    const frozenInputs = JSON.parse(JSON.stringify(inputs)) as typeof primaryInputs
    const frozenOutputs = JSON.parse(JSON.stringify(outputs)) as typeof primaryDecisions
    return ({
    trace: {
      label,
      environment,
      steps: frozenInputs.map((item, index) => ({ sequence: index + 1, label: `${label}-${index}`, input: item })),
    },
    output: {
      label,
      outputs: frozenOutputs.map((item, index) => ({
        sequence: index + 1,
        label: `${label}-${index}`,
        scientificDecision: item,
      })),
    },
  })}
  const duplicate = endpoint('duplicate', primaryInputs)
  const held = endpoint('truth-peer', primaryInputs)
  const mutantInputs = [input({ x: 1, y: 0 }), { ...input({ x: 1, y: 0 }), time: 2 }]
  const mutant = endpoint('wind-mutant', mutantInputs)
  return {
    fixtureId: 'C1',
    runId: 'test-run',
    specification: { algorithmId: 'coverage' },
    trace: {
      environment,
      steps: primaryInputs.map((item, index) => ({ sequence: index + 1, label: `p-${index}`, input: item })),
      subtraces: [duplicate.trace, held.trace, mutant.trace],
    },
    output: {
      outputs: primaryDecisions.map((item, index) => ({
        sequence: index + 1,
        label: `p-${index}`,
        scientificDecision: item,
      })),
      subtraces: [duplicate.output, held.output, mutant.output],
    },
    heldOutTruth: {
      records: [
        { truthId: 'truth-a', truthClass: 'source-present', source: { x: 0.4, y: 0.6 } },
        { truthId: 'truth-b', truthClass: 'source-present', source: { x: 0.8, y: 0.2 } },
      ],
    },
    evaluatorCases: {
      cases: [
        {
          caseId: 'com03', assertionId: 'COM-03', role: 'held-out-truth-pair',
          primaryEndpoint: 'primary', peerEndpoint: 'truth-peer',
          primaryResetOrdinal: 1, peerResetOrdinal: 3,
          primaryTruthId: 'truth-a', peerTruthId: 'truth-b',
        },
        {
          caseId: 'com04', assertionId: 'COM-04', role: 'fresh-reset-duplicate',
          primaryEndpoint: 'primary', peerEndpoint: 'duplicate',
          primaryResetOrdinal: 1, peerResetOrdinal: 2, freshControllerInstances: true,
        },
        {
          caseId: 'com05', assertionId: 'COM-05', role: 'ignored-field-metamorphic',
          primaryEndpoint: 'primary', peerEndpoint: 'wind-mutant',
          primaryResetOrdinal: 1, peerResetOrdinal: 4, ignoredField: 'measured-wind',
        },
        {
          caseId: 'com06', assertionId: 'COM-06', role: 'held-out-terminal-evaluation',
          terminalEndpoint: 'primary', truthId: 'truth-a', localizationThreshold: 0.05,
        },
      ],
    },
  }
}

const informationMatrix = { coverage: { ignored: ['measured-wind'] } }

describe('explicit Phase 5 common evaluators', () => {
  it('passes explicit reset, truth, ignored-wind, and terminal cases', () => {
    const result = evaluateDeclaredReplayCases([makeFixture()], informationMatrix)
    expect([result.com03.status, result.com04.status, result.com05.status, result.com06.status])
      .toEqual(['pass', 'pass', 'pass', 'pass'])
  })

  it('fails an unchanged ignored-field mutant instead of counting it as coverage', () => {
    const fixture = makeFixture()
    const mutant = fixture.trace.subtraces.find((item) => item.label === 'wind-mutant')!
    mutant.steps = fixture.trace.steps.map((step) => ({ ...step }))
    const result = evaluateDeclaredReplayCases([fixture], informationMatrix)
    expect(result.com05.status).toBe('fail')
    expect(result.com05.details.cases[0].checks.declaredMutationOccurred).toBe(false)
  })

  it('fails visible-input truth-peer tampering and held-out terminal mislocalization', () => {
    const fixture = makeFixture()
    const held = fixture.trace.subtraces.find((item) => item.label === 'truth-peer')!
    held.steps[0].input.position.x = 0.41
    fixture.heldOutTruth.records[0].source = { x: 0.9, y: 0.9 }
    const result = evaluateDeclaredReplayCases([fixture], informationMatrix)
    expect(result.com03.status).toBe('fail')
    expect(result.com06.status).toBe('fail')
    expect(result.com06.details.cases[0].classificationCorrect).toBe(true)
    expect(result.com06.details.cases[0].withinThreshold).toBe(false)
  })
})
