import { describe, expect, it } from 'vitest'
import {
  CONFIRMATORY_MATRIX,
  ORIENTATION_BINS,
  PILOT_MATRIX,
  QUAD_SUCTION_ABLATIONS,
  createBalancedResearchScenarios,
  validateBalancedScenarioSet,
  validateResearchScenario,
} from './scenarioAblations'

describe('research scenario and ablation protocol', () => {
  it('is deterministic and partitions world/source/controller/model seeds', () => {
    const options = { experimentSeed: 91_337, replicatesPerOrientation: 3 }
    const first = createBalancedResearchScenarios(options)
    const second = createBalancedResearchScenarios(options)
    expect(first).toEqual(second)
    expect(new Set(first.map((scenario) => scenario.seedPartition.worldSeed)).size).toBe(first.length)
    expect(new Set(first.map((scenario) => scenario.seedPartition.sourceSeed)).size).toBe(first.length)
    expect(new Set(first.map((scenario) => scenario.seedPartition.controllerSeed)).size).toBe(first.length)
    expect(new Set(first.map((scenario) => scenario.seedPartition.observationModelSeed)).size).toBe(first.length)
    for (const scenario of first) {
      expect(new Set(Object.values(scenario.seedPartition)).size).toBe(4)
    }
  })

  it('creates navigable, separated, orientation-balanced layouts', () => {
    const scenarios = createBalancedResearchScenarios({ experimentSeed: 20260807, replicatesPerOrientation: 4 })
    expect(validateBalancedScenarioSet(scenarios)).toEqual({ valid: true, errors: [] })
    for (const scenario of scenarios) expect(validateResearchScenario(scenario)).toEqual({ valid: true, errors: [] })
    for (const kind of ['open', 'obstructed'] as const) {
      const counts = ORIENTATION_BINS.map((bin) =>
        scenarios.filter((scenario) => scenario.scenarioKind === kind && scenario.orientationBin === bin).length,
      )
      expect(new Set(counts)).toEqual(new Set([4]))
    }
  })

  it('rejects a collision between labelled seed roles', () => {
    const scenario = createBalancedResearchScenarios({
      experimentSeed: 20260829,
      replicatesPerOrientation: 1,
    })[0]!
    const collided = {
      ...scenario,
      seedPartition: {
        ...scenario.seedPartition,
        observationModelSeed: scenario.seedPartition.worldSeed,
      },
      config: {
        ...scenario.config,
        observationModelSeed: scenario.seedPartition.worldSeed,
      },
    }
    expect(validateResearchScenario(collided).errors).toContain(
      'seed roles must use four distinct values',
    )
  })

  it('keeps the primary comparison compact and labels unimplemented ablations honestly', () => {
    expect(PILOT_MATRIX.totalRuns).toBe(192)
    expect(CONFIRMATORY_MATRIX.pairedLayoutsPerScenario).toBe(200)
    expect(CONFIRMATORY_MATRIX.totalRunsPerPartition).toBe(3_200)
    expect(QUAD_SUCTION_ABLATIONS.filter((item) => item.executableNow).map((item) => item.id)).toEqual([
      'quad-active', 'quad-zero-strength-sham', 'quad-sampler-disabled', 'quad-passive-array', 'quad-crosstalk-noise',
    ])
    expect(QUAD_SUCTION_ABLATIONS.filter((item) => !item.executableNow)).toHaveLength(2)
  })
})
