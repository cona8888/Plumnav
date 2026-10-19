import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config'
import {
  generateFractalObstacles,
  OBSTACLE_COMPLEXITY_LEVELS,
  rasterizedObstacleFraction,
  summarizeObstacleComplexity,
} from './fractalObstacles'
import { pointInObstacle } from './math'
import { createScenario } from './scenarios'
import type { Obstacle, Vec2 } from './types'

const rectanglesOverlap = (a: Obstacle, b: Obstacle) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y

const segmentIsClear = (
  start: Vec2,
  end: Vec2,
  obstacles: readonly Obstacle[],
  clearance = 0.014,
) => {
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  const steps = Math.max(1, Math.ceil(length / 0.004))
  for (let index = 0; index <= steps; index += 1) {
    const amount = index / steps
    const point = {
      x: start.x + (end.x - start.x) * amount,
      y: start.y + (end.y - start.y) * amount,
    }
    if (obstacles.some((obstacle) => pointInObstacle(point, obstacle, clearance))) {
      return false
    }
  }
  return true
}

describe('fractal-inspired process-floor geometry', () => {
  it('provides a clear control then doubles equipment at each recursive level', () => {
    const counts = OBSTACLE_COMPLEXITY_LEVELS.map(
      (level) => generateFractalObstacles(42, level).length,
    )
    expect(counts).toEqual([0, 2, 4, 8, 16, 32])
  })

  it('is deterministic, seeded and canonically ordered', () => {
    const first = generateFractalObstacles(1729, 5)
    const repeated = generateFractalObstacles(1729, 5)
    const different = generateFractalObstacles(1730, 5)
    expect(repeated).toEqual(first)
    expect(different).not.toEqual(first)
    expect(first.map((obstacle) => obstacle.id)).toEqual(
      [...first.map((obstacle) => obstacle.id)].sort((a, b) => {
        const zoneA = Number(a.match(/-z(\d+)/)?.[1] ?? 0)
        const zoneB = Number(b.match(/-z(\d+)/)?.[1] ?? 0)
        if (zoneA !== zoneB) return zoneA - zoneB
        const nodeA = Number(a.match(/-n(\d+)/)?.[1] ?? 0)
        const nodeB = Number(b.match(/-n(\d+)/)?.[1] ?? 0)
        return nodeA - nodeB
      }),
    )
  })

  it('increases boundary complexity while approximately holding occupied area', () => {
    for (const seed of [11, 42, 919, 73_421]) {
      const summaries = OBSTACLE_COMPLEXITY_LEVELS.filter((level) => level > 0).map((level) =>
        summarizeObstacleComplexity(generateFractalObstacles(seed, level)),
      )
      const areas = summaries.map((summary) => summary.occupiedFraction)
      expect(Math.max(...areas) - Math.min(...areas)).toBeLessThan(0.02)
      for (let index = 1; index < summaries.length; index += 1) {
        expect(summaries[index]!.normalizedPerimeter).toBeGreaterThan(
          summaries[index - 1]!.normalizedPerimeter,
        )
      }
    }
  })

  it('keeps non-overlapping, resolvable features inside fixed process bays', () => {
    for (const level of OBSTACLE_COMPLEXITY_LEVELS) {
      const supportedMinimumResolution = level === 5 ? 48 : 32
      const minimumGridFeature = 2 / supportedMinimumResolution
      for (const seed of [5, 101, 2048]) {
        const obstacles = generateFractalObstacles(seed, level)
        for (let index = 0; index < obstacles.length; index += 1) {
          const obstacle = obstacles[index]!
          expect(obstacle.x).toBeGreaterThanOrEqual(0.1875)
          expect(obstacle.x + obstacle.width).toBeLessThanOrEqual(0.75)
          expect(obstacle.width).toBeGreaterThan(minimumGridFeature)
          expect(obstacle.height).toBeGreaterThan(minimumGridFeature)
          expect(
            obstacle.y + obstacle.height <= 0.4375 || obstacle.y >= 0.5625,
          ).toBe(true)
          for (let other = index + 1; other < obstacles.length; other += 1) {
            expect(rectanglesOverlap(obstacle, obstacles[other]!)).toBe(false)
          }
        }
      }
    }
  })

  it('represents every process unit on each supported numerical grid', () => {
    for (const level of OBSTACLE_COMPLEXITY_LEVELS) {
      const resolution = level === 5 ? 48 : 32
      for (const seed of [5, 42, 101, 2048]) {
        const obstacles = generateFractalObstacles(seed, level)
        for (const obstacle of obstacles) {
          let represented = false
          for (let y = 0; y < resolution && !represented; y += 1) {
            for (let x = 0; x < resolution; x += 1) {
              const point = { x: (x + 0.5) / resolution, y: (y + 0.5) / resolution }
              if (pointInObstacle(point, obstacle)) {
                represented = true
                break
              }
            }
          }
          expect(represented).toBe(true)
        }
        if (level === 0) {
          expect(rasterizedObstacleFraction(obstacles, resolution)).toBe(0)
        } else {
          expect(rasterizedObstacleFraction(obstacles, resolution)).toBeGreaterThan(0)
        }
      }
    }
  })

  it('preserves a clearance-dilated service route from start to source', () => {
    for (const level of OBSTACLE_COMPLEXITY_LEVELS) {
      for (const seed of [1, 42, 311, 1729, 98_765]) {
        const scenario = createScenario('obstructed', seed, {
          ...createDefaultConfig('coverage', 'obstructed'),
          obstacleComplexityLevel: level,
        })
        const route: Vec2[] = [
          scenario.robotStart,
          { x: 0.15, y: scenario.robotStart.y },
          { x: 0.15, y: 0.5 },
          { x: 0.82, y: 0.5 },
          { x: 0.82, y: scenario.source!.y },
          scenario.source!,
        ]
        for (let index = 1; index < route.length; index += 1) {
          expect(segmentIsClear(route[index - 1]!, route[index]!, scenario.obstacles)).toBe(true)
        }
      }
    }
  })

  it('keeps open flow obstacle-free and process geometry paired by seed', () => {
    const config = {
      ...createDefaultConfig('coverage', 'obstructed'),
      obstacleComplexityLevel: 4,
    }
    const first = createScenario('obstructed', 77, config)
    const pairedConfig = {
      ...config,
      algorithmId: 'pmfs',
    } as const
    const openConfig = { ...config, scenarioKind: 'open' } as const
    const second = createScenario('obstructed', 77, pairedConfig)
    const open = createScenario('open', 77, openConfig)
    expect(first.obstacles).toEqual(second.obstacles)
    expect(first.obstacleComplexityLevel).toBe(4)
    expect(open.obstacles).toEqual([])
    expect(open.obstacleComplexityLevel).toBe(0)
  })
})
