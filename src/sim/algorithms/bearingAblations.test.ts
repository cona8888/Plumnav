import { describe, expect, it } from 'vitest'
import { createDefaultConfig, validateSimulationConfig } from '../config'
import { withLocalInletDesign } from '../localInletSampling'
import { GSL_REFERENCE_DESIGN } from '../physicalDesign'
import { SimulationEngine } from '../engine'
import type { LocalInletSamplingConfig } from '../types'

function fixture(ablation?: LocalInletSamplingConfig['bearingAblation']) {
  const c = withLocalInletDesign(createDefaultConfig('quad-sniff-refine', 'open'), GSL_REFERENCE_DESIGN,
    { recoveryTimeConstantSeconds: 2, maximumTurnRateRadiansPerSecond: Math.PI / 4 })
  Object.assign(c.localInletSampling!, { gradientEstimator: 'relative-geometry-v1',
    acquisitionPolicy: 'time-budgeted-viewpoints-v1', candidateLifecycle: 'bounded-inspection-v1',
    bearingGeometry: 'linearized-local-bearing-v1', ...(ablation ? {bearingAblation:ablation} : {}) })
  const engine = new SimulationEngine(c)
  const access = engine.controller as unknown as { minimumRaySeparation(): number; trustedRayEstimate(): unknown }
  return { c, engine, access }
}
describe('explicit one-component bearing ablations', () => {
  it('changes spacing only when requested', () => {
    expect(fixture().access.minimumRaySeparation()).toBeCloseTo(0.002)
    expect(fixture('legacy-spacing').access.minimumRaySeparation()).toBe(0.018)
    expect(fixture('wind-bearing').access.minimumRaySeparation()).toBeCloseTo(0.002)
  })
  it('removes only the hard radius gate, keeping residual consistency and the soft score', () => {
    const check = (ablation: LocalInletSamplingConfig['bearingAblation'], residual: number, quality: number) => {
      const { engine, access } = fixture(ablation)
      Object.assign(engine.controller, { estimateHistory: [0, 1, 2].map(time => ({time,point:{x:0.5,y:0.5}})),
        rayEstimate: {point:{x:0.5,y:0.5},rayCount:3,quality,residual:0,
          physicalUncertainty:{acceptable:false,reducedChiSquare:residual,nominalRadius95:0.002}} })
      return access.trustedRayEstimate()
    }
    expect(check(undefined, 1, 0.5)).toBeNull()
    expect(check('no-radius-gate', 1, 0.5)).not.toBeNull()
    expect(check('no-radius-gate', 10, 0.5)).toBeNull()
    expect(check('no-radius-gate', 1, 0.1)).toBeNull()
  })
  it('requires the physical model and leaves the reference flag absent', () => {
    const { c, engine } = fixture()
    expect(engine.environment.bearingAblation).toBeUndefined()
    c.localInletSampling!.bearingAblation = 'legacy-spacing'
    delete c.localInletSampling!.bearingGeometry
    expect(() => validateSimulationConfig(c)).toThrow(/Bearing ablations/)
  })
})
