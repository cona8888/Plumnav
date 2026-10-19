import { describe, expect, it } from 'vitest'
import { createDefaultConfig, validateSimulationConfig } from './config'
import { SimulationEngine } from './engine'

const firstQuadReadings = (overrides: Partial<ReturnType<typeof createDefaultConfig>> = {}) => {
  const engine = new SimulationEngine({
    ...createDefaultConfig('quad-sniff', 'open'),
    seed: 314159,
    sourceSeed: 271828,
    controllerSeed: 161803,
    durationSeconds: 30,
    checkpointSeconds: [30],
    stopOnNativeDeclaration: false,
    sensorSaturation: 2,
    ...overrides,
  })
  while (!engine.isCompleted()) {
    const frame = engine.step()
    if (frame.measurement.sampleMode === 'quad-return') {
      return frame.measurement.quadSniff!.readings!.map((reading) => reading.concentration)
    }
  }
  throw new Error('Quad return was not produced')
}

describe('Quad-Suction nuisance robustness controls', () => {
  it('preserves the default Quad return regression path', () => {
    const readings = firstQuadReadings()
    expect(readings).toEqual([
      0,
      0.0003892584827063942,
      0.01409533715360544,
      0.004632955188241781,
    ])
    expect(firstQuadReadings({
      quadChannelNoiseCorrelation: 0,
      quadChannelGainMismatch: 0,
      quadChannelCrossTalk: 0,
      quadChannelLagMismatch: 0,
    })).toEqual(readings)
  })

  it('makes zero-strength channel noise perfectly shared at correlation one', () => {
    const readings = firstQuadReadings({
      activeSniffStrength: 0,
      sensorNoise: 0.04,
      quadChannelNoiseCorrelation: 1,
    })
    expect(new Set(readings)).toHaveLength(1)
  })

  it('applies deterministic gain, cross-talk, and lag stressors only to Quad returns', () => {
    const localSource = {
      sensorNoise: 0,
      sourcePositionOverride: { x: 0.5, y: 0.5 },
      robotStartPositionOverride: { x: 0.5, y: 0.5 },
    }
    const reference = firstQuadReadings(localSource)
    const gained = firstQuadReadings({ ...localSource, quadChannelGainMismatch: 0.3 })
    const lagged = firstQuadReadings({ ...localSource, quadChannelLagMismatch: 0.5 })
    const mixed = firstQuadReadings({
      ...localSource,
      quadChannelGainMismatch: 0.3,
      quadChannelCrossTalk: 1,
    })
    expect(gained).not.toEqual(reference)
    expect(lagged).not.toEqual(reference)
    expect(new Set(mixed)).toHaveLength(1)
  })

  it('replays nuisance conditions deterministically', () => {
    const nuisance = {
      sensorNoise: 0.04,
      quadChannelNoiseCorrelation: 0.65,
      quadChannelGainMismatch: 0.2,
      quadChannelCrossTalk: 0.35,
      quadChannelLagMismatch: 0.4,
    }
    expect(firstQuadReadings(nuisance)).toEqual(firstQuadReadings(nuisance))
  })

  it('rejects nuisance controls outside defensible sensitivity bounds', () => {
    const base = createDefaultConfig('quad-sniff', 'open')
    expect(() => validateSimulationConfig({ ...base, quadChannelNoiseCorrelation: -0.01 })).toThrow(/quadChannelNoiseCorrelation/)
    expect(() => validateSimulationConfig({ ...base, quadChannelGainMismatch: 0.51 })).toThrow(/quadChannelGainMismatch/)
    expect(() => validateSimulationConfig({ ...base, quadChannelCrossTalk: 1.01 })).toThrow(/quadChannelCrossTalk/)
    expect(() => validateSimulationConfig({ ...base, quadChannelLagMismatch: 0.91 })).toThrow(/quadChannelLagMismatch/)
  })
})
