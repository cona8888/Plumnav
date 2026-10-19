import { describe, expect, it } from 'vitest'
import { ALGORITHM_ORDER } from './algorithms/metadata'
import { createDefaultConfig } from './config'
import { SimulationEngine } from './engine'
import { FilamentPlume, segmentIntersectsObstacle } from './plume'
import type { Vec2 } from './types'

const windMagnitude = (engine: SimulationEngine) =>
  Math.hypot(engine.scenario.baseWind.x, engine.scenario.baseWind.y)

const magnitude = (vector: Vec2) => Math.hypot(vector.x, vector.y)

const angularDeviation = (wind: Vec2, mean: Vec2) =>
  Math.atan2(wind.x * mean.y - wind.y * mean.x, wind.x * mean.x + wind.y * mean.y)

describe('interactive flow configuration', () => {
  it('maps compass heading and speed scale into the convective wind vector', () => {
    const north = new SimulationEngine({
      ...createDefaultConfig(),
      windDirectionDegrees: 0,
    })
    const east = new SimulationEngine({
      ...createDefaultConfig(),
      windDirectionDegrees: 90,
    })
    const fastEast = new SimulationEngine({
      ...createDefaultConfig(),
      windDirectionDegrees: 90,
      windSpeedScale: 1.8,
    })
    const south = new SimulationEngine({
      ...createDefaultConfig(),
      windDirectionDegrees: 180,
    })
    const west = new SimulationEngine({
      ...createDefaultConfig(),
      windDirectionDegrees: 270,
    })
    const northAgain = new SimulationEngine({
      ...createDefaultConfig(),
      windDirectionDegrees: 360,
    })

    expect(Math.abs(north.scenario.baseWind.x)).toBeLessThan(1e-12)
    expect(north.scenario.baseWind.y).toBeLessThan(0)
    expect(east.scenario.baseWind.x).toBeGreaterThan(0)
    expect(Math.abs(east.scenario.baseWind.y)).toBeLessThan(1e-12)
    expect(Math.abs(south.scenario.baseWind.x)).toBeLessThan(1e-12)
    expect(south.scenario.baseWind.y).toBeGreaterThan(0)
    expect(west.scenario.baseWind.x).toBeLessThan(0)
    expect(Math.abs(west.scenario.baseWind.y)).toBeLessThan(1e-12)
    expect(northAgain.scenario.baseWind.x).toBeCloseTo(north.scenario.baseWind.x, 12)
    expect(northAgain.scenario.baseWind.y).toBeCloseTo(north.scenario.baseWind.y, 12)
    expect(northAgain.scenario.source).toEqual(north.scenario.source)
    expect(northAgain.scenario.robotStart).toEqual(north.scenario.robotStart)
    expect(windMagnitude(fastEast) / windMagnitude(east)).toBeCloseTo(1.8, 12)
  })

  it('keeps hidden source placement independent of public flow and layout seed', () => {
    const baseConfig = createDefaultConfig('coverage', 'obstructed')
    const first = new SimulationEngine({ ...baseConfig, seed: 12_345 })
    const changedWorld = new SimulationEngine({ ...baseConfig, seed: 54_321 })
    const changedSource = new SimulationEngine({
      ...baseConfig,
      seed: 12_345,
      sourceSeed: baseConfig.sourceSeed + 1,
    })
    expect(changedWorld.scenario.source).toEqual(first.scenario.source)
    expect(changedWorld.scenario.robotStart).not.toEqual(first.scenario.robotStart)
    expect(changedWorld.scenario.obstacles).not.toEqual(first.scenario.obstacles)
    expect(changedSource.scenario.source).not.toEqual(first.scenario.source)
    expect(changedSource.scenario.robotStart).toEqual(first.scenario.robotStart)
    expect(changedSource.scenario.obstacles).toEqual(first.scenario.obstacles)
  })

  it('applies diffusion to puff width and convection to puff displacement', () => {
    const west = new SimulationEngine({
      ...createDefaultConfig(),
      windDirectionDegrees: 270,
      diffusivityScale: 0.5,
    })
    const eastDiffuse = new SimulationEngine({
      ...createDefaultConfig(),
      windDirectionDegrees: 90,
      diffusivityScale: 2,
    })
    const westPuff = west.plume.puffsAt(8)[0]
    const eastPuff = eastDiffuse.plume.puffsAt(8)[0]
    expect(westPuff).toBeDefined()
    expect(eastPuff).toBeDefined()
    expect((westPuff?.position.x ?? 0) - west.scenario.source!.x).toBeLessThan(0)
    expect((eastPuff?.position.x ?? 0) - eastDiffuse.scenario.source!.x).toBeGreaterThan(0)
    expect(eastPuff?.sigma ?? 0).toBeGreaterThan(westPuff?.sigma ?? 0)
  })

  it('changes the local wind magnitude when gust amplitude is enabled', () => {
    const steady = new SimulationEngine({
      ...createDefaultConfig(),
      turbulenceScale: 0,
      gustStrength: 0,
    })
    const gusting = new SimulationEngine({
      ...createDefaultConfig(),
      turbulenceScale: 0,
      gustStrength: 0.3,
    })
    const point = { x: 0.5, y: 0.5 }
    const steadyWind = steady.plume.windAt(point, 7)
    const gustWind = gusting.plume.windAt(point, 7)
    const steadyMagnitude = Math.hypot(steadyWind.x, steadyWind.y)
    const gustMagnitude = Math.hypot(gustWind.x, gustWind.y)
    expect(gustMagnitude).not.toBeCloseTo(steadyMagnitude, 6)
  })

  it('keeps gusts within the displayed fraction of mean speed', () => {
    const gustStrength = 0.35
    const steady = new SimulationEngine({
      ...createDefaultConfig(),
      turbulenceScale: 2,
      gustStrength: 0,
    })
    const gusting = new SimulationEngine({
      ...createDefaultConfig(),
      turbulenceScale: 2,
      gustStrength,
    })
    const meanSpeed = windMagnitude(gusting)

    for (let index = 0; index < 120; index += 1) {
      const point = {
        x: 0.08 + (index % 11) * 0.079,
        y: 0.11 + (index % 7) * 0.117,
      }
      const time = index * 0.37
      expect(magnitude(steady.plume.windAt(point, time))).toBeCloseTo(meanSpeed, 12)
      const ratio = magnitude(gusting.plume.windAt(point, time)) / meanSpeed
      expect(ratio).toBeGreaterThanOrEqual(1 - gustStrength - 1e-12)
      expect(ratio).toBeLessThanOrEqual(1 + gustStrength + 1e-12)
    }
  })

  it('increases directional variability with turbulence', () => {
    const calm = new SimulationEngine({
      ...createDefaultConfig(),
      turbulenceScale: 0.25,
      gustStrength: 0,
    })
    const turbulent = new SimulationEngine({
      ...createDefaultConfig(),
      turbulenceScale: 1.75,
      gustStrength: 0,
    })
    const rmsAngle = (engine: SimulationEngine) => {
      const deviations = Array.from({ length: 100 }, (_, index) => {
        const point = { x: 0.13 + (index % 9) * 0.09, y: 0.17 + (index % 5) * 0.14 }
        return angularDeviation(
          engine.plume.windAt(point, index * 0.41),
          engine.scenario.baseWind,
        )
      })
      return Math.sqrt(
        deviations.reduce((total, deviation) => total + deviation ** 2, 0) /
          deviations.length,
      )
    }
    expect(rmsAngle(turbulent)).toBeGreaterThan(rmsAngle(calm) * 4)
  })

  it('conserves Gaussian puff mass when diffusivity changes', () => {
    const low = new SimulationEngine({
      ...createDefaultConfig(),
      diffusivityScale: 0.25,
    })
    const high = new SimulationEngine({
      ...createDefaultConfig(),
      diffusivityScale: 3,
    })
    const lowPuff = low.plume.puffsAt(11)[3]
    const highPuff = high.plume.puffsAt(11)[3]
    expect(lowPuff).toBeDefined()
    expect(highPuff).toBeDefined()
    expect(highPuff?.position).toEqual(lowPuff?.position)
    expect(highPuff?.sigma ?? 0).toBeGreaterThan(lowPuff?.sigma ?? 0)
    expect((highPuff?.intensity ?? 0) * (highPuff?.sigma ?? 0) ** 2).toBeCloseTo(
      (lowPuff?.intensity ?? 0) * (lowPuff?.sigma ?? 0) ** 2,
      12,
    )
  })

  it('scales source output consistently without changing transport geometry', () => {
    const low = new SimulationEngine({
      ...createDefaultConfig(),
      emissionRateScale: 0.5,
    })
    const high = new SimulationEngine({
      ...createDefaultConfig(),
      emissionRateScale: 2,
    })

    expect(high.scenario.source).toEqual(low.scenario.source)
    expect(high.scenario.robotStart).toEqual(low.scenario.robotStart)
    expect(high.scenario.baseWind).toEqual(low.scenario.baseWind)
    expect(high.scenario.diffusivity).toBe(low.scenario.diffusivity)

    const lowPuff = low.plume.puffsAt(8)[0]
    const highPuff = high.plume.puffsAt(8)[0]
    expect(lowPuff).toBeDefined()
    expect(highPuff?.position).toEqual(lowPuff?.position)
    expect(highPuff?.sigma).toBe(lowPuff?.sigma)
    expect((highPuff?.intensity ?? 0) / (lowPuff?.intensity ?? 1)).toBeCloseTo(4, 12)
    expect(high.plume.totalMassAt?.(8) ?? 0).toBeCloseTo(
      (low.plume.totalMassAt?.(8) ?? 0) * 4,
      12,
    )

    const candidate = { x: 0.82, y: 0.5 }
    const sample = { x: 0.3, y: 0.58 }
    expect(high.plume.expectedHitRate(candidate, sample, 8)).toBeGreaterThan(
      low.plume.expectedHitRate(candidate, sample, 8),
    )
  })

  it('scales numerical source forcing in the 2D grid solver', () => {
    const low = new SimulationEngine({
      ...createDefaultConfig(),
      physicsMode: 'grid',
      gridResolution: 32,
      emissionRateScale: 0.5,
    })
    const high = new SimulationEngine({
      ...createDefaultConfig(),
      physicsMode: 'grid',
      gridResolution: 32,
      emissionRateScale: 2,
    })
    const lowMass = low.plume.totalMassAt?.(5) ?? 0
    const highMass = high.plume.totalMassAt?.(5) ?? 0
    expect(lowMass).toBeGreaterThan(0)
    expect(highMass).toBeGreaterThan(lowMass * 2)
    expect(
      high.plume.concentrationAt(high.scenario.source!, 5),
    ).toBeGreaterThan(
      low.plume.concentrationAt(low.scenario.source!, 5),
    )
  })

  it('includes gust speed in the inverse plume likelihood', () => {
    const steady = new SimulationEngine({
      ...createDefaultConfig(),
      windDirectionDegrees: 90,
      turbulenceScale: 0,
      gustStrength: 0,
    })
    const gusting = new SimulationEngine({
      ...createDefaultConfig(),
      windDirectionDegrees: 90,
      turbulenceScale: 0,
      gustStrength: 0.35,
    })
    const candidate = { x: 0.25, y: 0.48 }
    const sample = { x: 0.72, y: 0.56 }
    expect(gusting.plume.expectedHitRate(candidate, sample, 7)).not.toBeCloseTo(
      steady.plume.expectedHitRate(candidate, sample, 7),
      8,
    )
  })

  it('gives different algorithms the identical configured atmosphere', () => {
    const shared = {
      seed: 90210,
      windDirectionDegrees: 135,
      windSpeedScale: 1.4,
      turbulenceScale: 0.75,
      gustStrength: 0.2,
      diffusivityScale: 1.6,
      emissionRateScale: 1.7,
      obstacleComplexityLevel: 4,
    }
    const coverage = new SimulationEngine({
      ...createDefaultConfig('coverage', 'obstructed'),
      ...shared,
    })
    const pmfs = new SimulationEngine({
      ...createDefaultConfig('pmfs', 'obstructed'),
      ...shared,
    })
    expect(coverage.scenario.baseWind).toEqual(pmfs.scenario.baseWind)
    expect(coverage.scenario.turbulence).toBe(pmfs.scenario.turbulence)
    expect(coverage.scenario.gustStrength).toBe(pmfs.scenario.gustStrength)
    expect(coverage.scenario.diffusivity).toBe(pmfs.scenario.diffusivity)
    expect(coverage.scenario.emissionRateScale).toBe(1.7)
    expect(coverage.scenario.obstacles).toEqual(pmfs.scenario.obstacles)
    expect(coverage.scenario.obstacles).toHaveLength(16)
    expect(coverage.plume.puffsAt(12)).toEqual(pmfs.plume.puffsAt(12))
  })

  it.each(ALGORITHM_ORDER)('%s deterministically replays non-default flow', (algorithmId) => {
    const config = {
      ...createDefaultConfig(algorithmId, 'obstructed'),
      seed: 73_421,
      windDirectionDegrees: 140,
      windSpeedScale: 1.35,
      turbulenceScale: 0.7,
      gustStrength: 0.22,
      diffusivityScale: 1.8,
      emissionRateScale: 1.45,
      obstacleComplexityLevel: 5,
      stopOnNativeDeclaration: false,
    }
    const first = new SimulationEngine(config)
    const second = new SimulationEngine(config)
    for (let index = 0; index < 48; index += 1) {
      first.step()
      second.step()
    }
    const firstFrame = first.getFrame()
    const secondFrame = second.getFrame()
    expect(firstFrame.scenario).toEqual(secondFrame.scenario)
    expect(first.plume.puffsAt(firstFrame.time)).toEqual(
      second.plume.puffsAt(secondFrame.time),
    )
    expect(firstFrame.robot).toEqual(secondFrame.robot)
    expect(firstFrame.measurement).toEqual(secondFrame.measurement)
    expect(firstFrame.observations).toEqual(secondFrame.observations)
    expect(firstFrame.decision).toEqual(secondFrame.decision)
    expect(firstFrame.metrics.normalizedError).toBe(secondFrame.metrics.normalizedError)
    expect(firstFrame.metrics.hitCount).toBe(secondFrame.metrics.hitCount)
  })

  it('rejects out-of-range flow overrides', () => {
    expect(
      () => new SimulationEngine({ ...createDefaultConfig(), windDirectionDegrees: 361 }),
    ).toThrow(/windDirectionDegrees/)
    expect(
      () => new SimulationEngine({ ...createDefaultConfig(), diffusivityScale: 0 }),
    ).toThrow(/diffusivityScale/)
    expect(
      () => new SimulationEngine({ ...createDefaultConfig(), emissionRateScale: 3.1 }),
    ).toThrow(/emissionRateScale/)
    expect(
      () => new SimulationEngine({ ...createDefaultConfig(), obstacleComplexityLevel: -1 }),
    ).toThrow(/obstacleComplexityLevel/)
    expect(
      () => new SimulationEngine({ ...createDefaultConfig(), obstacleComplexityLevel: 2.5 }),
    ).toThrow(/obstacleComplexityLevel/)
    expect(
      () => new SimulationEngine({ ...createDefaultConfig(), obstacleComplexityLevel: 6 }),
    ).toThrow(/obstacleComplexityLevel/)
    expect(
      () => new SimulationEngine({
        ...createDefaultConfig('coverage', 'obstructed'),
        physicsMode: 'grid',
        gridResolution: 32,
        obstacleComplexityLevel: 5,
      }),
    ).toThrow(/gridResolution/)
  })

  it('uses exact segment-to-obstacle intersection for thin crossed geometry', () => {
    expect(segmentIntersectsObstacle(
      { x: 0, y: 0.503 },
      { x: 1, y: 0.503 },
      { id: 'thin', x: 0.501, y: 0.5, width: 0.002, height: 0.006 },
    )).toBe(true)
    expect(segmentIntersectsObstacle(
      { x: 0, y: 0.49 },
      { x: 1, y: 0.49 },
      { id: 'thin', x: 0.501, y: 0.5, width: 0.002, height: 0.006 },
    )).toBe(false)
  })

  it('keeps analytical obstacle physics invariant to obstacle array order', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('coverage', 'obstructed'),
      seed: 8128,
      obstacleComplexityLevel: 5,
    })
    const reversedScenario = {
      ...engine.scenario,
      obstacles: [...engine.scenario.obstacles].reverse(),
    }
    const reversed = new FilamentPlume(reversedScenario, engine.config.seed)
    const points = [
      { x: 0.31, y: 0.24 },
      { x: 0.53, y: 0.71 },
      { x: 0.68, y: 0.39 },
    ]
    for (const point of points) {
      const wind = engine.plume.windAt(point, 11.5)
      const reversedWind = reversed.windAt(point, 11.5)
      expect(reversedWind.x).toBeCloseTo(wind.x, 12)
      expect(reversedWind.y).toBeCloseTo(wind.y, 12)
      expect(reversed.concentrationAt(point, 11.5)).toBeCloseTo(
        engine.plume.concentrationAt(point, 11.5),
        12,
      )
      expect(reversed.expectedHitRate({ x: 0.82, y: 0.5 }, point, 11.5)).toBeCloseTo(
        engine.plume.expectedHitRate({ x: 0.82, y: 0.5 }, point, 11.5),
        12,
      )
    }
    const puffs = engine.plume.puffsAt(11.5)
    const reversedPuffs = reversed.puffsAt(11.5)
    expect(reversedPuffs).toHaveLength(puffs.length)
    for (let index = 0; index < puffs.length; index += 1) {
      expect(reversedPuffs[index]?.position.x).toBeCloseTo(puffs[index]?.position.x ?? 0, 12)
      expect(reversedPuffs[index]?.position.y).toBeCloseTo(puffs[index]?.position.y ?? 0, 12)
    }
  })

  it.each([
    [0, 'filament', 32],
    [1, 'filament', 32],
    [3, 'filament', 32],
    [5, 'filament', 32],
    [0, 'grid', 32],
    [1, 'grid', 32],
    [3, 'grid', 32],
    [5, 'grid', 48],
  ] as const)(
    'keeps process-floor L%s finite with %s physics',
    (obstacleComplexityLevel, physicsMode, gridResolution) => {
      const engine = new SimulationEngine({
        ...createDefaultConfig('coverage', 'obstructed'),
        durationSeconds: 3,
        checkpointSeconds: [3],
        obstacleComplexityLevel,
        physicsMode,
        gridResolution,
      })
      const frame = engine.runToCompletion()
      expect(Number.isFinite(frame.measurement.concentration)).toBe(true)
      expect(Number.isFinite(frame.metrics.normalizedError)).toBe(true)
    },
  )
})
