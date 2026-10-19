import { describe, expect, it } from 'vitest'
import {
  buildCoordinateRefinementWaypoints, evaluateQuadSpatialBracket,
  QUAD_BRACKET_POLICY, QUAD_GEOMETRY_CONDITIONED_POLICY, QUAD_REFINE_POLICY,
} from '../src/sim/algorithms/quadSoilSniff'
import { distance, rotate } from '../src/sim/math'
import { conservativeBurstDwell, GSL_REFERENCE_DESIGN, normalizeGslDesign } from './lib/gsl-dimensional-design'

const center = { x: 0.5, y: 0.5 }, wind = { x: 1, y: 0 }

/** Manufactured ideal concentrations; arrival sample is omitted as in observePassive.
 * This tests scheduling/scoring compatibility, NOT simulated algorithm efficacy.
 * One second is allowed between dwells; every point is reached exactly.
 */
function idealTraverse(dwell: number) {
  return buildCoordinateRefinementWaypoints(center, wind, 1).flatMap((position, index) =>
    Array.from({ length: Math.round(dwell / 0.25) }, (_, j) => ({
      time: index * (dwell + 1) + (j + 1) * 0.25,
      position, concentration: distance(position, center) < 1e-9 ? 1 : 0.2, hit: true,
    })))
}
const evaluate = (samples: ReturnType<typeof idealTraverse>, basis = wind) => evaluateQuadSpatialBracket(
  samples, center, basis, 0, QUAD_REFINE_POLICY.offsetNormalized, QUAD_REFINE_POLICY.zoneRadiusNormalized,
)

describe('M72 diagnostics of the unchanged M71 confirmation contract', () => {
  it('cannot obtain two filtered flank samples in a nominal 0.75 s dwell after the excluded arrival tick', () => {
    const status = evaluate(idealTraverse(QUAD_REFINE_POLICY.dwellSeconds))
    expect(status.flankCounts.filter(count => count >= QUAD_BRACKET_POLICY.minimumFlankSamplesPerDirection)).toHaveLength(0)
    expect(status.pairCount).toBe(3)
    expect(status.ready).toBe(false)
  })
  it('admits a positive manufactured witness with enough dwell and unchanged evidence thresholds', () => {
    const status = evaluate(idealTraverse(1))
    expect(status.flankCounts.filter(count => count >= 2)).toHaveLength(3)
    expect(status.pairCount).toBe(6)
    expect(status.ready).toBe(true)
    // A numerical witness, not a recommendation of one-second physical dwell.
  })
  it('loses flank coverage if a completed traverse is re-binned against a rotated wind basis', () => {
    const samples = idealTraverse(1)
    expect(evaluate(samples).ready).toBe(true)
    expect(evaluate(samples, rotate(wind, Math.PI / 4)).flankCounts).toEqual([0, 0, 0, 0])
  })
  it('can declare arrival outside every applicable confirmation scoring zone', () => {
    const radius = (QUAD_GEOMETRY_CONDITIONED_POLICY.confirmationArrivalRadiusNormalized +
      QUAD_REFINE_POLICY.zoneRadiusNormalized) / 2
    expect(radius).toBeLessThan(QUAD_GEOMETRY_CONDITIONED_POLICY.confirmationArrivalRadiusNormalized)
    const position = { x: center.x + radius / Math.SQRT2, y: center.y + radius / Math.SQRT2 }
    const sample = { time: 1, position, concentration: 1, hit: true }
    expect(evaluate([sample])).toMatchObject({ coreCount: 0, flankCounts: [0, 0, 0, 0] })
  })
  it('keeps physical settling separate from the ideal no-memory timing witness', () => {
    const p = GSL_REFERENCE_DESIGN
    const normalized = normalizeGslDesign(p)
    const minimum = conservativeBurstDwell(normalized.derived.tubeDelaySeconds,
      p.sensorTimeConstantSeconds, p.sampleIntervalSeconds, 2)
    expect(minimum).toBeGreaterThan(5)
    expect(minimum).toBeLessThan(p.dwellSeconds)
    expect(minimum).toBeGreaterThan(QUAD_REFINE_POLICY.dwellSeconds)
  })
})
