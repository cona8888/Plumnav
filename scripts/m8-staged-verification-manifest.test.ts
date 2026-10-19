import { describe, expect, it } from 'vitest'
import { createScenario } from '../src/sim/scenarios'
import { createM8Manifest, M8_ARMS, m8ManifestSha256 } from './m8-staged-verification-manifest'

describe('M8 staged-policy verification manifest', () => {
  it('is a balanced untouched 64-world development-verification design', () => {
    const manifest = createM8Manifest()
    expect(manifest.cells).toHaveLength(128)
    expect(manifest.design.plannedSimulationRuns).toBe(512)
    expect(M8_ARMS).toHaveLength(4)
    expect(new Set(manifest.cells.map((cell) => cell.counterfactualPairingKey)).size).toBe(64)
    for (const scenario of ['open', 'obstructed']) {
      for (const orientation of ['downwind', 'crosswind-left', 'upwind', 'crosswind-right']) {
        for (const condition of ['emitting', 'absent']) {
          expect(manifest.cells.filter((cell) => cell.scenarioKind === scenario &&
            cell.orientationBin === orientation && cell.condition === condition)).toHaveLength(8)
        }
      }
    }
    expect(m8ManifestSha256(manifest)).toBe('bf3b3bf04b2d4b3ede7f47b2e10aaadc8128d28ec642719ef6232511f4042631')
  })

  it('freezes exactly one revision and its legacy paired comparator', () => {
    const manifest = createM8Manifest()
    expect(manifest.requiredSimulatorVersion).toBe('0.12.0')
    expect(manifest.unchangedDeclarationPolicy).toBe(true)
    expect(manifest.frozenRevision).toEqual({
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
    expect(M8_ARMS.map((arm) => arm.id)).toEqual([
      'staged-active', 'legacy-active', 'staged-passive', 'staged-zero-strength-sham',
    ])
    expect(M8_ARMS.find((arm) => arm.id === 'legacy-active')?.algorithmId).toBe('quad-sniff-legacy')
  })

  it('keeps absent source truth outside the controller configuration', () => {
    const manifest = createM8Manifest()
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
