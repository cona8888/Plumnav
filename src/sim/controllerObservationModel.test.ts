import { describe, expect, it } from 'vitest'
import { createControllerObservationModel } from './controllerObservationModel'
import { createScenario } from './scenarios'
import type { PublicScenario } from './controllerObservationModel'

const publicScenario = (source: { x: number; y: number }): PublicScenario => {
  const scenario = createScenario('open', 17, {
    windDirectionDegrees: 0,
    windSpeedScale: 1,
    turbulenceScale: 1,
    gustStrength: 0.12,
    diffusivityScale: 1,
    emissionRateScale: 1,
    obstacleComplexityLevel: 3,
    sourceSeed: 9,
    targetStatus: 'emitting',
    terrainSlopeDegrees: 0,
    terrainUphillDirectionDegrees: 0,
    gasBuoyancy: 'neutral',
    terrainGasDriftScale: 1,
    robotSlopeLimitDegrees: 25,
    sourcePositionOverride: source,
    robotStartPositionOverride: { x: 0.1, y: 0.5 },
  })
  const { source: _source, targetStatus: _targetStatus, ...publicFields } = scenario
  return publicFields
}

describe('controller observation model', () => {
  const point = { x: 0.31, y: 0.62 }
  const candidate = { x: 0.8, y: 0.52 }

  it('is independent of source placement and never accepts source input', () => {
    const a = createControllerObservationModel(publicScenario({ x: 0.78, y: 0.3 }), 404)
    const b = createControllerObservationModel(publicScenario({ x: 0.88, y: 0.7 }), 404)
    expect(a.windAt(point, 4.25)).toEqual(b.windAt(point, 4.25))
    expect(a.expectedHitRate(candidate, point, 4.25)).toBe(b.expectedHitRate(candidate, point, 4.25))
    expect(() => createControllerObservationModel({ ...publicScenario({ x: 0.8, y: 0.5 }), source: candidate } as never, 404)).toThrow(/without source/)
    expect(() => createControllerObservationModel({ ...publicScenario({ x: 0.8, y: 0.5 }), targetStatus: 'absent' } as never, 404)).toThrow(/target-presence truth/)
    expect('source' in a.scenario).toBe(false)
    expect('targetStatus' in a.scenario).toBe(false)
  })

  it('is deterministic, and model seed is separate from the world/source inputs', () => {
    const first = createControllerObservationModel(publicScenario({ x: 0.78, y: 0.3 }), 123)
    const second = createControllerObservationModel(publicScenario({ x: 0.78, y: 0.3 }), 123)
    const differentModelSeed = createControllerObservationModel(publicScenario({ x: 0.78, y: 0.3 }), 124)
    expect(first.windAt(point, 2.1)).toEqual(second.windAt(point, 2.1))
    expect(first.windAt(point, 2.1)).not.toEqual(differentModelSeed.windAt(point, 2.1))
    const formerlyAliased = createControllerObservationModel(
      publicScenario({ x: 0.78, y: 0.3 }),
      123 + 104_729,
    )
    expect(first.windAt(point, 2.1)).not.toEqual(formerlyAliased.windAt(point, 2.1))
    expect(first.modelSeed).toBe(123)
  })

  it('returns stable finite controller-compatible values', () => {
    const model = createControllerObservationModel(publicScenario({ x: 0.8, y: 0.5 }), 88)
    for (const time of [0, 1.5, 10, 40]) {
      const wind = model.windAt(point, time)
      const rate = model.expectedHitRate(candidate, point, time)
      expect(Number.isFinite(wind.x)).toBe(true)
      expect(Number.isFinite(wind.y)).toBe(true)
      expect(Number.isFinite(rate)).toBe(true)
      expect(rate).toBeGreaterThanOrEqual(0)
    }
  })
})
