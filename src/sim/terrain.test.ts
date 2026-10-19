import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config'
import { SimulationEngine } from './engine'
import { GridPlume } from './gridPlume'
import { FilamentPlume } from './plume'
import { createScenario } from './scenarios'
import {
  horizontalReachForSurfaceDistance,
  terrainGasDrift,
  terrainGradient,
  terrainHeightAt,
  terrainMobilityScale,
  terrainNearSurfaceLossRate,
  terrainSurfaceDistance,
} from './terrain'
import type { Scenario } from './types'

const scenarioFor = (overrides: Partial<ReturnType<typeof createDefaultConfig>> = {}) => {
  const config = { ...createDefaultConfig('coverage', 'open'), ...overrides }
  return createScenario('open', config.seed, config)
}

const puffCentroid = (plume: FilamentPlume, time: number) => {
  const puffs = plume.puffsAt(time)
  const weight = puffs.reduce((sum, puff) => sum + puff.intensity, 0)
  return {
    x: puffs.reduce((sum, puff) => sum + puff.position.x * puff.intensity, 0) / weight,
    y: puffs.reduce((sum, puff) => sum + puff.position.y * puff.intensity, 0) / weight,
  }
}

const gridCentroid = (plume: GridPlume, time: number) => {
  const snapshot = plume.gridAt(time)
  let mass = 0
  let xMoment = 0
  let yMoment = 0
  for (let index = 0; index < snapshot.values.length; index += 1) {
    const value = snapshot.values[index] ?? 0
    const x = ((index % snapshot.width) + 0.5) / snapshot.width
    const y = (Math.floor(index / snapshot.width) + 0.5) / snapshot.height
    mass += value
    xMoment += x * value
    yMoment += y * value
  }
  return { x: xMoment / mass, y: yMoment / mass, mass }
}

