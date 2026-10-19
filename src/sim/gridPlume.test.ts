import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config'
import { GRID_TARGET_ADVECTIVE_COURANT, GridPlume } from './gridPlume'
import { FilamentPlume } from './plume'
import { createScenario } from './scenarios'
import type { Scenario } from './types'

const makeScenario = (overrides: Partial<Scenario> = {}): Scenario => ({
  ...createScenario('open', 71, createDefaultConfig()),
  source: { x: 0.25, y: 0.5 },
  robotStart: { x: 0.1, y: 0.5 },
  baseWind: { x: 0.065, y: 0 },
  turbulence: 0,
  gustStrength: 0,
  diffusivity: 0.00004,
  referenceDiffusivity: 0.00004,
  intermittency: 0.2,
  obstacles: [],
  ...overrides,
})

const centroid = (values: readonly number[], width: number) => {
  let mass = 0
  let xMoment = 0
  let yMoment = 0
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!
    const x = ((index % width) + 0.5) / width
    const y = (Math.floor(index / width) + 0.5) / width
    mass += value
    xMoment += value * x
    yMoment += value * y
  }
  return { x: xMoment / mass, y: yMoment / mass, mass }
}

const radialVariance = (
  values: readonly number[],
  width: number,
  center: { x: number; y: number },
) => {
  let mass = 0
  let moment = 0
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!
    const x = ((index % width) + 0.5) / width
    const y = (Math.floor(index / width) + 0.5) / width
    mass += value
    moment += value * ((x - center.x) ** 2 + (y - center.y) ** 2)
  }
  return moment / mass
}

