import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from '../config'
import { SimulationEngine } from '../engine'
import { GSL_REFERENCE_DESIGN } from '../physicalDesign'
import { withLocalInletDesign } from '../localInletSampling'
import type { AlgorithmStepInput, QuadBracketEvidenceStatus, Vec2 } from '../types'

/** Test-only access isolates the inspection state machine from acquisition.
 * The prescribed candidate and perfect position/field are NOT research results.
 */
type InspectionFixture = {
  geometryConfirmationTarget(input: AlgorithmStepInput, candidate: Vec2): Vec2
  observePassive(input: AlgorithmStepInput): void
  bracketStatus(input: AlgorithmStepInput): QuadBracketEvidenceStatus | null
  trustedRayEstimate(): unknown
  estimateStability(): unknown
  confirmationCompletedAt: number | null
  confirmationIndex: number
  shouldScan(input: AlgorithmStepInput): boolean
}
const center = { x: 0.5, y: 0.5 }
function fixture() {
  const config = withLocalInletDesign(createDefaultConfig('quad-sniff-refine', 'open'),
    GSL_REFERENCE_DESIGN, { recoveryTimeConstantSeconds: 2, maximumTurnRateRadiansPerSecond: 1 })
  const engine = new SimulationEngine(config)
  const controller = engine.controller as unknown as InspectionFixture
  controller.trustedRayEstimate = () => ({ point: center, quality: 1, residual: 0 })
  controller.estimateStability = () => ({ count: 4, span: 10, radius: 0 })
  const input = (time: number, position: Vec2, valid = true, wind = { x: 1, y: 0 }): AlgorithmStepInput => ({
    time, dt: 0.25, position, heading: 0, observations: [], distance: 0,
    measurement: { time, concentration: Math.hypot(position.x - center.x, position.y - center.y) < 1e-9 ? 1 : 0.2,
      hit: true, valid, sampleMode: 'passive', wind },
  })
  return { controller, input, config }
}

describe('opt-in settled confirmation contract', () => {
  it('completes a positive prescribed traverse with settled samples and a fixed scoring frame', () => {
    const { controller, input } = fixture()
    let target = controller.geometryConfirmationTarget(input(0, center), center)
    let last = input(0, center)
    for (let tick = 1; tick <= 800 && controller.confirmationCompletedAt === null; tick++) {
      const time = tick * 0.25
      // Perfect prescribed waypoint following isolates timing, not robot navigation.
      last = input(time, target, Number.isInteger(time), { x: Math.SQRT1_2, y: Math.SQRT1_2 })
      controller.observePassive(last)
      target = controller.geometryConfirmationTarget(last, center)
    }
    expect(controller.confirmationCompletedAt).not.toBeNull()
    const a = controller.bracketStatus({ ...last, position: center })!
    const b = controller.bracketStatus({ ...last, position: center,
      measurement: { ...last.measurement, wind: { x: -1, y: 0 } } })!
    expect(a).toEqual(b)
    expect(a.ready).toBe(true)
    expect(a.flankCounts.filter(n => n >= 2)).toHaveLength(3)
  })
  it('does not complete a waypoint just because its dwell timer expires', () => {
    const { controller, input } = fixture()
    for (let tick = 0; tick < 800; tick++) {
      const sample = input(tick * 0.25, center, false)
      controller.observePassive(sample)
      controller.geometryConfirmationTarget(sample, center)
    }
    expect(controller.confirmationIndex).toBe(0)
    expect(controller.confirmationCompletedAt).toBeNull()
    expect(controller.bracketStatus(input(200, center))!.coreCount).toBe(0)
  })
  it('keeps arrival inside the scoring zone and excludes pre-settling samples', () => {
    const { controller, input, config } = fixture()
    const c = config.localInletSampling!.inspection
    expect(c.arrivalRadiusNormalized).toBeLessThan(c.zoneRadiusNormalized)
    controller.geometryConfirmationTarget(input(0, center), center)
    expect(controller.shouldScan(input(100, center))).toBe(false)
    for (let tick = 1; tick * 0.25 < c.settlingSeconds; tick++) controller.observePassive(input(tick * 0.25, center))
    expect(controller.bracketStatus(input(c.settlingSeconds, center))!.coreCount).toBe(0)
  })
})
