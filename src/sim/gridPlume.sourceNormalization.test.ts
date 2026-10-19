import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config'
import { GridPlume } from './gridPlume'
import { createScenario } from './scenarios'
import type { Scenario } from './types'

const makeScenario = (source: { x: number; y: number }): Scenario => ({
  ...createScenario('open', 71, createDefaultConfig()),
  source,
  robotStart: { x: 0.5, y: 0.5 },
  baseWind: { x: 0, y: 0 },
  turbulence: 0,
  gustStrength: 0,
  diffusivity: 0,
  referenceDiffusivity: 0,
  intermittency: 0,
  obstacles: [],
})

const injectedMass = (plume: GridPlume, step: number) =>
  plume.totalMassAt(step) - plume.totalMassAt(0)

const initialMass = (resolution: number, source: { x: number; y: number }) =>
  new GridPlume(makeScenario(source), 4, {
    resolution,
    decaySeconds: 1e9,
    sourceRate: 0.01,
  }).totalMassAt(0)

describe('GridPlume source normalization', () => {
  it('keeps the integrated source increment stable across resolutions', () => {
    const increments = [24, 48, 96].map((resolution) =>
      injectedMass(
        new GridPlume(makeScenario({ x: 0.5, y: 0.5 }), 4, {
          resolution,
          stepSeconds: 0.01,
          decaySeconds: 1e9,
          sourceRate: 0.01,
        }),
        0.01,
      ),
    )

    expect(Math.max(...increments) / Math.min(...increments)).toBeLessThan(1.03)
  })

  it('renormalizes the footprint when the source is close to a domain edge', () => {
    const center = injectedMass(
      new GridPlume(makeScenario({ x: 0.5, y: 0.5 }), 4, {
        resolution: 48,
        stepSeconds: 0.01,
        decaySeconds: 1e9,
        sourceRate: 0.01,
      }),
      0.01,
    )
    const edge = injectedMass(
      new GridPlume(makeScenario({ x: 0.005, y: 0.005 }), 4, {
        resolution: 48,
        stepSeconds: 0.01,
        decaySeconds: 1e9,
        sourceRate: 0.01,
      }),
      0.01,
    )

    expect(edge / center).toBeGreaterThan(0.97)
    expect(edge / center).toBeLessThan(1.03)
  })

  it('uses the same normalized source footprint for the initial field', () => {
    const centerMass = [24, 48, 96].map((resolution) =>
      initialMass(resolution, { x: 0.5, y: 0.5 }),
    )
    const edgeMass = initialMass(48, { x: 0.005, y: 0.005 })

    expect(Math.max(...centerMass) / Math.min(...centerMass)).toBeLessThan(1.03)
    expect(edgeMass / centerMass[1]!).toBeGreaterThan(0.97)
    expect(edgeMass / centerMass[1]!).toBeLessThan(1.03)
  })
})
