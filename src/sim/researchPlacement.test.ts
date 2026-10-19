import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config'
import { SimulationEngine } from './engine'
import { createScenario } from './scenarios'

describe('research placement overrides', () => {
  it('uses prescribed source, start and mathematical plan heading', () => {
    const config = {
      ...createDefaultConfig('quad-sniff', 'open'),
      sourcePositionOverride: { x: 0.2, y: 0.75 },
      robotStartPositionOverride: { x: 0.8, y: 0.25 },
      robotStartHeadingDegrees: 90,
    }
    const engine = new SimulationEngine(config)
    const frame = engine.getFrame()

    expect(frame.scenario.source).toEqual(config.sourcePositionOverride)
    expect(frame.scenario.robotStart).toEqual(config.robotStartPositionOverride)
    expect(frame.robot.position).toEqual(config.robotStartPositionOverride)
    expect(frame.robot.heading).toBeCloseTo(Math.PI / 2, 12)
    expect('source' in engine.environment.scenario).toBe(false)
  })

  it('rejects placements outside the normalized domain', () => {
    expect(() => new SimulationEngine({
      ...createDefaultConfig(),
      sourcePositionOverride: { x: 1.01, y: 0.5 },
    })).toThrow(/sourcePositionOverride/)
  })

  it('accepts research-only grid refinements beyond the live default', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('coverage', 'open'),
      physicsMode: 'grid',
      gridResolution: 192,
      durationSeconds: 1,
      checkpointSeconds: [1],
    })
    expect(engine.config.gridResolution).toBe(192)
  })

  it('rejects an overridden start inside generated process-floor geometry', () => {
    const base = createDefaultConfig('coverage', 'obstructed')
    const scenario = createScenario('obstructed', base.seed, base)
    const obstacle = scenario.obstacles[0]
    expect(obstacle).toBeDefined()
    if (!obstacle) return

    expect(() => new SimulationEngine({
      ...base,
      robotStartPositionOverride: {
        x: obstacle.x + obstacle.width / 2,
        y: obstacle.y + obstacle.height / 2,
      },
    })).toThrow(/robotStartPositionOverride/)
  })
})
