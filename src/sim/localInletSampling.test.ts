import { describe, expect, it, vi } from 'vitest'
import { createDefaultConfig, validateSimulationConfig } from './config'
import { SimulationEngine } from './engine'
import { GSL_REFERENCE_DESIGN } from './physicalDesign'
import { LocalInletChannel, withLocalInletDesign } from './localInletSampling'

const config = () => withLocalInletDesign({ ...createDefaultConfig('quad-sniff-refine', 'open'),
  durationSeconds: 20, checkpointSeconds: [20], sensorNoise: 0, windNoise: 0,
  sourcePositionOverride: { x: 0.8, y: 0.5 }, robotStartPositionOverride: { x: 0.5, y: 0.5 },
  stopOnNativeDeclaration: false }, GSL_REFERENCE_DESIGN, {
  recoveryTimeConstantSeconds: 2, maximumTurnRateRadiansPerSecond: Math.PI / 4,
})
const stationary = (engine: SimulationEngine) => {
  engine.controller.step = () => ({ direction: { x: 0, y: 0 }, estimate: null, confidence: 0, phase: 'FIXTURE' })
}

describe('physical inlet chain', () => {
  it('has causal fractional tube delay and exact first-order step response', () => {
    const p = { ...config().localInletSampling!, riseTimeConstantSeconds: 1, averagingSeconds: 0 }
    const channel = new LocalInletChannel(p)
    expect(channel.update(0, 1)).toBe(0)
    expect(channel.update(0.5, 1)).toBe(0)
    const at1 = channel.update(1, 1)
    expect(at1).toBeCloseTo(1 - Math.exp(-(1 - channel.delay)), 12)
    expect(channel.update(2, 1)).toBeCloseTo(1 - Math.exp(-(2 - channel.delay)), 12)
  })
  it('uses separate recovery, exact averaging, and retains old gas after inlet drops', () => {
    const p = { ...config().localInletSampling!, tubeLengthMetres: 0, riseTimeConstantSeconds: 1,
      recoveryTimeConstantSeconds: 2, averagingSeconds: 0 }
    const channel = new LocalInletChannel(p)
    channel.update(0, 1)
    const peak = channel.update(2, 0)
    expect(peak).toBeCloseTo(1 - Math.exp(-2), 12)
    expect(channel.update(4, 0)).toBeCloseTo(peak * Math.exp(-1), 12)
    const averaged = new LocalInletChannel({ ...p, averagingSeconds: 1 })
    averaged.update(0, 1)
    expect(averaged.update(1, 1)).toBeCloseTo(Math.exp(-1), 12)
    expect(averaged.update(2, 1)).toBeCloseTo(1 + Math.exp(-2) - Math.exp(-1), 12)
  })
  it('does not change constant-input output when integration ticks are refined', () => {
    const p = config().localInletSampling!
    const run = (dt: number) => {
      const c = new LocalInletChannel(p)
      let value = 0
      for (let i = 0; i <= Math.round(10 / dt); i++) value = c.update(i * dt, 1)
      return value
    }
    expect(run(0.25)).toBeCloseTo(run(0.125), 12)
  })
  it('rejects invalid concentration and non-increasing clocks', () => {
    const c = new LocalInletChannel(config().localInletSampling!)
    c.update(0, 0)
    expect(() => c.update(0, 1)).toThrow()
    expect(() => c.update(1, NaN)).toThrow()
  })
})

