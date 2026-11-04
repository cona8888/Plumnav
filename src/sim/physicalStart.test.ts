import { describe, expect, it } from 'vitest'
import { withSIResearchDesign } from '../../scripts/lib/si-research-config'
import { ALGORITHM_METADATA } from './algorithms/metadata'
import { createDefaultConfig } from './config'
import { SimulationEngine } from './engine'
import { withLocalInletDesign } from './localInletSampling'
import { GSL_REFERENCE_DESIGN } from './physicalDesign'
import { createScenario } from './scenarios'
import type { AlgorithmId, Vec2 } from './types'

// Metadata exhaustively covers the factory, including archived controllers that
// are intentionally absent from the shorter UI ALGORITHM_ORDER list.
const factoryAlgorithms = Object.keys(ALGORITHM_METADATA) as AlgorithmId[]
const physicalAlgorithms = factoryAlgorithms.filter(id => id !== 'pulse-sniff')
const obstacleAlgorithms = physicalAlgorithms.filter(id => id !== 'asset-inspection')
const design = { ...GSL_REFERENCE_DESIGN, domainMetres: 6, referenceWindMetresPerSecond: 0.02 }
const response = { recoveryTimeConstantSeconds: 2, maximumTurnRateRadiansPerSecond: Math.PI / 4 }
const edgeStarts: Vec2[] = [{ x: 0.02, y: 0.5 }, { x: 0.98, y: 0.5 }, { x: 0.5, y: 0.02 }, { x: 0.5, y: 0.98 }]

const base = (algorithmId: AlgorithmId) => ({
  ...createDefaultConfig(algorithmId, 'open'),
  durationSeconds: 1,
  checkpointSeconds: [1],
  robotStartPositionOverride: { x: 0.5, y: 0.5 },
  ...(algorithmId === 'asset-inspection' ? { inspectionStations: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }] } : {}),
})

describe('common physical robot start clearance', () => {
  it.each(physicalAlgorithms)('%s rejects a footprint crossing any domain edge at construction', algorithmId => {
    const c = withSIResearchDesign(base(algorithmId), design)
    for (const robotStartPositionOverride of edgeStarts) {
      expect(() => new SimulationEngine({ ...c, robotStartPositionOverride })).toThrow(/start.*(clearance|footprint)/i)
    }
  })

  it.each(physicalAlgorithms)('%s accepts a clear SI start and can execute a control interval', algorithmId => {
    const engine = new SimulationEngine(withSIResearchDesign(base(algorithmId), design))
    expect(engine.environment.isBlocked(engine.scenario.robotStart)).toBe(false)
    const frame = engine.step()
    expect(frame.time).toBe(0.25)
    expect(frame.metrics.collisionAttempts).toBe(0)
  })

  it.each(obstacleAlgorithms)('%s rejects an obstacle-adjacent physical footprint whose centre is in free space', algorithmId => {
    // The halfspace atmosphere intentionally excludes obstacles; this fixture
    // uses its supported legacy field with the same SI robot/inlet contract.
    const c = withLocalInletDesign({ ...base(algorithmId), scenarioKind: 'obstructed',
      robotStartPositionOverride: { x: 0.08, y: 0.5 } }, design, response)
    const map = createScenario(c.scenarioKind, c.seed, c)
    const obstacle = map.obstacles.reduce((leftmost, next) => next.x < leftmost.x ? next : leftmost)
    const radius = Math.hypot(design.robotLengthMetres, design.robotWidthMetres) / (2 * design.domainMetres)
    const start = { x: obstacle.x - radius / 2, y: obstacle.y + obstacle.height / 2 }
    expect(map.obstacles.every(o => start.x < o.x || start.x > o.x + o.width || start.y < o.y || start.y > o.y + o.height)).toBe(true)
    expect(() => new SimulationEngine({ ...c, robotStartPositionOverride: start })).toThrow(/start.*(clearance|footprint)/i)
    const valid = new SimulationEngine(c)
    expect(valid.environment.isBlocked(valid.scenario.robotStart)).toBe(false)
  })

  it('preserves the asset inspection reachable-start diagnostic', () => {
    const c = withSIResearchDesign(base('asset-inspection'), design)
    expect(() => new SimulationEngine({ ...c, robotStartPositionOverride: edgeStarts[0] })).toThrow(/reachable start/)
  })

  it('keeps the unsupported physical pulse-jet controller explicitly rejected', () => {
    expect(() => withSIResearchDesign(base('pulse-sniff'), design)).toThrow(/no pulse-jet controller/)
  })

  it.each(factoryAlgorithms.filter(id => id !== 'asset-inspection'))('%s preserves legacy obstacle missions and accepted legacy edge starts', algorithmId => {
    const c = { ...createDefaultConfig(algorithmId, 'obstructed'), durationSeconds: 1, checkpointSeconds: [1] }
    const legacy = new SimulationEngine(c)
    expect(legacy.environment.isBlocked(legacy.scenario.robotStart)).toBe(false)
    expect(legacy.step().time).toBe(0.25)
    expect(() => new SimulationEngine({ ...c, robotStartPositionOverride: { x: 0.005, y: 0.5 } })).not.toThrow()
  })
})
