import { describe, expect, it } from 'vitest'
import { createScenario } from '../src/sim/scenarios'
import { createM7Manifest, M7_ARMS, m7ManifestSha256 } from './m7-precandidate-manifest'

describe('M7 pre-candidate diagnostic manifest', () => {
  it('is a balanced fresh-development 32-world paired design', () => {
    const manifest = createM7Manifest()
    expect(manifest.cells).toHaveLength(64)
    expect(manifest.design.plannedSimulationRuns).toBe(192)
    expect(M7_ARMS).toHaveLength(3)
    expect(new Set(manifest.cells.map((cell) => cell.counterfactualPairingKey)).size).toBe(32)
    for (const scenario of ['open', 'obstructed']) {
      for (const orientation of ['downwind', 'crosswind-left', 'upwind', 'crosswind-right']) {
        for (const condition of ['emitting', 'absent']) {
          expect(manifest.cells.filter((cell) => cell.scenarioKind === scenario &&
            cell.orientationBin === orientation && cell.condition === condition)).toHaveLength(4)
        }
      }
    }
    expect(m7ManifestSha256(manifest)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('keeps absent source truth outside the controller configuration', () => {
    const manifest = createM7Manifest()
    for (const key of new Set(manifest.cells.map((cell) => cell.counterfactualPairingKey))) {
      const pair = manifest.cells.filter((cell) => cell.counterfactualPairingKey === key)
      const emitting = pair.find((cell) => cell.condition === 'emitting')!
      const absent = pair.find((cell) => cell.condition === 'absent')!
      expect(emitting.config.sourcePositionOverride).toEqual(emitting.counterfactualSourcePositionNormalized)
      expect(absent.config.sourcePositionOverride).toBeUndefined()
      expect(createScenario(absent.scenarioKind, absent.config.seed, absent.config).source).toBeNull()
      expect(absent.config.seed).toBe(emitting.config.seed)
      expect(absent.config.controllerSeed).toBe(emitting.config.controllerSeed)
      expect(absent.config.observationModelSeed).toBe(emitting.config.observationModelSeed)
    }
  })
})