describe('engine integration of physical sensing', () => {
  it('routes the opt-in scale-invariant estimator to the controller and engine metrics', () => {
    const run = (relative: boolean) => {
      const mapped = withLocalInletDesign(config(), { ...GSL_REFERENCE_DESIGN, domainMetres: 1000 },
        { recoveryTimeConstantSeconds: 2, maximumTurnRateRadiansPerSecond: Math.PI / 4 })
      mapped.sensorNoise = 0.001
      if (relative) mapped.localInletSampling!.gradientEstimator = 'relative-geometry-v1'
      const engine = new SimulationEngine(mapped)
      vi.spyOn(engine.plume, 'concentrationAt').mockImplementation(p => 0.5 + 0.5 * (p.x - 0.5) * 1000)
      engine.controller.step = () => ({ direction: { x: 0, y: 0 }, estimate: null, confidence: 0,
        phase: 'GRADIENT FIXTURE', quadSniff: { scanId: 1, forward: { x: 1, y: 0 } } })
      while (!engine.isCompleted()) engine.step()
      expect(engine.environment.gradientEstimator).toBe(relative ? 'relative-geometry-v1' : undefined)
      return engine.getFrame().metrics.quadValidDirections
    }
    expect(run(false)).toBe(0)
    expect(run(true)).toBe(1)
  })
  it('uses only four local inlet positions, no remote kernel, and continues filtering during waits', () => {
    const engine = new SimulationEngine(config())
    const reads = vi.spyOn(engine.plume, 'concentrationAt').mockReturnValue(1)
    engine.controller.step = () => ({ direction: { x: 0, y: 0 }, estimate: null, confidence: 0,
      phase: 'SCAN WITNESS', quadSniff: { scanId: 1, forward: { x: 0, y: 1 } } })
    const validTimes: number[] = []
    let returned = false
    while (!engine.isCompleted()) {
      const frame = engine.step()
      if (frame.measurement.valid) validTimes.push(frame.measurement.time)
      if (frame.measurement.sampleMode === 'quad-passive-return') {
        returned = true
        expect(frame.measurement.time % 1).toBe(0)
        expect(frame.measurement.concentration).toBeGreaterThan(0.99)
        expect(frame.measurement.quadSniff!.readings).toHaveLength(4)
        expect(frame.measurement.quadSniff!.readings![0]!.effectiveOffset).toEqual({ x: 0.0005, y: 0 })
      }
    }
    expect(returned).toBe(true)
    expect(validTimes.every(t => Number.isInteger(t))).toBe(true)
    expect(reads.mock.calls).toHaveLength(20 / 0.25 * 4)
    for (const [point] of reads.mock.calls) expect(Math.hypot(point.x - 0.5, point.y - 0.5)).toBeCloseTo(0.0005, 12)
    expect(engine.getFrame().metrics.localSamplingAirLitres).toBeCloseTo(4 * 0.25 * 20 / 60)
  })
  it('uses the same four-channel mean for ordinary passive samples without a fifth sensor', () => {
    const engine = new SimulationEngine(config()); stationary(engine)
    vi.spyOn(engine.plume, 'concentrationAt').mockImplementation(p => 0.5 + 10 * (p.x - 0.5))
    const valid: number[] = []
    while (!engine.isCompleted()) {
      const frame = engine.step()
      if (frame.measurement.valid) valid.push(frame.measurement.time)
    }
    expect(valid).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(engine.getFrame().measurement.concentration).toBeCloseTo(0.5, 5)
  })
  it.each([1, 100])('holds SI head size, speed and tubing timing fixed on a %s m domain', domainMetres => {
    const base = config()
    const mapped = withLocalInletDesign(base, { ...GSL_REFERENCE_DESIGN, domainMetres },
      { recoveryTimeConstantSeconds: 2, maximumTurnRateRadiansPerSecond: Math.PI / 4 })
    validateSimulationConfig(mapped)
    const engine = new SimulationEngine(mapped)
    expect(mapped.activeSniffReach * mapped.domainMeters * 2).toBeCloseTo(0.1)
    expect(mapped.robotSpeed * mapped.domainMeters).toBeCloseTo(0.1)
    expect(Math.hypot(engine.scenario.baseWind.x, engine.scenario.baseWind.y) * domainMetres).toBeCloseTo(1)
    expect(engine.environment.inspectionContract!.settlingSeconds).toBeGreaterThan(7)
  })
  it('bounds robot turning and speed and stops sampled-air accounting at declaration', () => {
    const engine = new SimulationEngine(config())
    vi.spyOn(engine.plume, 'concentrationAt').mockReturnValue(0)
    engine.controller.step = input => ({ direction: { x: 0, y: 1 }, speedScale: 1.5,
      estimate: null, confidence: 0, phase: 'TURN FIXTURE', nativeAbstained: input.time >= 5 })
    let heading = 0
    while (!engine.isCompleted()) {
      const f = engine.step()
      expect(Math.abs(f.robot.heading - heading)).toBeLessThanOrEqual(Math.PI / 4 * 0.25 + 1e-12)
      heading = f.robot.heading
    }
    expect(engine.getFrame().metrics.pathLengthMeters).toBeLessThanOrEqual(0.5)
    expect(engine.getFrame().metrics.localSamplingAirLitres).toBeCloseTo(4 * 0.25 * 5 / 60)
  })
  it('fails explicitly on an unsupported inlet location, cadence or inconsistent physical clock', () => {
    const p = config()
    expect(() => new SimulationEngine({ ...p, fixedDt: 0.3 })).toThrow(/cadence/)
    expect(() => new SimulationEngine({ ...p, activeSniffCycleSeconds: 0.75 })).toThrow(/clock/)
    const edge = new SimulationEngine({ ...p, robotStartPositionOverride: { x: 0, y: 0.5 } })
    expect(() => edge.step()).toThrow(/inlet intersects/)
  })
  it('does not share a mutable physical configuration with its caller', () => {
    const p = config(), engine = new SimulationEngine(p)
    p.localInletSampling!.inspection.dwellSeconds = 999
    expect(engine.config.localInletSampling!.inspection.dwellSeconds).not.toBe(999)
  })
})
