import { describe, expect, it } from 'vitest'
import { ALGORITHM_ORDER } from './algorithms/metadata'
import { createDefaultConfig } from './config'
import { SimulationEngine } from './engine'
import type { AlgorithmId, ScenarioKind } from './types'

describe('SimulationEngine', () => {
  it('replays the same seed deterministically', () => {
    const config = { ...createDefaultConfig('infotaxis', 'obstructed'), seed: 1729 }
    const first = new SimulationEngine(config)
    const second = new SimulationEngine(config)
    for (let index = 0; index < 80; index += 1) {
      first.step()
      second.step()
    }
    const a = first.getFrame()
    const b = second.getFrame()
    expect(a.robot.position.x).toBeCloseTo(b.robot.position.x, 12)
    expect(a.robot.position.y).toBeCloseTo(b.robot.position.y, 12)
    expect(a.measurement.concentration).toBeCloseTo(b.measurement.concentration, 12)
    expect(a.decision.estimate?.x).toBeCloseTo(b.decision.estimate?.x ?? 0, 12)
    expect(a.metrics.hitCount).toBe(b.metrics.hitCount)
  })

  it.each(ALGORITHM_ORDER)('%s produces finite, in-domain state', (algorithmId) => {
    const engine = new SimulationEngine({
      ...createDefaultConfig(algorithmId, 'obstructed'),
      seed: 311,
      stopOnNativeDeclaration: false,
    })
    for (let index = 0; index < 160; index += 1) engine.step()
    const frame = engine.getFrame()
    expect(Number.isFinite(frame.robot.position.x)).toBe(true)
    expect(Number.isFinite(frame.robot.position.y)).toBe(true)
    expect(frame.robot.position.x).toBeGreaterThanOrEqual(0)
    expect(frame.robot.position.x).toBeLessThanOrEqual(1)
    expect(frame.robot.position.y).toBeGreaterThanOrEqual(0)
    expect(frame.robot.position.y).toBeLessThanOrEqual(1)
    expect(Number.isFinite(frame.metrics.normalizedError)).toBe(true)
    expect(Number.isFinite(frame.metrics.meanComputeMs)).toBe(true)
  })

  it('keeps normalized results dimensionless while dimensional error scales', () => {
    const base = {
      ...createDefaultConfig('surge-cast', 'open'),
      seed: 991,
      stopOnNativeDeclaration: false,
    }
    const oneMetre = new SimulationEngine({ ...base, domainMeters: 1 })
    const hundredMetres = new SimulationEngine({ ...base, domainMeters: 100 })
    for (let index = 0; index < 120; index += 1) {
      oneMetre.step()
      hundredMetres.step()
    }
    const one = oneMetre.getMetrics()
    const hundred = hundredMetres.getMetrics()
    expect(one.normalizedError!).toBeCloseTo(hundred.normalizedError!, 12)
    expect(hundred.errorMeters!).toBeCloseTo(one.errorMeters! * 100, 10)
    expect(one.success).toBe(hundred.success)
  })

  it.each(['open', 'obstructed'] satisfies ScenarioKind[])('records fixed checkpoints in %s scenario', (scenarioKind) => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('coverage', scenarioKind),
      durationSeconds: 4,
      checkpointSeconds: [1, 2, 4],
      stopOnNativeDeclaration: false,
    })
    const frame = engine.runToCompletion()
    expect(Object.keys(frame.checkpoints).map(Number)).toEqual([1, 2, 4])
    expect(frame.checkpoints[4]?.elapsedSeconds).toBe(4)
  })

  it('keeps source truth and unfiltered concentration outside the controller boundary', () => {
    const config = createDefaultConfig('infotaxis', 'open')
    const engine = new SimulationEngine(config)
    engine.step()
    const frame = engine.getFrame()
    expect('source' in engine.environment.scenario).toBe(false)
    expect('seed' in engine.environment).toBe(false)
    expect(engine.environment.controllerSeed).toBe(config.controllerSeed)
    expect(engine.environment.observationModelSeed).toBe(config.observationModelSeed)
    expect(engine.environment.observationModelVersion).toBe('controller-observation-v1')
    expect(engine.observationModel).not.toBe(engine.plume)
    expect('source' in engine.observationModel.scenario).toBe(false)
    expect(engine.environment.controllerSeed).not.toBe(config.seed)
    expect(config.sourceSeed).not.toBe(config.seed)
    expect('trueConcentration' in frame.measurement).toBe(false)
    expect('trueConcentration' in (frame.observations[0] ?? {})).toBe(false)
  })

  it('deep-freezes the public scenario copy without freezing engine truth', () => {
    const engine = new SimulationEngine(createDefaultConfig('coverage', 'obstructed'))
    const originalWind = engine.scenario.baseWind.x
    const originalObstacleCount = engine.scenario.obstacles.length
    expect(Object.isFrozen(engine.environment)).toBe(true)
    expect(Object.isFrozen(engine.environment.scenario)).toBe(true)
    expect(Object.isFrozen(engine.environment.scenario.baseWind)).toBe(true)
    expect(Object.isFrozen(engine.environment.scenario.obstacles)).toBe(true)
    expect(engine.environment.scenario.baseWind).not.toBe(engine.scenario.baseWind)
    expect(engine.environment.scenario.obstacles).not.toBe(engine.scenario.obstacles)
    expect(() => {
      engine.environment.scenario.baseWind.x = 123
    }).toThrow(TypeError)
    expect(() => {
      engine.environment.scenario.obstacles.pop()
    }).toThrow(TypeError)
    expect(engine.scenario.baseWind.x).toBe(originalWind)
    expect(engine.scenario.obstacles).toHaveLength(originalObstacleCount)
  })

  it('rejects configurations that could make the stepping loop unsafe', () => {
    expect(
      () => new SimulationEngine({ ...createDefaultConfig(), fixedDt: 0 }),
    ).toThrow(/fixedDt/)
    expect(
      () => new SimulationEngine({ ...createDefaultConfig(), durationSeconds: Number.NaN }),
    ).toThrow(/durationSeconds/)
    expect(
      () => new SimulationEngine({ ...createDefaultConfig(), physicsStepSeconds: 0 }),
    ).toThrow(/physicsStepSeconds/)
    expect(
      () => new SimulationEngine({ ...createDefaultConfig(), observationModelSeed: 1.5 }),
    ).toThrow(/observationModelSeed/)
  })

  it('keeps grid physics timestep independent from controller cadence', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('surge-cast', 'open'),
      physicsMode: 'grid',
      fixedDt: 0.25,
      physicsStepSeconds: 0.1,
    })
    expect(engine.config.fixedDt).toBe(0.25)
    expect(engine.config.physicsStepSeconds).toBe(0.1)
    expect((engine.plume as { stepSeconds?: number }).stepSeconds).toBe(0.1)
  })

  it('latches a pulse, holds position and excludes blanked frames from samples', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('pulse-sniff', 'open'),
      seed: 77,
      durationSeconds: 20,
      checkpointSeconds: [20],
    })
    while (engine.getMetrics().activeProbeCount === 0) engine.step()
    const issued = engine.getFrame()
    const heldPosition = issued.robot.position
    const validSamples = issued.metrics.samples
    expect(issued.activeSniff?.phase).toBe('exhale')

    engine.step()
    const blanked = engine.getFrame()
    expect(blanked.measurement.valid).toBe(false)
    expect(blanked.measurement.sampleMode).toBe('blanked')
    expect(blanked.metrics.samples).toBe(validSamples)
    expect(blanked.robot.position).toEqual(heldPosition)

    while (engine.getFrame().measurement.sampleMode !== 'active-return') engine.step()
    const returned = engine.getFrame()
    expect(returned.measurement.valid).toBe(true)
    expect(returned.measurement.activeSniff?.phase).toBe('return')
    // The controller may issue the next bearing immediately after consuming a
    // return, so the total can already include that new cycle's first interval.
    expect(returned.metrics.activeSamplingSeconds).toBeGreaterThanOrEqual(0.75)
    expect(returned.metrics.airPulseEnergy).toBeGreaterThan(0)
    expect(returned.metrics.activeReturnSamples).toBeGreaterThanOrEqual(1)
    expect(returned.metrics.passiveSamples + returned.metrics.activeReturnSamples).toBe(
      returned.metrics.samples,
    )
    expect('latentReturn' in returned.measurement).toBe(false)
    expect('latentReturn' in (returned.activeSniff ?? {})).toBe(false)
  })

  it.each(['filament', 'grid'] as const)(
    'completes active returns with the %s plume model',
    (physicsMode) => {
      const engine = new SimulationEngine({
        ...createDefaultConfig('pulse-sniff', 'open'),
        physicsMode,
        gridResolution: 32,
        durationSeconds: 12,
        checkpointSeconds: [12],
      })
      let returned = false
      while (!engine.isCompleted()) {
        engine.step()
        if (engine.getFrame().measurement.sampleMode === 'active-return') {
          returned = true
          break
        }
      }
      expect(returned).toBe(true)
    },
  )

  it('supports a disabled-sampler sham without recording pulse costs', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('pulse-sniff', 'open'),
      activeSniffEnabled: false,
      durationSeconds: 8,
      checkpointSeconds: [8],
    })
    engine.runToCompletion()
    expect(engine.getMetrics().activeProbeCount).toBe(0)
    expect(engine.getMetrics().activeSamplingSeconds).toBe(0)
    expect(engine.getMetrics().airPulseEnergy).toBe(0)
  })

  it('latches one simultaneous quad draw, holds position and returns four independent channels', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('quad-sniff', 'open'),
      seed: 42,
      durationSeconds: 180,
      checkpointSeconds: [180],
      stopOnNativeDeclaration: false,
    })
    while (engine.getMetrics().quadSniffCycles === 0 && !engine.isCompleted()) engine.step()
    const issued = engine.getFrame()
    expect(issued.metrics.quadSniffCycles).toBe(1)
    expect(issued.metrics.quadSuctionEnergy).toBeCloseTo(4 * 0.78 ** 2 * 0.25, 10)
    expect(issued.quadSniff?.phase).toBe('aspirate')
    expect(issued.quadSniff?.channels.map((channel) => channel.channel)).toEqual([
      'front',
      'left',
      'aft',
      'right',
    ])
    expect('latentChannels' in (issued.quadSniff ?? {})).toBe(false)
    const heldPosition = { ...issued.robot.position }
    const validSamples = issued.metrics.samples

    engine.step()
    const blanked = engine.getFrame()
    expect(blanked.measurement.sampleMode).toBe('blanked')
    expect(blanked.measurement.valid).toBe(false)
    expect(blanked.metrics.samples).toBe(validSamples)
    expect(blanked.robot.position).toEqual(heldPosition)

    while (
      engine.getFrame().measurement.sampleMode !== 'quad-return' &&
      !engine.isCompleted()
    ) engine.step()
    const returned = engine.getFrame()
    const readings = returned.measurement.quadSniff?.readings ?? []
    expect(returned.measurement.sampleMode).toBe('quad-return')
    expect(readings).toHaveLength(4)
    expect(new Set(readings.map((reading) => reading.channel)).size).toBe(4)
    expect(readings.every((reading) => Number.isFinite(reading.concentration))).toBe(true)
    expect(readings.every((reading) => reading.integrationSamples === 4)).toBe(true)
    expect(returned.metrics.quadChannelReturns).toBe(4)
    expect(
      returned.metrics.quadValidDirections + returned.metrics.quadDirectionAbstentions,
    ).toBe(1)
    expect(returned.metrics.meanQuadIntegrationSamples).toBe(4)
    expect(returned.metrics.meanQuadEffectiveSamples).toBeCloseTo(3.6, 10)
    expect(returned.metrics.meanQuadSupport).toBeGreaterThan(0)
    expect(returned.metrics.quadSuctionEnergy).toBeGreaterThan(0)
    expect(returned.metrics.quadSuctionEnergy).toBeCloseTo(4 * 0.78 ** 2 * 0.75, 10)
    expect(returned.metrics.activeSamplingSeconds).toBeGreaterThanOrEqual(0.75)
    expect(returned.metrics.passiveSamples + returned.metrics.activeReturnSamples).toBe(
      returned.metrics.samples,
    )
    expect('latentChannels' in (returned.measurement.quadSniff ?? {})).toBe(false)
  })

  it('keeps the quad zero-strength sham time-matched without directional benefit or energy', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('quad-sniff', 'open'),
      seed: 42,
      activeSniffStrength: 0,
      sensorNoise: 0.025,
      durationSeconds: 180,
      checkpointSeconds: [180],
      stopOnNativeDeclaration: false,
    })
    while (
      engine.getFrame().measurement.sampleMode !== 'quad-return' &&
      !engine.isCompleted()
    ) engine.step()
    const frame = engine.getFrame()
    const readings = frame.measurement.quadSniff?.readings ?? []
    expect(frame.measurement.sampleMode).toBe('quad-return')
    expect(readings).toHaveLength(4)
    expect(frame.metrics.quadSniffCycles).toBe(1)
    expect(frame.metrics.quadSuctionEnergy).toBe(0)
    expect(frame.metrics.meanQuadContrast).toBe(0)
    expect(frame.metrics.quadValidDirections).toBe(0)
    expect(frame.metrics.quadDirectionAbstentions).toBe(1)
    expect(frame.metrics.activeSamplingSeconds).toBeGreaterThanOrEqual(0.75)
  })

  it('runs the genuine passive four-head comparator without active-return or suction cost', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('quad-passive', 'open'),
      seed: 42,
      activeSniffEnabled: false,
      durationSeconds: 180,
      checkpointSeconds: [180],
      stopOnNativeDeclaration: false,
    })
    while (
      engine.getFrame().measurement.sampleMode !== 'quad-passive-return' &&
      !engine.isCompleted()
    ) engine.step()
    const frame = engine.getFrame()
    const readings = frame.measurement.quadSniff?.readings ?? []
    expect(frame.measurement.sampleMode).toBe('quad-passive-return')
    expect(frame.measurement.quadSniff?.samplingMode).toBe('passive-array')
    expect(readings).toHaveLength(4)
    expect(new Set(readings.map((reading) => reading.effectiveOffset.x)).size).toBeGreaterThan(1)
    expect(frame.metrics.quadSniffCycles).toBe(1)
    expect(frame.metrics.quadPassiveCycles).toBe(1)
    expect(frame.metrics.quadPassiveChannelReturns).toBe(4)
    expect(frame.metrics.quadSuctionEnergy).toBe(0)
    expect(frame.metrics.activeReturnSamples).toBe(0)
    expect(frame.metrics.activeSamplingSeconds).toBe(0)
    expect(frame.metrics.quadPassiveSamplingSeconds).toBeGreaterThanOrEqual(0.75)
  })

  it('runs the frozen M7 Quad policy as an active same-world comparator', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('quad-sniff-legacy', 'open'),
      seed: 42,
      durationSeconds: 12,
      checkpointSeconds: [12],
      stopOnNativeDeclaration: false,
    })
    while (
      engine.getFrame().measurement.sampleMode !== 'quad-return' &&
      !engine.isCompleted()
    ) engine.step()
    const frame = engine.getFrame()
    expect(engine.controller.metadata.id).toBe('quad-sniff-legacy')
    expect(frame.measurement.sampleMode).toBe('quad-return')
    expect(frame.measurement.quadSniff?.samplingMode).toBe('active-suction')
    expect(frame.metrics.quadSuctionEnergy).toBeGreaterThan(0)
  })

  it('runs the frozen M8 staged policy as an active same-world comparator', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('quad-sniff-staged', 'open'),
      seed: 42,
      durationSeconds: 12,
      checkpointSeconds: [12],
      stopOnNativeDeclaration: false,
    })
    while (
      engine.getFrame().measurement.sampleMode !== 'quad-return' &&
      !engine.isCompleted()
    ) engine.step()
    const frame = engine.getFrame()
    expect(engine.controller.metadata.id).toBe('quad-sniff-staged')
    expect(frame.measurement.sampleMode).toBe('quad-return')
    expect(frame.measurement.quadSniff?.samplingMode).toBe('active-suction')
    expect(frame.metrics.quadSuctionEnergy).toBeGreaterThan(0)
  })

  it('runs the frozen M9 adaptive policy as an active same-world comparator', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('quad-sniff-adaptive', 'open'),
      seed: 42,
      durationSeconds: 12,
      checkpointSeconds: [12],
      stopOnNativeDeclaration: false,
    })
    while (
      engine.getFrame().measurement.sampleMode !== 'quad-return' &&
      !engine.isCompleted()
    ) engine.step()
    const frame = engine.getFrame()
    expect(engine.controller.metadata.id).toBe('quad-sniff-adaptive')
    expect(frame.measurement.sampleMode).toBe('quad-return')
    expect(frame.measurement.quadSniff?.samplingMode).toBe('active-suction')
    expect(frame.metrics.quadSuctionEnergy).toBeGreaterThan(0)
  })

  it('supports quad active-sampling off without recording four-channel costs', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('quad-sniff', 'open'),
      activeSniffEnabled: false,
      durationSeconds: 30,
      checkpointSeconds: [30],
    })
    while (!engine.isCompleted()) {
      const frame = engine.step()
      expect(frame.measurement.sampleMode).toBe('passive')
      expect(frame.decision.phase).not.toMatch(/ASPIRATION|AWAITING/)
    }
    expect(engine.getMetrics().quadSniffCycles).toBe(0)
    expect(engine.getMetrics().quadChannelReturns).toBe(0)
    expect(engine.getMetrics().quadSuctionEnergy).toBe(0)
  })

  it.each(['filament', 'grid'] as const)(
    'completes integrated quad returns with the %s plume model',
    (physicsMode) => {
      const engine = new SimulationEngine({
        ...createDefaultConfig('quad-sniff', 'open'),
        physicsMode,
        gridResolution: 32,
        durationSeconds: 12,
        checkpointSeconds: [12],
      })
      let returned = false
      while (!engine.isCompleted()) {
        const frame = engine.step()
        if (frame.measurement.sampleMode === 'quad-return') {
          returned = true
          expect(frame.measurement.quadSniff?.readings).toHaveLength(4)
          expect(frame.measurement.quadSniff?.readings?.every(
            (reading) => reading.integrationSamples >= 3,
          )).toBe(true)
          break
        }
      }
      expect(returned).toBe(true)
    },
  )

  it('holds position, samples and estimate after a native declaration in fixed-budget mode', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('coverage', 'open'),
      seed: 42,
      durationSeconds: 360,
      checkpointSeconds: [360],
      stopOnNativeDeclaration: false,
    })
    while (!engine.getMetrics().nativeDeclaration && !engine.isCompleted()) engine.step()
    expect(engine.getMetrics().nativeDeclaration).toBe(true)
    const declared = engine.getFrame()
    for (let index = 0; index < 20; index += 1) engine.step()
    const held = engine.getFrame()
    expect(held.time).toBeGreaterThan(declared.time)
    expect(held.metrics.samples).toBe(declared.metrics.samples)
    expect(held.robot.path).toHaveLength(declared.robot.path.length)
    expect(held.metrics.estimate).toEqual(declared.metrics.estimate)
  })

  it.each(['infotaxis', 'smc-kl', 'pmfs'] satisfies AlgorithmId[])(
    '%s applies the strict 1% criterion without a tuned acceptance assertion',
    (algorithmId) => {
      const frame = new SimulationEngine({
        ...createDefaultConfig(algorithmId, 'open'),
        seed: 42,
        stopOnNativeDeclaration: false,
      }).runToCompletion()
      expect(frame.metrics.success).toBe(frame.metrics.normalizedError! <= 0.01)
    },
  )
})
