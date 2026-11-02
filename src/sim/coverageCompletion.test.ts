import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config'
import { SimulationEngine } from './engine'
import { evaluateArchivedLeakRun } from './researchEvaluation'

// A full simulated sweep, including sensing, motion and terminal scoring.
describe('limits of location evidence', () => {
  it.each(['absent', 'emitting'] as const)('finishes a coverage survey without certifying a %s source', targetStatus => {
    const config = { ...createDefaultConfig('coverage', 'open'), targetStatus, durationSeconds: 300, checkpointSeconds: [300] }
    const frame = new SimulationEngine(config).runToCompletion()
    expect(frame.decision.phase).toBe('COVERAGE COMPLETE')
    expect(frame.decision.estimateRole).toBe('sampled-peak')
    expect(frame.decision.estimate).not.toBeNull()
    expect(frame.metrics.nativeDeclaration).toBe(false)
    expect(frame.metrics.terminalOutcome).toBe('unresolved-survey')
    expect(frame.metrics.correctRejection).toBeNull()
    expect(frame.metrics.correctAbstention).toBe(false)
    expect(evaluateArchivedLeakRun(config, frame.metrics, frame.scenario.source).outcome).toBe('unresolved-abstention')
  })
  it('labels Infotaxis navigation hypotheses until the first measured hit', () => {
    const config = { ...createDefaultConfig('infotaxis', 'open'), targetStatus: 'absent' as const, sensorNoise: 0 }
    const engine = new SimulationEngine(config)
    const frame = engine.step()
    expect(frame.decision.estimateRole).toBe('model-only')
    expect(frame.metrics.nativeDeclaration).toBe(false)
  })
})
