import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config'
import { SimulationEngine } from './engine'
import { evaluateArchivedLeakRun, evaluateLeakDecision, type LeakDecision, type LeakTruth } from './researchEvaluation'

const truth: LeakTruth = { geometricSource: { x: 0.5, y: 0.5 }, activeEmission: true, detectability: 'unknown' }
const score = (decision: LeakDecision, overrides = {}) => evaluateLeakDecision({
  truth, decision, elapsedSeconds: 180, deadlineSeconds: 180, toleranceNormalized: 0.01, ...overrides,
})

describe('active leak decision contract', () => {
  it('scores declared position, not final proximity or a missing estimate', () => {
    expect(score({ kind: 'none' }).outcome).toBe('unresolved-deadline')
    expect(score({ kind: 'declare', timeSeconds: 7, estimate: { x: 0.505, y: 0.5 } }).outcome).toBe('correct-localization')
    expect(score({ kind: 'declare', timeSeconds: 7, estimate: null }).outcome).toBe('wrong-localization')
    expect(score({ kind: 'declare', timeSeconds: 7, estimate: { x: NaN, y: 0 } }).outcome).toBe('wrong-localization')
  })
  it.each([null, { x: 0.5, y: 0.5 }])('treats no active emission as no leak regardless of geometric target %j', geometricSource => {
    const blank = { ...truth, geometricSource, activeEmission: false }
    expect(score({ kind: 'declare', timeSeconds: 2, estimate: geometricSource }, { truth: blank }).outcome).toBe('false-leak-declaration')
    expect(score({ kind: 'none' }, { truth: blank }).outcome).toBe('unresolved-deadline')
    expect(score({ kind: 'no-leak', timeSeconds: 2 }, { truth: blank }).outcome).toBe('unresolved-abstention')
  })
  it('requires an independently accepted survey evidence ID for a supported rejection', () => {
    const decision = { kind: 'no-leak', timeSeconds: 100, evidenceId: 'fixture-survey-1' } as const
    expect(score(decision).outcome).toBe('unresolved-abstention')
    expect(score(decision, { acceptedRejectionEvidenceIds: ['different-survey'] }).outcome).toBe('unresolved-abstention')
    expect(score(decision, { acceptedRejectionEvidenceIds: ['fixture-survey-1'] }).outcome).toBe('false-rejection')
    expect(score(decision, { truth: { ...truth, activeEmission: false },
      acceptedRejectionEvidenceIds: ['fixture-survey-1'] }).outcome).toBe('supported-no-leak')
  })
  it('does not convert undetectability or non-detection into no-leak truth', () => {
    expect(score({ kind: 'none' }, { truth: { ...truth, detectability: 'validated-undetectable' } }).outcome).toBe('unresolved-deadline')
  })
  it('separates terminal competing events from deadline censoring and uses event time', () => {
    const failed = score({ kind: 'declare', timeSeconds: 20, estimate: { x: 0.1, y: 0.1 } })
    expect(failed).toMatchObject({ observedTimeSeconds: 20, administrativeCensoring: false, competingEvent: true })
    expect(score({ kind: 'none' })).toMatchObject({ observedTimeSeconds: 180, administrativeCensoring: true, competingEvent: false })
    expect(score({ kind: 'none' }, { elapsedSeconds: 10 }).outcome).toBe('pending')
  })
  it('rejects inconsistent truth and time', () => {
    expect(() => score({ kind: 'none' }, { truth: { ...truth, geometricSource: null } })).toThrow()
    expect(() => score({ kind: 'declare', timeSeconds: 181, estimate: null })).toThrow()
    expect(() => score({ kind: 'none' }, { toleranceNormalized: NaN })).toThrow()
  })
  it.each(['emitting', 'zero-emission', 'absent'] as const)('integrates with engine checkpoints without changing native %s metrics', targetStatus => {
    const config = { ...createDefaultConfig('coverage', 'open'), targetStatus, durationSeconds: 1,
      checkpointSeconds: [1], stopOnNativeDeclaration: false }
    const engine = new SimulationEngine(config)
    // Scripted decision witness, not a test of controller performance.
    engine.controller.step = () => ({ direction: { x: 1, y: 0 }, estimate: engine.scenario.source,
      confidence: 1, phase: 'EVALUATOR WITNESS', nativeTerminated: true })
    while (!engine.isCompleted()) engine.step()
    const metrics = engine.getFrame().checkpoints[1]!
    const original = JSON.stringify(metrics)
    const evaluated = evaluateArchivedLeakRun(config, metrics, engine.scenario.source)
    expect(evaluated.outcome).toBe(targetStatus === 'emitting' ? 'correct-localization' : 'false-leak-declaration')
    expect(evaluated.eventTimeSeconds).toBe(0)
    expect(metrics.pathLengthNormalized).toBe(0)
    expect(JSON.stringify(metrics)).toBe(original)
    if (targetStatus === 'zero-emission') expect(metrics.terminalOutcome).toBe('correct-declaration')
  })
})
