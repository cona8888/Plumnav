import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config'
import { GridPlume, GRID_TARGET_ADVECTIVE_COURANT } from './gridPlume'
import { createScenario } from './scenarios'
import type { GridMassBudget, Scenario } from './types'

const scenario = (overrides: Partial<Scenario> = {}): Scenario => ({
  ...createScenario('open', 71, createDefaultConfig()),
  source: { x: 0.25, y: 0.5 },
  baseWind: { x: 0.065, y: 0 },
  turbulence: 0,
  gustStrength: 0,
  diffusivity: 0,
  referenceDiffusivity: 0,
  intermittency: 0,
  obstacles: [],
  ...overrides,
})
const conservative = 'conservative-upwind-v1' as const
// Documented reference-scale integral of a radially truncated Gaussian (3 sigma).
// This is an independent integrated source specification, not a solver helper.
const referenceMass = 2 * Math.PI * 0.015 ** 2 * (1 - Math.exp(-4.5))
const fieldMass = (values: number[], n: number) => values.reduce((a, b) => a + b, 0) / n ** 2
const expectClosed = (budget: GridMassBudget, independentMass: number) => {
  const expected = budget.initialMass + budget.injectedMass - budget.decayLossMass -
    budget.boundaryOutflowMass - budget.upperClippingLossMass + budget.lowerClippingGainMass
  expect(independentMass).toBeCloseTo(expected, 13)
  expect(budget.currentMass).toBeCloseTo(independentMass, 15)
  expect(Math.abs(budget.balanceResidual)).toBeLessThan(1e-13)
}

const wall = { id: 'wall', x: 0.45, y: 0, width: 0.1, height: 1 }

