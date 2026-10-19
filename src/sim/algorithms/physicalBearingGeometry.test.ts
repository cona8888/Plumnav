import { describe, expect, it } from 'vitest'
import { physicalBearingIntersection } from './physicalBearingGeometry'
import type { GradientRay } from './quadSoilSniff'
import { createDefaultConfig, validateSimulationConfig } from '../config'
import { withLocalInletDesign } from '../localInletSampling'
import { GSL_REFERENCE_DESIGN } from '../physicalDesign'

function rays(domain = 100, noise = 0.01): GradientRay[] {
  return [[-0.4, -0.3], [0.4, -0.3], [0, 0.5], [-0.5, 0.1]].map(([x, y]) => {
    const r = Math.hypot(x!, y!)
    return { time: 0, origin: { x: 0.5 + x! / domain, y: 0.5 + y! / domain },
      direction: { x: -x! / r, y: -y! / r }, weight: 1, angularSigma: noise }
  })
}
describe('conditional physical bearing uncertainty', () => {
  it('recovers intersecting bearings and retains physical uncertainty across coordinate scales', () => {
    const values = [1, 100, 1000, 100000].map(domain => {
      const fit = physicalBearingIntersection(rays(domain), 0.1 / domain, 0.1 / domain)!
      expect(fit.point.x).toBeCloseTo(0.5, 10)
      expect(fit.point.y).toBeCloseTo(0.5, 10)
      expect(fit.physicalUncertainty!.acceptable).toBe(true)
      return fit.physicalUncertainty!.nominalRadius95 * domain
    })
    for (const radius of values) expect(radius).toBeCloseTo(values[0]!, 8)
  })
  it('widens uncertainty with angular noise instead of rewarding mere pose span', () => {
    const a = physicalBearingIntersection(rays(100, 0.01), 0.001, 0.001)!
    const b = physicalBearingIntersection(rays(100, 0.1), 0.001, 0.001)!
    expect(b.physicalUncertainty!.nominalRadius95 / a.physicalUncertainty!.nominalRadius95).toBeCloseTo(10)
    expect(b.quality).toBeLessThan(a.quality)
  })
  it('rejects parallel, backward and underdetermined observations', () => {
    expect(physicalBearingIntersection(rays().slice(0, 2), 0.001, 0.001)).toBeNull()
    expect(physicalBearingIntersection(rays().map(r => ({ ...r, direction: { x: 1, y: 0 } })), 0.001, 0.001)).toBeNull()
    expect(physicalBearingIntersection(rays().map(r => ({ ...r,
      direction: { x: -r.direction.x, y: -r.direction.y } })), 0.001, 0.001)).toBeNull()
  })
  it('requires explicit finite angular uncertainty and does not mutate measurements', () => {
    const data = rays(), before = structuredClone(data)
    physicalBearingIntersection(data, 0.001, 0.001)
    expect(data).toEqual(before)
    expect(physicalBearingIntersection(data.map(r => ({ ...r, angularSigma: undefined })), 0.001, 0.001)).toBeNull()
    expect(physicalBearingIntersection(data, 0, 0.001)).toBeNull()
  })
  it('does not accept an uncertain estimate merely because the nominal lines intersect', () => {
    const fit = physicalBearingIntersection(rays(100, 0.3), 0.001, 0.001)!
    expect(fit.physicalUncertainty!.acceptable).toBe(false)
  })
  it('requires relative local gradients and the timed physical acquisition policy', () => {
    const c = withLocalInletDesign(createDefaultConfig('quad-sniff-refine', 'open'), GSL_REFERENCE_DESIGN,
      { recoveryTimeConstantSeconds: 2, maximumTurnRateRadiansPerSecond: Math.PI / 4 })
    c.localInletSampling!.bearingGeometry = 'linearized-local-bearing-v1'
    expect(() => validateSimulationConfig(c)).toThrow(/Physical bearing geometry/)
  })
})
