import { expect, it } from 'vitest'
import { normalizeGslDesign, GSL_REFERENCE_DESIGN, timeConstantFromT10T90,
  tubeTransportSeconds, hemisphericalSuctionVelocity, hemisphericalRequiredFlow,
  conservativeBurstDwell } from './lib/gsl-dimensional-design'

it('preserves physical device timing when only site size changes', () => {
  const large = normalizeGslDesign(GSL_REFERENCE_DESIGN)
  const small = normalizeGslDesign({ ...GSL_REFERENCE_DESIGN, domainMetres: 1 })
  expect(small.domainRatios.inletSpacing).toBeCloseTo(100 * large.domainRatios.inletSpacing)
  expect(small.derived.tubeDelaySeconds).toBeCloseTo(large.derived.tubeDelaySeconds)
  expect(small.localRatios.motionMemoryToPlumeFeature).toBeCloseTo(large.localRatios.motionMemoryToPlumeFeature)
})
it('roundtrips length and time normalization without scaling the head to the map', () => {
  const result = normalizeGslDesign(GSL_REFERENCE_DESIGN)
  expect(result.domainRatios.inletSpacing * result.scales.lengthMetres).toBeCloseTo(0.10)
  expect(result.domainRatios.sensorTimeConstant * result.scales.timeSeconds).toBeCloseTo(2 / Math.log(9))
  expect(result.domainRatios.peclet).toBeNull()
})
it('computes tube volume/flow delay and the first-order response convention', () => {
  expect(tubeTransportSeconds(1, 0.002, 0.25)).toBeCloseTo(Math.PI * 0.24)
  expect(timeConstantFromT10T90(2) * Math.log(9)).toBeCloseTo(2)
  expect(conservativeBurstDwell(Math.PI * 0.24, timeConstantFromT10T90(2), 1, 8)).toBeLessThan(12)
})
it('checks inverse-square suction scaling and inverts the flow calculation', () => {
  expect(hemisphericalSuctionVelocity(2, 2)).toBeCloseTo(hemisphericalSuctionVelocity(2, 1) / 4, 12)
  expect(hemisphericalSuctionVelocity(hemisphericalRequiredFlow(9.75, 0.1), 9.75)).toBeCloseTo(0.1)
})
it('represents stopped motion without pretending sensor memory disappears', () => {
  const stopped = normalizeGslDesign({ ...GSL_REFERENCE_DESIGN, robotSpeedMetresPerSecond: 0 })
  expect(stopped.localRatios.motionMemoryToPlumeFeature).toBe(0)
  expect(stopped.derived.memoryCentroidSeconds).toBeGreaterThan(0)
  expect(stopped.derived.steadyStepInspectionRateHz).toBeNull()
})
it('rejects undefined nondimensional scales and invalid plumbing', () => {
  expect(() => normalizeGslDesign({ ...GSL_REFERENCE_DESIGN, referenceWindMetresPerSecond: 0 })).toThrow()
  expect(() => tubeTransportSeconds(1, 0.002, 0)).toThrow()
  expect(() => conservativeBurstDwell(0, 1, 1, 0)).toThrow()
})