describe('GridPlume conservative scalar transport', () => {
  it.each([32, 64, 128])('conserves the independently specified source budget at a solid wall, n=%i', (resolution) => {
    // Deliberately prescribed wind into a wall tests zero scalar face flux;
    // this does not claim a self-consistent incompressible wall velocity field.
    for (const stepSeconds of [0.025, 0.1]) {
      const plume = new GridPlume(scenario({ obstacles: [wall] }), 4, {
        resolution, stepSeconds, decaySeconds: 1e9, sourceRate: 0.01,
        transportVersion: conservative,
      })
      const snapshot = plume.gridAt(6)
      const budget = snapshot.massBudget!
      expect(budget.initialMass).toBeCloseTo(referenceMass * 0.35 * 0.01 / 1.8, 14)
      expect(budget.injectedMass).toBeCloseTo(referenceMass * 0.01 * 6, 14)
      expect(budget.boundaryOutflowMass).toBe(0)
      expect(budget.upperClippingLossMass).toBe(0)
      expect(budget.lowerClippingGainMass).toBe(0)
      expectClosed(budget, fieldMass(snapshot.values, resolution))
      expect(snapshot.values.every((value, index) =>
        value >= 0 && value <= 1 && (!snapshot.blocked[index] || value === 0),
      )).toBe(true)
    }
  })

  it.each([
    { source: { x: 0.99, y: 0.99 }, wind: { x: 0.1, y: 0.07 } },
    { source: { x: 0.01, y: 0.01 }, wind: { x: -0.1, y: -0.07 } },
  ])('measures exterior outflow from the independent boundary integral ($wind)', ({ source, wind }) => {
    const n = 32
    const dt = 0.01
    const plume = new GridPlume(scenario({ source, baseWind: wind }), 4, {
      resolution: n, stepSeconds: dt, decaySeconds: 1e9, sourceRate: 0.01,
      transportVersion: conservative,
    })
    const initial = plume.gridAt(0).values
    const boundaryX = wind.x > 0 ? n - 1 : 0
    const boundaryY = wind.y > 0 ? n - 1 : 0
    let expectedOutflow = 0
    for (let i = 0; i < n; i += 1) {
      expectedOutflow += dt / n * (Math.abs(wind.x) * initial[i * n + boundaryX]! +
        Math.abs(wind.y) * initial[boundaryY * n + i]!)
    }
    const snapshot = plume.gridAt(dt)
    expect(expectedOutflow).toBeGreaterThan(0)
    expect(snapshot.massBudget!.boundaryOutflowMass).toBeCloseTo(expectedOutflow, 16)
    expectClosed(snapshot.massBudget!, fieldMass(snapshot.values, n))
  })

  it('matches the closed-form integrated decay/source recurrence without transport', () => {
    const dt = 0.05
    const time = 2
    const decaySeconds = 0.8
    const sourceRate = 0.01
    const plume = new GridPlume(scenario({ baseWind: { x: 0, y: 0 } }), 4, {
      resolution: 32, stepSeconds: dt, decaySeconds, sourceRate,
      transportVersion: conservative,
    })
    const survival = Math.exp(-dt / decaySeconds)
    const initial = referenceMass * 0.35 * sourceRate / 1.8
    const expectedMass = initial * Math.exp(-time / decaySeconds) +
      referenceMass * sourceRate * dt * (1 - Math.exp(-time / decaySeconds)) / (1 - survival)
    const snapshot = plume.gridAt(time)
    expect(fieldMass(snapshot.values, 32)).toBeCloseTo(expectedMass, 14)
    expect(snapshot.massBudget!.decayLossMass).toBeCloseTo(
      initial + referenceMass * sourceRate * time - expectedMass, 14,
    )
    expectClosed(snapshot.massBudget!, fieldMass(snapshot.values, 32))
  })

  it('accounts for initial and subsequent concentration ceiling losses', () => {
    const plume = new GridPlume(scenario({ baseWind: { x: 0, y: 0 } }), 4, {
      resolution: 32, stepSeconds: 0.05, decaySeconds: 1e9, sourceRate: 80,
      transportVersion: conservative,
    })
    const snapshot = plume.gridAt(0.2)
    const budget = snapshot.massBudget!
    expect(budget.initialClippingLossMass).toBeGreaterThan(0)
    expect(budget.initialMass + budget.initialClippingLossMass).toBeCloseTo(
      referenceMass * 0.35 * 80 / 1.8, 13,
    )
    expect(budget.upperClippingLossMass).toBeGreaterThan(0)
    expect(budget.lowerClippingGainMass).toBe(0)
    expect(budget.injectedMass).toBeCloseTo(referenceMass * 80 * 0.2, 13)
    expectClosed(budget, fieldMass(snapshot.values, 32))
  })

  it('enforces the sum-of-outgoing-speeds CFL even above the design envelope', () => {
    const plume = new GridPlume(scenario({ baseWind: { x: 0, y: 0 } }), 4, {
      resolution: 16, stepSeconds: 1, decaySeconds: 1e9, sourceRate: 0.01,
      transportVersion: conservative,
    })
    // Controlled manufactured transport tests the actual-face guard independently
    // of the constructor's design-speed estimate and obstacle heuristic.
    plume.transportAt = () => ({ x: 0.8, y: 0.8 })
    const snapshot = plume.gridAt(1)
    const budget = snapshot.massBudget!
    expect(budget.advectionSubsteps).toBeGreaterThanOrEqual(Math.ceil(1.6 * 16 / 0.9))
    expect(budget.maximumAdvectiveCourant).toBeLessThanOrEqual(GRID_TARGET_ADVECTIVE_COURANT)
    expect(budget.lowerClippingGainMass).toBe(0)
    expect(snapshot.values.every((value) => value >= 0 && Number.isFinite(value))).toBe(true)
    expectClosed(budget, fieldMass(snapshot.values, 16))
  })

  it.each([
    { name: 'outgoing speed sum overflow', velocity: { x: 1e308, y: 1e308 } },
    { name: 'Courant scaling overflow', velocity: { x: 1e308, y: 0 } },
    { name: 'unsafe finite substep count', velocity: { x: 1e15, y: 0 } },
  ])('rejects $name before starting advection substeps', ({ velocity }) => {
    const plume = new GridPlume(scenario({ baseWind: { x: 0, y: 0 } }), 4, {
      resolution: 16, stepSeconds: 1, sourceRate: 0.01, transportVersion: conservative,
    })
    plume.transportAt = () => velocity
    expect(() => plume.gridAt(1)).toThrow(RangeError)
    // A rejected query must not poison the already-valid initial state.
    expect(plume.gridAt(0).massBudget!.injectedMass).toBe(0)
  })

  it('rejects unrepresentable effective steps and query tick counts', () => {
    expect(() => new GridPlume(scenario({
      baseWind: { x: 1e308, y: 1e308 }, gustStrength: 1,
    }), 4, { resolution: 16, transportVersion: conservative })).toThrow(
      /effective stepSeconds must be finite and positive/,
    )
    const plume = new GridPlume(scenario({ baseWind: { x: 0, y: 0 } }), 4, {
      resolution: 16, stepSeconds: Number.MIN_VALUE, transportVersion: conservative,
    })
    expect(() => plume.gridAt(1)).toThrow(/query ticks must be finite safe integers/)
  })

  it('rejects nonrepresentable source initialization, forcing and derived updates', () => {
    expect(() => new GridPlume(scenario({
      source: { x: 0.001, y: 0.001 }, baseWind: { x: 0, y: 0 },
    }), 4, {
      resolution: 64, stepSeconds: 1, sourceRate: Number.MAX_VALUE, transportVersion: conservative,
    })).toThrow(/initial .* must be finite/)

    const forcing = new GridPlume(scenario({
      baseWind: { x: 0, y: 0 }, intermittency: 1,
    }), 4, {
      resolution: 16, stepSeconds: 1, sourceRate: Number.MAX_VALUE, transportVersion: conservative,
    })
    expect(() => forcing.gridAt(1)).toThrow(/source forcing must be finite/)

    const update = new GridPlume(scenario({
      source: { x: 0.001, y: 0.001 }, baseWind: { x: 0, y: 0 },
    }), 4, {
      resolution: 32, stepSeconds: 1, sourceRate: Number.MAX_VALUE, transportVersion: conservative,
    })
    expect(() => update.gridAt(1)).toThrow(/concentration update must be finite/)
  })

  it('closes thin solid faces for both advection and diffusion', () => {
    const plume = new GridPlume(scenario({
      source: { x: 0.42, y: 0.5 }, diffusivity: 0.0004,
      obstacles: [{ id: 'thin', x: 0.499, y: 0, width: 0.002, height: 1 }],
    }), 4, { resolution: 32, stepSeconds: 0.05, sourceRate: 0.01, transportVersion: conservative })
    const snapshot = plume.gridAt(3)
    expect(snapshot.blocked.some(Boolean)).toBe(false)
    expect(snapshot.values.every((value, index) => index % 32 < 16 || value === 0)).toBe(true)
    expectClosed(snapshot.massBudget!, fieldMass(snapshot.values, 32))
  })

  it('does not interpolate public readings through a thin solid wall', () => {
    const plume = new GridPlume(scenario({
      source: { x: 0.42, y: 0.5 }, diffusivity: 0.0004,
      obstacles: [{ id: 'thin', x: 0.499, y: 0, width: 0.002, height: 1 }],
    }), 4, { resolution: 32, stepSeconds: 0.05, sourceRate: 1.8, transportVersion: conservative })
    const rightPoints = [0.5011, 0.505, 0.51, 0.515625].map((x) => ({ x, y: 0.5 }))
    const leftPoint = { x: 0.495, y: 0.5 }
    for (const time of [3, 3.017]) {
      const snapshot = plume.gridAt(time)
      expect(snapshot.values.every((value, index) => index % 32 < 16 || value === 0)).toBe(true)
      for (const point of rightPoints) expect(plume.concentrationAt(point, time)).toBe(0)
      expect(plume.concentrationsAt(rightPoints, time)).toEqual([0, 0, 0, 0])
      expect(plume.concentrationAt(leftPoint, time)).toBeGreaterThan(0)
      const points = [leftPoint, ...rightPoints]
      expect(plume.concentrationsAt(points, time)).toEqual(
        points.map((point) => plume.concentrationAt(point, time)),
      )
    }
  })

  it.each(['legacy-semi-lagrangian-v1', conservative] as const)(
    'retains bilinear interpolation within an open region (%s)', (transportVersion) => {
      const plume = new GridPlume(scenario({
        diffusivity: 0.0004,
        obstacles: [{ id: 'thin', x: 0.499, y: 0, width: 0.002, height: 1 }],
      }), 4, { resolution: 32, stepSeconds: 0.05, sourceRate: 0.01, transportVersion })
      const time = 0.317
      const snapshot = plume.gridAt(time)
      // A quarter of a cell across and three quarters up from donor (8,15).
      // All four donor-to-query segments lie strictly in the open left region.
      const point = { x: 8.75 / 32, y: 16.25 / 32 }
      const expected = snapshot.values[15 * 32 + 8]! * 0.1875 +
        snapshot.values[15 * 32 + 9]! * 0.0625 +
        snapshot.values[16 * 32 + 8]! * 0.5625 +
        snapshot.values[16 * 32 + 9]! * 0.1875
      expect(expected).toBeGreaterThan(0)
      expect(plume.concentrationAt(point, time)).toBeCloseTo(expected, 15)
      expect(plume.concentrationsAt([point], time)[0]).toBeCloseTo(expected, 15)
    },
  )

  it('preserves the frozen legacy thin-wall public reading', () => {
    const plume = new GridPlume(scenario({
      source: { x: 0.42, y: 0.5 }, diffusivity: 0.0004,
      obstacles: [{ id: 'thin', x: 0.499, y: 0, width: 0.002, height: 1 }],
    }), 4, { resolution: 32, stepSeconds: 0.05, sourceRate: 1.8 })
    const point = { x: 0.505, y: 0.5 }
    expect(plume.concentrationAt(point, 3)).toBe(0.29773260474205016)
    expect(plume.concentrationsAt([point], 3)).toEqual([0.29773260474205016])
  })

  it('preserves fields and interpolated budgets under reordered checkpoint queries', () => {
    const options = { resolution: 24, stepSeconds: 0.05, sourceRate: 0.01, transportVersion: conservative }
    const first = new GridPlume(scenario({ diffusivity: 0.0002, gustStrength: 0.3 }), 4, options)
    const second = new GridPlume(first.scenario, 4, options)
    const later = first.gridAt(4.127)
    first.gridAt(0.123)
    expect(first.gridAt(4.127)).toEqual(later)
    expect(first.gridAt(1.263)).toEqual(second.gridAt(1.263))
    expect(second.gridAt(4.127)).toEqual(later)
    expectClosed(later.massBudget!, fieldMass(later.values, 24))
  })

  it('leaves the historical default explicit and reports no budget for it', () => {
    const options = { resolution: 32, stepSeconds: 0.05, sourceRate: 0.01, decaySeconds: 1e9 }
    const implicit = new GridPlume(scenario({ obstacles: [wall] }), 4, options)
    const explicit = new GridPlume(implicit.scenario, 4, { ...options, transportVersion: 'legacy-semi-lagrangian-v1' })
    expect(implicit.transportVersion).toBe('legacy-semi-lagrangian-v1')
    expect(implicit.gridAt(6)).toEqual(explicit.gridAt(6))
    expect(implicit.massBudgetAt(6)).toBeNull()
    // Frozen pre-fix diagnostic value from the independent original wall probe.
    expect(implicit.totalMassAt(6)).toBe(0.00004351844859940002)
  })
})