describe('GridPlume', () => {
  it('advects concentration in the configured wind direction', () => {
    const eastScenario = makeScenario()
    const westScenario = makeScenario({
      source: { x: 0.75, y: 0.5 },
      baseWind: { x: -0.065, y: 0 },
    })
    const options = { resolution: 32, stepSeconds: 0.16 }
    const east = new GridPlume(eastScenario, 17, options).gridAt(6)
    const west = new GridPlume(westScenario, 17, options).gridAt(6)

    expect(centroid(east.values, east.width).x).toBeGreaterThan(
      eastScenario.source!.x + 0.06,
    )
    expect(centroid(west.values, west.width).x).toBeLessThan(
      westScenario.source!.x - 0.06,
    )
  })

  it('broadens a still plume when molecular diffusivity increases', () => {
    const low = makeScenario({
      source: { x: 0.5, y: 0.5 },
      baseWind: { x: 0, y: 0 },
      diffusivity: 0.000015,
    })
    const high = makeScenario({
      source: { x: 0.5, y: 0.5 },
      baseWind: { x: 0, y: 0 },
      diffusivity: 0.00028,
    })
    const options = { resolution: 36, stepSeconds: 0.14 }
    const lowField = new GridPlume(low, 23, options).gridAt(5)
    const highField = new GridPlume(high, 23, options).gridAt(5)

    expect(radialVariance(highField.values, highField.width, high.source!)).toBeGreaterThan(
      radialVariance(lowField.values, lowField.width, low.source!) * 1.35,
    )
  })

  it('uses solid cells and no-through-flow transport at obstacles', () => {
    const wall = { id: 'wall', x: 0.46, y: 0.22, width: 0.08, height: 0.56 }
    const open = makeScenario()
    const blocked = makeScenario({ obstacles: [wall] })
    const options = { resolution: 40, stepSeconds: 0.13 }
    const openPlume = new GridPlume(open, 31, options)
    const blockedPlume = new GridPlume(blocked, 31, options)
    const sample = { x: 0.62, y: 0.5 }

    expect(blockedPlume.concentrationAt({ x: 0.5, y: 0.5 }, 7)).toBe(0)
    expect(blockedPlume.concentrationAt(sample, 7)).toBeLessThan(
      openPlume.concentrationAt(sample, 7) * 0.2,
    )
    const snapshot = blockedPlume.gridAt(7)
    expect(snapshot.blocked.some(Boolean)).toBe(true)
    snapshot.blocked.forEach((isBlocked, index) => {
      if (isBlocked) expect(snapshot.values[index]).toBe(0)
    })
  })

  it('is deterministic for repeated and out-of-order time queries', () => {
    const scenario = makeScenario({ turbulence: 0.45, gustStrength: 0.25 })
    const options = { resolution: 28, stepSeconds: 0.17 }
    const first = new GridPlume(scenario, 919, options)
    const second = new GridPlume(scenario, 919, options)

    const sixSeconds = first.gridAt(6.125)
    first.gridAt(2.4)
    expect(first.gridAt(6.125).values).toEqual(sixSeconds.values)
    expect(second.gridAt(6.125).values).toEqual(sixSeconds.values)
    expect(first.concentrationsAt([{ x: 0.4, y: 0.5 }], 6.125)[0]).toBe(
      first.concentrationAt({ x: 0.4, y: 0.5 }, 6.125),
    )
  })

  it('automatically enforces diffusion stability and bounds the field', () => {
    const scenario = makeScenario({ diffusivity: 0.003 })
    const plume = new GridPlume(scenario, 5, {
      resolution: 20,
      stepSeconds: 1,
    })
    const diffusionNumber =
      (scenario.diffusivity * plume.stepSeconds) / (1 / plume.resolution) ** 2
    const snapshot = plume.gridAt(2)

    expect(diffusionNumber).toBeLessThanOrEqual(0.2200001)
    expect(snapshot.values.every((value) => Number.isFinite(value))).toBe(true)
    expect(Math.min(...snapshot.values)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...snapshot.values)).toBeLessThanOrEqual(1)
    expect(plume.concentrationAt({ x: -0.1, y: 0.5 }, 2)).toBe(0)
  })

  it('limits backtrace length under strong ambient and dense-gas transport', () => {
    const scenario = makeScenario({
      kind: 'obstructed',
      baseWind: { x: 0.18, y: 0 },
      gustStrength: 0.5,
      terrainSlopeDegrees: 30,
      terrainUphillDirectionDegrees: 0,
      gasBuoyancy: 'dense',
      terrainGasDriftScale: 3,
      obstacles: [{ id: 'wake', x: 0.45, y: 0.35, width: 0.08, height: 0.3 }],
    })
    const plume = new GridPlume(scenario, 7, {
      resolution: 96,
      stepSeconds: 1,
    })

    expect(plume.advectiveCourantEstimate).toBeLessThanOrEqual(
      GRID_TARGET_ADVECTIVE_COURANT + 1e-12,
    )
    expect(plume.transportSpeedEnvelope).toBeGreaterThan(
      Math.hypot(scenario.baseWind.x, scenario.baseWind.y),
    )
    expect(plume.stepSeconds).toBeLessThan(0.02)
  })

  it('shares the configured wind and inverse observation model', () => {
    const scenario = makeScenario({ turbulence: 0.38, gustStrength: 0.2 })
    const grid = new GridPlume(scenario, 83, { resolution: 24 })
    const analytical = new FilamentPlume(scenario, 83)
    const point = { x: 0.58, y: 0.67 }
    const candidate = { x: 0.24, y: 0.49 }

    expect(grid.windAt(point, 4.2)).toEqual(analytical.windAt(point, 4.2))
    expect(grid.expectedHitRate(candidate, point, 4.2)).toBe(
      analytical.expectedHitRate(candidate, point, 4.2),
    )
    expect(grid.puffsAt(4.2)).toEqual([])
  })

  it('validates numerical settings', () => {
    const scenario = makeScenario()
    expect(() => new GridPlume(scenario, 1, { resolution: 10 })).toThrow(RangeError)
    expect(() => new GridPlume(scenario, 1, { stepSeconds: 0 })).toThrow(RangeError)
    expect(() => new GridPlume({ ...scenario, diffusivity: -1 }, 1)).toThrow(
      RangeError,
    )
  })
})
