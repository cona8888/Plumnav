import { estimateQuadGradient } from '../../src/sim/algorithms/quadSoilSniff'
import type { ResearchTraceRow } from './research-recorder'
import type { SimulationConfig } from '../../src/sim/types'

/** Readout-only retrospective diagnostics. Does not supply truth to a controller. */
export function auditAcquisitionReturns(trace: ResearchTraceRow[], config: SimulationConfig) {
  return trace.filter(row => row.measurement.quadSniff?.readings?.length).map(row => {
    const status = row.measurement.quadSniff!
    const g = estimateQuadGradient(status.readings!, config.sensorNoise, config.localInletSampling?.gradientEstimator)
    const formation = row.decision.quadDeclarationEvidence?.candidateFormation
    return { time: row.inputTimeSeconds, position: row.inputPosition, mean: g.commonMean,
      contrast: g.normalizedContrast, snr: g.gradientSnr, quality: g.quality,
      validDirection: g.validDirection, direction: g.direction,
      signalEligible: g.validDirection && g.commonMean >= 0.16 && g.quality >= 0.08,
      rayPoolCount: formation?.gradientRayPoolCount ?? null,
      provisionalRayCount: formation?.provisionalRayCount ?? null,
      candidate: formation?.provisionalCandidate ?? null }
  })
}
