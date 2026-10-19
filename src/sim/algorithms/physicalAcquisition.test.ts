import { describe, expect, it } from 'vitest'
import { createDefaultConfig, validateSimulationConfig } from '../config'
import { SimulationEngine } from '../engine'
import { withLocalInletDesign } from '../localInletSampling'
import { GSL_REFERENCE_DESIGN } from '../physicalDesign'
import { selectPhysicalAcquisitionTarget } from './physicalAcquisition'
import type { AlgorithmStepInput, Vec2 } from '../types'

function fixture() {
  const config = withLocalInletDesign({ ...createDefaultConfig('quad-sniff-refine', 'open'),
    durationSeconds: 600 }, GSL_REFERENCE_DESIGN,
  { recoveryTimeConstantSeconds: 2, maximumTurnRateRadiansPerSecond: Math.PI / 4 })
  config.localInletSampling!.candidateLifecycle = 'bounded-inspection-v1'
  config.localInletSampling!.acquisitionPolicy = 'time-budgeted-viewpoints-v1'
  const engine = new SimulationEngine(config)
  const position = { x: 0.54, y: 0.5 }
  Object.assign(engine.controller, { gradientRays: [{ time: 14, origin: position,
    direction: { x: -1, y: 0 }, weight: 1 }], lastGradientDirection: { x: -1, y: 0 } })
  const input = (time: number, p = position): AlgorithmStepInput => ({ time, dt: 0.25,
    position: p, heading: 0, distance: 0, observations: [], measurement: { time, valid: false,
      sampleMode: 'passive', concentration: 0, hit: false, wind: { x: 1, y: 0 } } })
  const access = engine.controller as unknown as {
    timeBudgetedAcquisition(i: AlgorithmStepInput): ReturnType<typeof engine.controller.step>
    physicalViewpoint: { target: Vec2; deadline: number } | null
  }
  return { config, engine, position, input, access }
}
describe('scheduling-only physical acquisition', () => {
  it('plans a separated reachable pose and accounts for scan time', () => {
    const { engine, position } = fixture()
    const plan = selectPhysicalAcquisitionTarget(engine.environment, position,
      { x: -1, y: 0 }, [position], 0.018, 1, 0.25)!
    expect(Math.hypot(plan.target.x - position.x, plan.target.y - position.y)).toBeCloseTo(0.0182)
    expect(plan.returnAllowance).toBeCloseTo(0.0182 / 0.0009 + 4 + 0.5 + 12 + 0.25)
    expect(plan.returnAllowance).toBeLessThan(75)
  })
  it('holds the target across measurement and wind changes, then scans at arrival', () => {
    const { access, input } = fixture()
    access.timeBudgetedAcquisition(input(14.25))
    const target = { ...access.physicalViewpoint!.target }
    access.timeBudgetedAcquisition({ ...input(15), measurement: { ...input(15).measurement, wind: { x: 0, y: -1 } } })
    expect(access.physicalViewpoint!.target).toEqual(target)
    const arrived = access.timeBudgetedAcquisition(input(35, target))
    expect(arrived.quadSniff?.scanId).toBeDefined()
  })
  it('refuses an acquisition cycle that cannot return before the old ray expires', () => {
    const { access, input } = fixture()
    const d = access.timeBudgetedAcquisition(input(70))
    expect(d.phase).toBe('INSUFFICIENT BEARING ACQUISITION BUDGET')
    expect(d.nativeTerminated).not.toBe(true)
    expect(d.nativeAbstained).not.toBe(true)
    expect(access.physicalViewpoint).toBeNull()
  })
  it('keeps failed travel unresolved and does not scan at a timed-out pose', () => {
    const { access, input } = fixture()
    access.timeBudgetedAcquisition(input(14.25))
    const d = access.timeBudgetedAcquisition(input(access.physicalViewpoint!.deadline + 0.25))
    expect(d.phase).toBe('PHYSICAL VIEWPOINT TIMEOUT')
    expect(d.quadSniff).toBeUndefined()
    expect(d.nativeAbstained).not.toBe(true)
  })
  it('does not select blocked paths or alter the archived separation gate', () => {
    const { engine, position } = fixture()
    expect(selectPhysicalAcquisitionTarget({ ...engine.environment, isBlocked: () => true },
      position, { x: -1, y: 0 }, [position], 0.018, 1, 0.25)).toBeNull()
    const p = selectPhysicalAcquisitionTarget(engine.environment, position,
      { x: -1, y: 0 }, [position, { x: 0.53, y: 0.484 }], 0.018, 1, 0.25)!
    expect(Math.hypot(p.target.x - 0.53, p.target.y - 0.484)).toBeGreaterThanOrEqual(0.0181)
  })
  it('requires the explicit physical lifecycle', () => {
    const { config } = fixture()
    delete config.localInletSampling!.candidateLifecycle
    expect(() => validateSimulationConfig(config)).toThrow(/Time-budgeted acquisition/)
  })
})
