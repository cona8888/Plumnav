import { tubeTransportSeconds } from '../../src/sim/physicalDesign'
import type { SimulationConfig } from '../../src/sim/types'

/** Characteristic ratios, not confidence scores or sufficient acceptance gates.
 * Feature length is supplied independently of the domain and source width.
 */
export function siScaleAnalysis(config: SimulationConfig, featureMetres: number, variationPeriodSeconds?: number) {
  const p = config.localInletSampling
  if (!p || !Number.isFinite(featureMetres) || featureMetres <= 0 ||
      (variationPeriodSeconds !== undefined && (!Number.isFinite(variationPeriodSeconds) || variationPeriodSeconds <= 0))) {
    throw new RangeError('Local SI sensing and positive feature/period scales required')
  }
  const L = config.domainMeters, U = p.referenceWindMetresPerSecond, v = config.robotSpeed * L
  const D = config.physicalAtmosphere?.diffusivityMetresSquaredPerSecond ?? p.effectiveDiffusivityMetresSquaredPerSecond
  const b = p.opposingInletSpacingMetres, ell = featureMetres, sample = p.sampleIntervalSeconds
  const delay = tubeTransportSeconds(p.tubeLengthMetres, p.tubeInnerDiameterMetres, p.flowLitresPerMinutePerChannel)
  const riseMemory = delay + p.riseTimeConstantSeconds + p.averagingSeconds / 2
  const recoveryMemory = delay + p.recoveryTimeConstantSeconds + p.averagingSeconds / 2
  const dwell = p.inspection.dwellSeconds, offset = p.inspection.offsetNormalized * L
  const circuitLowerBound = v > 0 ? 9 * dwell + 8 * offset / v : null
  return {
    version: 'si-scale-analysis-v1', featureMetres: ell,
    quantities: { domainMetres: L, windMetresPerSecond: U, robotMetresPerSecond: v,
      diffusivityMetresSquaredPerSecond: D ?? null, tubeDelaySeconds: delay,
      riseMemorySeconds: riseMemory, recoveryMemorySeconds: recoveryMemory,
      nineVisitDwellAndTranslationLowerBoundSeconds: circuitLowerBound },
    groups: { peclet: D === undefined ? null : U * ell / D,
      domainPeclet: D === undefined ? null : U * L / D,
      headToFeature: b / ell, heightToFeature: p.inletHeightMetres / ell,
      robotToWind: U > 0 ? v / U : null,
      motionMemoryRise: v * riseMemory / ell, motionMemoryRecovery: v * recoveryMemory / ell,
      windMemoryRise: U * riseMemory / ell, windMemoryRecovery: U * recoveryMemory / ell,
      sampleTravel: v * sample / ell, engineTravel: v * config.fixedDt / ell,
      dwellAdvection: U * dwell / ell,
      dwellToVariationPeriod: variationPeriodSeconds === undefined ? null : dwell / variationPeriodSeconds,
      circuitToVariationPeriod: variationPeriodSeconds === undefined || circuitLowerBound === null ? null : circuitLowerBound / variationPeriodSeconds,
      sourceStrength: !config.physicalAtmosphere || U <= 0 ? null : config.physicalAtmosphere.emissionRateKgPerSecond /
        (config.physicalAtmosphere.measurement.concentrationScaleKgPerCubicMetre * U * ell ** 2),
      suctionToWindAtHalfSpacing: U > 0 ? p.flowLitresPerMinutePerChannel * 1e-3 / 60 /
        (2 * Math.PI * (b / 2) ** 2 * U) : null },
    interpretation: 'Prescribed feature length, not measured correlation length. Memory and budget ratios are characteristic estimates, not localisation performance.',
  }
}
