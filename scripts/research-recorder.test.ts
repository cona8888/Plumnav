import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from '../src/sim/config'
import { SimulationEngine } from '../src/sim/engine'
import { compareScientificMetrics, recordResearchRun, summarizeResearchTrace } from './lib/research-recorder'

describe('research recorder', () => {
  it('retains input/output clock and position and does not invent post-terminal ticks', () => {
    const engine = new SimulationEngine({ ...createDefaultConfig('coverage', 'open'), durationSeconds: 2,
      checkpointSeconds: [2], stopOnNativeDeclaration: false })
    engine.controller.step = () => ({ direction: { x: 1, y: 0 }, estimate: null,
      phase: 'SCRIPTED STOP', confidence: 0, nativeAbstained: true })
    const { trace, frame } = recordResearchRun(engine)
    expect(trace).toHaveLength(1)
    expect(trace[0]!.inputTimeSeconds).toBe(0)
    expect(trace[0]!.measurement.time).toBe(0)
    expect(trace[0]!.outputTimeSeconds).toBe(engine.config.fixedDt)
    expect(frame.time).toBe(2)
    expect(Object.keys(trace[0]!)).not.toContain('scenario')
    expect(summarizeResearchTrace(trace).controllerTicks).toBe(1)
  })
  it('preserves every metric of a plain run and deep copies controller telemetry', () => {
    const config = { ...createDefaultConfig('quad-sniff-refine', 'open'), durationSeconds: 3,
      checkpointSeconds: [3], stopOnNativeDeclaration: false }
    const plain = new SimulationEngine(config)
    while (!plain.isCompleted()) plain.step()
    const { trace, frame } = recordResearchRun(new SimulationEngine(config))
    expect(compareScientificMetrics(frame.metrics, plain.getFrame().metrics).exact).toBe(true)
    expect(trace[0]!.decision).not.toBe(frame.decision)
    expect(trace[0]!.inputPosition).not.toBe(trace[0]!.outputPosition)
    const changed = { ...frame.metrics, hitCount: frame.metrics.hitCount + 1 }
    expect(compareScientificMetrics(changed, frame.metrics).mismatches).toContain('hitCount')
    expect(compareScientificMetrics({ ...frame.metrics, meanComputeMs: 1e9 }, frame.metrics).equivalent).toBe(true)
  })
})