describe('2.5D planar terrain model', () => {
  it('matches the analytical height gradient and surface metric', () => {
    const scenario = scenarioFor({
      terrainSlopeDegrees: 10,
      terrainUphillDirectionDegrees: 0,
    })
    const grade = Math.tan(10 * Math.PI / 180)
    expect(terrainGradient(10, 0).x).toBeCloseTo(0, 14)
    expect(terrainGradient(10, 0).y).toBeCloseTo(-grade, 14)
    expect(terrainHeightAt(scenario, { x: 0.5, y: 0.4 })).toBeCloseTo(grade * 0.1, 14)
    expect(terrainSurfaceDistance(
      scenario,
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.4 },
    )).toBeCloseTo(0.1 / Math.cos(10 * Math.PI / 180), 14)
    expect(terrainSurfaceDistance(
      scenario,
      { x: 0.5, y: 0.5 },
      { x: 0.6, y: 0.5 },
    )).toBeCloseTo(0.1, 14)
    expect(terrainGradient(10, 360).x).toBeCloseTo(terrainGradient(10, 0).x, 14)
    expect(terrainGradient(10, 360).y).toBeCloseTo(terrainGradient(10, 0).y, 14)
  })

  it('reduces plan mobility by direction while remaining bounded and monotonic', () => {
    const moderate = scenarioFor({ terrainSlopeDegrees: 10, robotSlopeLimitDegrees: 25 })
    const steep = scenarioFor({ terrainSlopeDegrees: 20, robotSlopeLimitDegrees: 25 })
    const uphill = { x: 0, y: -1 }
    const downhill = { x: 0, y: 1 }
    const crossSlope = { x: 1, y: 0 }
    const uphillScale = terrainMobilityScale(steep, uphill)
    const downhillScale = terrainMobilityScale(steep, downhill)
    const crossScale = terrainMobilityScale(steep, crossSlope)
    expect(uphillScale).toBeGreaterThan(0)
    expect(uphillScale).toBeLessThan(downhillScale)
    expect(uphillScale).toBeLessThan(crossScale)
    expect(downhillScale).toBeLessThanOrEqual(1)
    expect(crossScale).toBeLessThanOrEqual(1)
    expect(terrainMobilityScale(moderate, uphill)).toBeGreaterThan(uphillScale)
    expect(terrainMobilityScale(scenarioFor({ terrainSlopeDegrees: 0 }), uphill)).toBe(1)
  })

  it('interprets active-probe reach as surface distance', () => {
    const scenario = scenarioFor({ terrainSlopeDegrees: 20 })
    const nominalReach = 0.1
    const uphillReach = horizontalReachForSurfaceDistance(
      scenario,
      { x: 0, y: -1 },
      nominalReach,
    )
    const crossReach = horizontalReachForSurfaceDistance(
      scenario,
      { x: 1, y: 0 },
      nominalReach,
    )
    expect(uphillReach).toBeCloseTo(nominalReach * Math.cos(20 * Math.PI / 180), 14)
    expect(crossReach).toBeCloseTo(nominalReach, 14)
  })

  it('gives dense gas downslope drift and light gas near-surface loss', () => {
    const dense = scenarioFor({
      terrainSlopeDegrees: 15,
      terrainUphillDirectionDegrees: 0,
      gasBuoyancy: 'dense',
      terrainGasDriftScale: 1.5,
    })
    const reversed = { ...dense, terrainUphillDirectionDegrees: 180 } satisfies Scenario
    const neutral = { ...dense, gasBuoyancy: 'neutral' } satisfies Scenario
    const light = { ...dense, gasBuoyancy: 'light' } satisfies Scenario
    expect(terrainGasDrift(dense).y).toBeGreaterThan(0)
    expect(terrainGasDrift(reversed).y).toBeLessThan(0)
    expect(terrainGasDrift(neutral)).toEqual({ x: 0, y: 0 })
    expect(terrainGasDrift(light)).toEqual({ x: 0, y: 0 })
    expect(terrainNearSurfaceLossRate(light)).toBeGreaterThan(0)
    expect(terrainNearSurfaceLossRate(dense)).toBe(0)
  })

  it('keeps ambient wind sensing separate from gas transport', () => {
    const common = {
      terrainSlopeDegrees: 15,
      terrainUphillDirectionDegrees: 0,
      terrainGasDriftScale: 2,
      sensorNoise: 0,
      windNoise: 0,
    } as const
    const neutralEngine = new SimulationEngine({
      ...createDefaultConfig('coverage', 'open'),
      ...common,
      gasBuoyancy: 'neutral',
    })
    const denseEngine = new SimulationEngine({
      ...createDefaultConfig('coverage', 'open'),
      ...common,
      gasBuoyancy: 'dense',
    })
    const point = { x: 0.4, y: 0.5 }
    expect(denseEngine.plume.windAt(point, 3)).toEqual(
      neutralEngine.plume.windAt(point, 3),
    )
    expect(denseEngine.plume.transportAt(point, 3)).not.toEqual(
      neutralEngine.plume.transportAt(point, 3),
    )
    neutralEngine.step()
    denseEngine.step()
    expect(denseEngine.getFrame().measurement.wind).toEqual(
      neutralEngine.getFrame().measurement.wind,
    )
  })

  it('moves dense filaments downslope while light gas only loses surface mass', () => {
    const common = scenarioFor({
      terrainSlopeDegrees: 18,
      terrainUphillDirectionDegrees: 0,
      terrainGasDriftScale: 2,
    })
    const still = { ...common, baseWind: { x: 0, y: 0 }, source: { x: 0.5, y: 0.5 } }
    const neutral = new FilamentPlume({ ...still, gasBuoyancy: 'neutral' }, 91)
    const dense = new FilamentPlume({ ...still, gasBuoyancy: 'dense' }, 91)
    const light = new FilamentPlume({ ...still, gasBuoyancy: 'light' }, 91)
    const neutralPuffs = neutral.puffsAt(8)
    const lightPuffs = light.puffsAt(8)
    const neutralCentroid = puffCentroid(neutral, 8)
    const denseCentroid = puffCentroid(dense, 8)
    expect(denseCentroid.y).toBeGreaterThan(neutralCentroid.y)
    // Light gas has no fictitious uphill velocity: the same seeded puffs occupy
    // the same positions. Its age-dependent surface loss can legitimately move
    // an intensity-weighted centroid by preferentially depleting older puffs.
    expect(lightPuffs.map((puff) => puff.position)).toEqual(
      neutralPuffs.map((puff) => puff.position),
    )
    expect(lightPuffs.every((puff, index) =>
      puff.intensity <= (neutralPuffs[index]?.intensity ?? 0))).toBe(true)
    expect(light.totalMassAt(8)).toBeLessThan(neutral.totalMassAt(8))
  })

  it('applies the same dense-gas direction and light-gas loss in the grid solver', () => {
    const common = scenarioFor({
      terrainSlopeDegrees: 15,
      terrainUphillDirectionDegrees: 0,
      terrainGasDriftScale: 2,
    })
    const still = { ...common, baseWind: { x: 0, y: 0 }, source: { x: 0.5, y: 0.5 } }
    const neutral = new GridPlume({ ...still, gasBuoyancy: 'neutral' }, 101, { resolution: 48 })
    const dense = new GridPlume({ ...still, gasBuoyancy: 'dense' }, 101, { resolution: 48 })
    const light = new GridPlume({ ...still, gasBuoyancy: 'light' }, 101, { resolution: 48 })
    const neutralCentroid = gridCentroid(neutral, 5)
    const denseCentroid = gridCentroid(dense, 5)
    const lightCentroid = gridCentroid(light, 5)
    expect(denseCentroid.y).toBeGreaterThan(neutralCentroid.y)
    expect(lightCentroid.x).toBeCloseTo(neutralCentroid.x, 4)
    expect(lightCentroid.y).toBeCloseTo(neutralCentroid.y, 4)
    expect(lightCentroid.mass).toBeLessThan(neutralCentroid.mass)
  })

  it('makes all plume effects exactly inert at zero slope', () => {
    const flat = scenarioFor({ terrainSlopeDegrees: 0, gasBuoyancy: 'neutral' })
    const inert = scenarioFor({
      terrainSlopeDegrees: 0,
      terrainUphillDirectionDegrees: 275,
      gasBuoyancy: 'dense',
      terrainGasDriftScale: 3,
    })
    const first = new FilamentPlume(flat, 72)
    const second = new FilamentPlume(inert, 72)
    expect(second.puffsAt(10)).toEqual(first.puffsAt(10))
    expect(second.concentrationAt({ x: 0.4, y: 0.6 }, 10)).toBe(
      first.concentrationAt({ x: 0.4, y: 0.6 }, 10),
    )
    expect(second.expectedHitRate({ x: 0.8, y: 0.5 }, { x: 0.3, y: 0.6 }, 10)).toBe(
      first.expectedHitRate({ x: 0.8, y: 0.5 }, { x: 0.3, y: 0.6 }, 10),
    )
  })

  it('keeps terrain independent of source, start, and obstacle generation', () => {
    const base = createDefaultConfig('coverage', 'obstructed')
    const flat = createScenario('obstructed', 771, base)
    const slope = createScenario('obstructed', 771, {
      ...base,
      terrainSlopeDegrees: 20,
      terrainUphillDirectionDegrees: 245,
      gasBuoyancy: 'dense',
    })
    expect(slope.source).toEqual(flat.source)
    expect(slope.robotStart).toEqual(flat.robotStart)
    expect(slope.obstacles).toEqual(flat.obstacles)
    expect(slope.baseWind).toEqual(flat.baseWind)
  })

  it('records plan distance, surface distance, ascent, and mobility separately', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('coverage', 'open'),
      terrainSlopeDegrees: 15,
      terrainUphillDirectionDegrees: 270,
      durationSeconds: 8,
      checkpointSeconds: [8],
      stopOnNativeDeclaration: false,
    })
    const metrics = engine.runToCompletion().metrics
    expect(metrics.surfacePathLengthNormalized).toBeGreaterThanOrEqual(
      metrics.pathLengthNormalized,
    )
    expect(metrics.elevationGainMeters).toBeGreaterThanOrEqual(0)
    expect(metrics.elevationLossMeters).toBeGreaterThanOrEqual(0)
    expect(metrics.meanTerrainMobilityScale).toBeGreaterThan(0)
    expect(metrics.meanTerrainMobilityScale).toBeLessThanOrEqual(1)
    expect(Number.isFinite(metrics.surfacePathOverhead)).toBe(true)
  })

  it('rejects invalid terrain controls', () => {
    expect(() => new SimulationEngine({
      ...createDefaultConfig(),
      terrainSlopeDegrees: 31,
    })).toThrow(/terrainSlopeDegrees/)
    expect(() => new SimulationEngine({
      ...createDefaultConfig(),
      terrainUphillDirectionDegrees: -1,
    })).toThrow(/terrainUphillDirectionDegrees/)
    expect(() => new SimulationEngine({
      ...createDefaultConfig(),
      gasBuoyancy: 'dense-ish' as 'dense',
    })).toThrow(/gasBuoyancy/)
    expect(() => new SimulationEngine({
      ...createDefaultConfig(),
      terrainGasDriftScale: 3.1,
    })).toThrow(/terrainGasDriftScale/)
  })
})
