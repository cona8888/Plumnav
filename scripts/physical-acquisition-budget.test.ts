import { expect, it } from 'vitest'
import { createDefaultConfig } from '../src/sim/config'
import { withLocalInletDesign } from '../src/sim/localInletSampling'
import { GSL_REFERENCE_DESIGN } from '../src/sim/physicalDesign'
import { physicalAcquisitionBudget, requirePhysicalAcquisitionBudget } from './lib/physical-acquisition-budget'

const config = () => withLocalInletDesign({ ...createDefaultConfig('quad-sniff-refine', 'open'), durationSeconds: 120 },
  GSL_REFERENCE_DESIGN, { recoveryTimeConstantSeconds: 2, maximumTurnRateRadiansPerSecond: Math.PI / 4 })
it('finds both time inconsistencies in the M73/M74 physical reference', () => {
  const audit = physicalAcquisitionBudget(config())
  expect(audit.minimumPoseSeparationMetres).toBeCloseTo(1.8)
  expect(audit.optimisticTotalSeconds).toBeCloseTo(156)
  expect(audit.minimumConfirmationDwellSeconds).toBe(84)
  expect(audit.rayRetentionSeconds).toBe(75)
  expect(audit.issues).toHaveLength(2)
  expect(() => requirePhysicalAcquisitionBudget(config())).toThrow(/preflight/)
})
it('does not treat a longer mission alone as a cure for evidence expiry', () => {
  const audit = physicalAcquisitionBudget({ ...config(), durationSeconds: 600 })
  expect(audit.issues).toEqual(['unrefreshed-rays-expire-before-seven-dwell-confirmation'])
})
it('does not claim a result outside the audited policy and environment', () => {
  expect(() => physicalAcquisitionBudget({ ...config(), algorithmId: 'quad-passive' })).toThrow()
  expect(() => physicalAcquisitionBudget({ ...config(), scenarioKind: 'obstructed' })).toThrow()
})
it('requires a long enough mission even with a bounded prior and a runtime budget', () => {
  const c = config()
  c.localInletSampling!.candidateLifecycle = 'bounded-inspection-v1'
  expect(physicalAcquisitionBudget(c).issues).toEqual(['mission-shorter-than-optimistic-end-to-end-lower-bound'])
  expect(requirePhysicalAcquisitionBudget({ ...c, durationSeconds: 600 }).requiresRuntimeInspectionBudget).toBe(true)
})
