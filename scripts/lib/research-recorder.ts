import type { SimulationEngine } from '../../src/sim/engine'
import type { MetricSnapshot, SimulationFrame } from '../../src/sim/types'

export type ResearchTraceRow = {
  inputTimeSeconds: number
  inputPosition: SimulationFrame['robot']['position']
  inputHeading: number
  outputTimeSeconds: number
  outputPosition: SimulationFrame['robot']['position']
  measurement: SimulationFrame['measurement']
  decision: SimulationFrame['decision']
}

/** One record per controller tick; no private source or plume truth in a record. */
export function recordResearchRun(engine: SimulationEngine) {
  const trace: ResearchTraceRow[] = []
  while (!engine.isCompleted()) {
    const before = engine.getFrame()
    const frame = engine.step()
    // Frozen checkpoint padding is not a fresh sample or a controller decision.
    if (before.metrics.nativeDeclaration || before.metrics.nativeAbstention) continue
    trace.push(structuredClone({
      inputTimeSeconds: before.time,
      inputPosition: before.robot.position,
      inputHeading: before.robot.heading,
      outputTimeSeconds: frame.time,
      outputPosition: frame.robot.position,
      measurement: frame.measurement,
      decision: frame.decision,
    }))
  }
  return { trace, frame: engine.getFrame() }
}

/** Compare every saved scientific metric; exclude only host computation timings. */
export function compareScientificMetrics(actual: MetricSnapshot, expected: MetricSnapshot, tolerance = 1e-10) {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new RangeError('Invalid replay tolerance')
  const mismatches: string[] = []
  const numericRoundoff: string[] = []
  const walk = (a: unknown, b: unknown, path: string) => {
    if (Object.is(a, b)) return
    if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) &&
        Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b))) {
      numericRoundoff.push(path)
      return
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>
      for (const key of new Set([...Object.keys(aa), ...Object.keys(bb)])) {
        if (!path && (key === 'meanComputeMs' || key === 'p95ComputeMs')) continue
        if (!(key in aa) || !(key in bb)) mismatches.push(`${path}.${key}`)
        else walk(aa[key], bb[key], path ? `${path}.${key}` : key)
      }
      return
    }
    mismatches.push(path)
  }
  walk(actual, expected, '')
  return { equivalent: mismatches.length === 0, exact: mismatches.length === 0 && numericRoundoff.length === 0,
    tolerance, mismatches, numericRoundoff, excludedFields: ['meanComputeMs', 'p95ComputeMs'] }
}

export function summarizeResearchTrace(trace: ResearchTraceRow[]) {
  const phases: Record<string, number> = {}
  const attempts = new Map<number, NonNullable<ResearchTraceRow['decision']['quadBracketEvidence']>>()
  let passiveHits = 0, quadReturns = 0
  for (const row of trace) {
    phases[row.decision.phase] = (phases[row.decision.phase] ?? 0) + 1
    passiveHits += Number(row.measurement.sampleMode === 'passive' && row.measurement.hit)
    quadReturns += Number(['quad-return', 'quad-passive-return'].includes(row.measurement.sampleMode))
    const bracket = row.decision.quadBracketEvidence
    // The final observed status for each startedAt, not a best-gate composite.
    if (bracket) attempts.set(bracket.startedAt, bracket)
  }
  return { controllerTicks: trace.length, passiveHits, quadReturns, phaseTicks: phases,
    bracketAttempts: [...attempts.values()].map(status => ({
      startedAt: status.startedAt, completedAt: status.completedAt, ready: status.ready,
      candidate: status.candidate, coreCount: status.coreCount, coreHits: status.coreHits,
      flankCounts: status.flankCounts, pairCount: status.pairCount,
      pairedWinFraction: status.pairedWinFraction,
      failedGatesAtLastObservation: Object.entries(status.gates).filter(([, pass]) => !pass).map(([gate]) => gate),
    })) }
}
