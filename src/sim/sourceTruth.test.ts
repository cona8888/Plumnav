import { describe, expect, it } from 'vitest'
import { createDefaultConfig, validateSimulationConfig } from './config'
import { SimulationEngine } from './engine'
import { GridPlume } from './gridPlume'
import { FilamentPlume } from './plume'
import { createScenario } from './scenarios'

const configFor = (targetStatus: 'emitting' | 'zero-emission' | 'absent') => ({
  ...createDefaultConfig('coverage', 'open'),
  targetStatus,
  sourcePositionOverride: targetStatus === 'absent' ? undefined : { x: 0.78, y: 0.5 },
  robotStartPositionOverride: { x: 0.12, y: 0.5 },
})

describe('source truth contract', () => {
  it('rejects a hidden source coordinate in a true target-absent trial', () => {
    expect(() => validateSimulationConfig({
      ...configFor('absent'),
      sourcePositionOverride: { x: 0.78, y: 0.5 },
    })).toThrow(/sourcePositionOverride.*target-absent/)
  })

  it('represents a true absent target without a private source coordinate', () => {
    const config = configFor('absent')
    const scenario = createScenario('open', config.seed, config)
    expect(scenario.targetStatus).toBe('absent')
    expect(scenario.source).toBeNull()
    expect(new FilamentPlume(scenario, config.seed).puffsAt(10)).toEqual([])
    expect(new FilamentPlume(scenario, config.seed).concentrationAt({ x: 0.5, y: 0.5 }, 10)).toBe(0)
  })

  it('keeps zero-emission distinct: source geometry exists but gas is absent', () => {
    const config = configFor('zero-emission')
    const scenario = createScenario('open', config.seed, config)
    expect(scenario.source).toEqual({ x: 0.78, y: 0.5 })
    expect(scenario.targetStatus).toBe('zero-emission')
    const filament = new FilamentPlume(scenario, config.seed)
    expect(filament.puffsAt(10)).toEqual([])
    expect(filament.concentrationAt(scenario.source!, 10)).toBe(0)
    const grid = new GridPlume(scenario, config.seed, { resolution: 32, stepSeconds: 0.25 })
    expect(grid.totalMassAt?.(10)).toBe(0)
    expect(grid.concentrationAt(scenario.source!, 10)).toBe(0)
  })

  it('does not score localization error for a no-target trial', () => {
    const engine = new SimulationEngine({
      ...configFor('absent'),
      durationSeconds: 2,
      checkpointSeconds: [2],
      stopOnNativeDeclaration: false,
    })
    const frame = engine.runToCompletion()
    expect(frame.scenario.source).toBeNull()
    expect(frame.metrics.targetStatus).toBe('absent')
    expect(frame.metrics.normalizedError).toBeNull()
    expect(frame.metrics.errorMeters).toBeNull()
    expect(frame.metrics.success).toBeNull()
    expect(frame.metrics.correctRejection).toBe(true)
    expect(frame.checkpoints[2]?.normalizedError).toBeNull()
  })

  it('keeps controller observations identical across matched absent and zero-emission worlds', () => {
    const absent = new SimulationEngine({
      ...configFor('absent'),
      durationSeconds: 3,
      checkpointSeconds: [3],
      stopOnNativeDeclaration: false,
    })
    const zero = new SimulationEngine({
      ...configFor('zero-emission'),
      durationSeconds: 3,
      checkpointSeconds: [3],
      stopOnNativeDeclaration: false,
    })
    while (!absent.isCompleted() && !zero.isCompleted()) {
      const absentFrame = absent.step()
      const zeroFrame = zero.step()
      expect(absentFrame.robot).toEqual(zeroFrame.robot)
      expect(absentFrame.measurement).toEqual(zeroFrame.measurement)
      expect(absentFrame.decision).toEqual(zeroFrame.decision)
    }
    expect(absent.getFrame().metrics.normalizedError).toBeNull()
    expect(zero.getFrame().metrics.normalizedError).not.toBeNull()
  })

  it('classifies a declaration in a no-target trial as spurious', () => {
    const engine = new SimulationEngine({
      ...configFor('absent'),
      durationSeconds: 10,
      checkpointSeconds: [10],
      stopOnNativeDeclaration: true,
    })
    Object.defineProperty(engine.controller, 'step', {
      value: () => ({
        direction: { x: 0, y: 0 },
        estimate: { x: 0.6, y: 0.4 },
        confidence: 0.9,
        phase: 'DECLARE',
        nativeTerminated: true,
        terminationReason: 'Test declaration',
      }),
    })
    const frame = engine.step()
    expect(frame.completed).toBe(true)
    expect(frame.metrics.terminalOutcome).toBe('spurious-declaration')
    expect(frame.metrics.spuriousDeclaration).toBe(true)
    expect(frame.metrics.falseDeclarations).toBe(1)
    expect(frame.metrics.correctRejection).toBe(false)
    expect(frame.metrics.normalizedError).toBeNull()
  })

  it('scores the same Quad no-evidence abstention differently by hidden truth', () => {
    const shared = {
      ...createDefaultConfig('quad-passive', 'open'),
      sourcePositionOverride: undefined,
      robotStartPositionOverride: { x: 0.12, y: 0.5 },
      sensorNoise: 0,
      windNoise: 0,
      durationSeconds: 120,
      checkpointSeconds: [120],
      stopOnNativeDeclaration: false,
    }
    const absent = new SimulationEngine({ ...shared, targetStatus: 'absent' })
    const zeroEmission = new SimulationEngine({
      ...shared,
      targetStatus: 'zero-emission',
      sourcePositionOverride: { x: 0.78, y: 0.5 },
    })
    const absentFrame = absent.runToCompletion()
    const zeroFrame = zeroEmission.runToCompletion()

    expect(absentFrame.decision).toEqual(zeroFrame.decision)
    expect(absentFrame.metrics.nativeAbstention).toBe(true)
    expect(zeroFrame.metrics.nativeAbstention).toBe(true)
    expect(absentFrame.metrics.terminalOutcome).toBe('correct-abstention')
    expect(zeroFrame.metrics.terminalOutcome).toBe('missed-source-abstention')
    expect(absentFrame.metrics.nativeDeclaration).toBe(false)
    expect(zeroFrame.metrics.nativeDeclaration).toBe(false)
  })
})
