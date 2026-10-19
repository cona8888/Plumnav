import { describe, expect, it } from 'vitest'
import { createScenario } from '../src/sim/scenarios'
import {
  createM9Manifest,
  M9_ARMS,
  m9ManifestSha256,
} from './m9-adaptive-development-manifest'

describe('M9 adaptive-viewpoint development manifest', () => {
  it('is a balanced untouched 32-world development design', () => {
    const manifest = createM9Manifest()
    expect(manifest.cells).toHaveLength(64)
    expect(manifest.design.plannedSimulationRuns).toBe(256)
    expect(M9_ARMS).toHaveLength(4)
    expect(new Set(manifest.cells.map((cell) => cell.counterfactualPairingKey)).size).toBe(32)
    for (const scenario of ['open', 'obstructed']) {
      for (const orientation of ['downwind', 'crosswind-left', 'upwind', 'crosswind-right']) {
        for (const condition of ['emitting', 'absent']) {
          expect(manifest.cells.filter((cell) => cell.scenarioKind === scenario &&
            cell.orientationBin === orientation && cell.condition === condition)).toHaveLength(4)
        }
      }
    }
    expect(m9ManifestSha256(manifest)).toBe('07493ac2293e41ae239b3b59b9b8024dceb138af79f45554a9c9742d0ba6fed0')
  })

  it('freezes the adaptive revision and exact M8 comparator', () => {
    const manifest = createM9Manifest()
    expect(manifest.requiredSimulatorVersion).toBe('0.13.0')
    expect(manifest.unchangedDeclarationPolicy).toBe(true)
    expect(manifest.frozenRevision).toMatchObject({
      version: 'quad-adaptive-viewpoint-v1',
      minimumRayCount: 3,
      minimumRayQuality: 0.26,
      maximumRayResidual: 0.055,
      rayRetentionSeconds: 75,
      minimumOriginSeparationNormalized: 0.018,
      candidateRequiresSurfaceSupport: false,
      declarationRequiresSurfaceSupport: true,
    })
    expect(manifest.frozenComparator).toEqual({
      version: 'quad-staged-crosswind-v1',
      minimumRayCount: 3,
      minimumRayQuality: 0.26,
      maximumRayResidual: 0.055,
      rayRetentionSeconds: 60,
      lateralOffsetNormalized: 0.055,
      minimumOriginSeparationNormalized: 0.018,
      candidateRequiresSurfaceSupport: false,
      declarationRequiresSurfaceSupport: true,
    })
    expect(M9_ARMS.map((arm) => arm.id)).toEqual([
      'adaptive-active', 'staged-active', 'adaptive-passive', 'adaptive-zero-strength-sham',
    ])
    expect(M9_ARMS.find((arm) => arm.id === 'staged-active')?.algorithmId)
      .toBe('quad-sniff-staged')
  })

  it('keeps absent source truth outside the controller configuration', () => {
    const manifest = createM9Manifest()
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
