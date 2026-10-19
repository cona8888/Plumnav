/** SI-to-dimensionless design calculation, shared by research adapters and reports. */
export type GslPhysicalDesign = {
  domainMetres: number; referenceWindMetresPerSecond: number;
  robotLengthMetres: number; robotWidthMetres: number;
  opposingInletSpacingMetres: number; inletHeightMetres: number;
  robotSpeedMetresPerSecond: number; sampleIntervalSeconds: number;
  sensorTimeConstantSeconds: number; tubeLengthMetres: number; tubeInnerDiameterMetres: number;
  actualFlowLitresPerMinute: number; averagingSeconds: number;
  inspectionStepMetres: number; dwellSeconds: number;
  plumeFeatureMetres: number; effectiveDiffusivityMetresSquaredPerSecond?: number;
}
const positive = (name: string, value: number) => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive`)
}
const nonnegative = (name: string, value: number) => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`)
}
export const timeConstantFromT10T90 = (seconds: number) => {
  positive('T10-T90', seconds)
  return seconds / Math.log(9)
}
export const tubeTransportSeconds = (length: number, innerDiameter: number, actualFlowLitresPerMinute: number) => {
  nonnegative('tube length', length); positive('tube inner diameter', innerDiameter)
  positive('actual volumetric flow', actualFlowLitresPerMinute)
  return (Math.PI * innerDiameter ** 2 * length / 4) / (actualFlowLitresPerMinute * 1e-3 / 60)
}
/** Ideal hemispherical sink estimate. Not a capture guarantee or a jet model. */
export const hemisphericalSuctionVelocity = (actualFlowLitresPerMinute: number, distanceMetres: number) => {
  positive('actual volumetric flow', actualFlowLitresPerMinute); positive('distance', distanceMetres)
  return (actualFlowLitresPerMinute * 1e-3 / 60) / (2 * Math.PI * distanceMetres ** 2)
}
export const hemisphericalRequiredFlow = (distanceMetres: number, velocityMetresPerSecond: number) => {
  positive('distance', distanceMetres); positive('velocity', velocityMetresPerSecond)
  return 2 * Math.PI * distanceMetres ** 2 * velocityMetresPerSecond * 60 / 1e-3
}
/** Allow a pure tube delay, 95% first-order settling, then N complete sample intervals. */
export const conservativeBurstDwell = (tubeDelay: number, tau: number, sampleInterval: number, samples: number) => {
  nonnegative('tube delay', tubeDelay); positive('sensor time constant', tau)
  positive('sample interval', sampleInterval)
  if (!Number.isInteger(samples) || samples < 1) throw new RangeError('sample count must be a positive integer')
  return tubeDelay - Math.log(0.05) * tau + samples * sampleInterval
}
export const normalizeGslDesign = (p: GslPhysicalDesign) => {
  for (const key of ['domainMetres', 'referenceWindMetresPerSecond', 'robotLengthMetres', 'robotWidthMetres',
    'opposingInletSpacingMetres', 'inletHeightMetres', 'sampleIntervalSeconds', 'sensorTimeConstantSeconds',
    'tubeInnerDiameterMetres', 'actualFlowLitresPerMinute', 'inspectionStepMetres', 'plumeFeatureMetres'] as const)
    positive(key, p[key])
  for (const key of ['robotSpeedMetresPerSecond', 'tubeLengthMetres', 'averagingSeconds', 'dwellSeconds'] as const)
    nonnegative(key, p[key])
  if (p.effectiveDiffusivityMetresSquaredPerSecond !== undefined)
    positive('effective diffusivity', p.effectiveDiffusivityMetresSquaredPerSecond)
  const L = p.domainMetres, U = p.referenceWindMetresPerSecond, T = L / U
  const delay = tubeTransportSeconds(p.tubeLengthMetres, p.tubeInnerDiameterMetres, p.actualFlowLitresPerMinute)
  const memory = delay + p.sensorTimeConstantSeconds + p.averagingSeconds / 2
  const Pe = p.effectiveDiffusivityMetresSquaredPerSecond === undefined ? null
    : U * L / p.effectiveDiffusivityMetresSquaredPerSecond
  return { scales: { lengthMetres: L, velocityMetresPerSecond: U, timeSeconds: T },
    domainRatios: { robotLength: p.robotLengthMetres / L, robotWidth: p.robotWidthMetres / L,
      inletSpacing: p.opposingInletSpacingMetres / L, inletHeight: p.inletHeightMetres / L,
      robotSpeed: p.robotSpeedMetresPerSecond / U, sampleInterval: p.sampleIntervalSeconds / T,
      sensorTimeConstant: p.sensorTimeConstantSeconds / T, tubeDelay: delay / T,
      averagingWindow: p.averagingSeconds / T, inspectionStep: p.inspectionStepMetres / L,
      dwell: p.dwellSeconds / T, peclet: Pe, diffusionCoefficient: Pe === null ? null : 1 / Pe },
    localRatios: { heightToInletSpacing: p.inletHeightMetres / p.opposingInletSpacingMetres,
      inletSpacingToPlumeFeature: p.opposingInletSpacingMetres / p.plumeFeatureMetres,
      sampleSpacingToPlumeFeature: p.robotSpeedMetresPerSecond * p.sampleIntervalSeconds / p.plumeFeatureMetres,
      motionMemoryToPlumeFeature: p.robotSpeedMetresPerSecond * memory / p.plumeFeatureMetres,
      tauToSampleInterval: p.sensorTimeConstantSeconds / p.sampleIntervalSeconds,
      stepToInletSpacing: p.inspectionStepMetres / p.opposingInletSpacingMetres,
      suctionToReferenceWindAtHalfSpacing: hemisphericalSuctionVelocity(p.actualFlowLitresPerMinute,
        p.opposingInletSpacingMetres / 2) / U },
    derived: { tubeDelaySeconds: delay, memoryCentroidSeconds: memory,
      approximateMotionMemoryMetres: p.robotSpeedMetresPerSecond * memory,
      steadyStepInspectionRateHz: p.robotSpeedMetresPerSecond > 0
        ? 1 / (p.dwellSeconds + p.inspectionStepMetres / p.robotSpeedMetresPerSecond) : null },
    caveat: 'Tube flow is actual volumetric flow, not unconverted standard flow. Memory-centroid distance is a heuristic for uniform motion, not a resolution guarantee.' }
}

// A proposed numerical reference. Geometry/speed/feature scale are design choices.
// 1 Hz and T10-T90=2 s use the LI-7810 standard specification as a timing archetype.
// This is not a claim that four complete LI-7810 units fit on a Go2.
export const GSL_REFERENCE_DESIGN: GslPhysicalDesign = {
  domainMetres: 100, referenceWindMetresPerSecond: 1,
  robotLengthMetres: 0.70, robotWidthMetres: 0.31,
  opposingInletSpacingMetres: 0.10, inletHeightMetres: 0.05,
  robotSpeedMetresPerSecond: 0.10, sampleIntervalSeconds: 1,
  sensorTimeConstantSeconds: timeConstantFromT10T90(2),
  tubeLengthMetres: 1, tubeInnerDiameterMetres: 0.002,
  actualFlowLitresPerMinute: 0.25, averagingSeconds: 1,
  inspectionStepMetres: 0.10, dwellSeconds: 12, plumeFeatureMetres: 0.10,
}
