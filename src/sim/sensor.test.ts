import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config'
import { SimulationEngine } from './engine'

const stepMany = (engine: SimulationEngine, steps: number) => {
  for (let index = 0; index < steps; index += 1) engine.step()
  return engine.getFrame()
}

describe('configurable sensor model', () => {
  it('does not accumulate rectified readout noise as physical blank state', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('coverage', 'open'),
      targetStatus: 'zero-emission',
      durationSeconds: 20,
      checkpointSeconds: [20],
      sensorNoise: 0.1,
      sensorLag: 10,
      stopOnNativeDeclaration: false,
    })
    stepMany(engine, 80)
    expect((engine as unknown as { sensorState: number }).sensorState).toBe(0)
  })

  it('replays seeded classification errors deterministically', () => {
    const config = {
      ...createDefaultConfig('coverage', 'open'),
      durationSeconds: 2,
      checkpointSeconds: [2],
      sensorNoise: 0,
      windNoise: 0,
      sensorThresholdScale: 3,
      sensorFalsePositiveRate: 0.5,
      stopOnNativeDeclaration: false,
    }
    const first = stepMany(new SimulationEngine(config), 8)
    const second = stepMany(new SimulationEngine(config), 8)
    const clean = stepMany(
      new SimulationEngine({ ...config, sensorFalsePositiveRate: 0 }),
      8,
    )

    expect(first.observations.map((sample) => sample.hit)).toEqual(
      second.observations.map((sample) => sample.hit),
    )
    expect(first.metrics.hitCount).toBeGreaterThan(0)
    expect(clean.metrics.hitCount).toBe(0)
  })

  it('clips the reported concentration at sensor saturation', () => {
    const frame = stepMany(
      new SimulationEngine({
        ...createDefaultConfig('coverage', 'open'),
        durationSeconds: 3,
        sensorNoise: 2,
        sensorSaturation: 0.35,
        stopOnNativeDeclaration: false,
      }),
      12,
    )
    expect(frame.observations.length).toBeGreaterThan(0)
    expect(
      frame.observations.every(
        (sample) => sample.concentration >= 0 && sample.concentration <= 0.35,
      ),
    ).toBe(true)
  })

  it('runs the numerical forward model through the common engine boundary', () => {
    const first = new SimulationEngine({
      ...createDefaultConfig('surge-cast', 'obstructed'),
      physicsMode: 'grid',
      gridResolution: 32,
      durationSeconds: 3,
      checkpointSeconds: [3],
      stopOnNativeDeclaration: false,
    })
    const second = new SimulationEngine(first.config)
    const a = stepMany(first, 12)
    const b = stepMany(second, 12)

    expect(first.plume.gridAt).toBeTypeOf('function')
    expect(a.measurement).toEqual(b.measurement)
    expect(a.robot).toEqual(b.robot)
    expect(a.metrics.normalizedError).toBe(b.metrics.normalizedError)
    expect(first.plume.gridAt?.(3).values).toEqual(second.plume.gridAt?.(3).values)
  })

  it('rejects impossible or invalid sensor settings', () => {
    expect(
      () =>
        new SimulationEngine({
          ...createDefaultConfig(),
          sensorFalsePositiveRate: 0.6,
        }),
    ).toThrow(/false-positive/)
    expect(
      () =>
        new SimulationEngine({
          ...createDefaultConfig(),
          sensorThresholdScale: 3,
          sensorSaturation: 0.2,
        }),
    ).toThrow(/sensorSaturation/)
  })
})
