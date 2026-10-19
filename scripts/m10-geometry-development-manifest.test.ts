import { describe, expect, it } from 'vitest'
import { createScenario } from '../src/sim/scenarios'
import {
  createM10Manifest,
  M10_ARMS,
  m10ManifestSha256,
} from './m10-geometry-development-manifest'

describe('M10 geometry-conditioned development manifest', () => {
  it('is a balanced untouched 32-world development design', () => {
    const manifest = createM10Manifest()
    expect(manifest.cells).toHaveLength(64)
    expect(manifest.design.plannedSimulationRuns).toBe(256)
    expect(M10_ARMS).toHaveLength(4)
    expect(new Set(manifest.cells.map((cell) => cell.counterfactualPairingKey)).size).toBe(32)
    for (const scenario of ['open', 'obstructed']) {
      for (const orientation of ['downwind', 'crosswind-left', 'upwind', 'crosswind-right']) {
        for (const condition of ['emitting', 'absent']) {
          expect(manifest.cells.filter((cell) => cell.scenarioKind === scenario &&
            cell.orientationBin === orientation && cell.condition === condition)).toHaveLength(4)
        }
      }
    }
    expect(m10ManifestSha256(manifest)).toBe('4500ca6f5df872fe31fb11df3e55d74ec0dcf0c1228ea0f7366bf4617bd8d681')
  })

  it('freezes the geometry-conditioned revision and exact M9 comparator', () => {
    const manifest = createM10Manifest()
    expect(manifest.requiredSimulatorVersion).toBe('0.14.0')
    expect(manifest.unchangedDeclarationPolicy).toBe(true)
    expect(manifest.frozenRevision).toEqual({
      version: 'quad-geometry-conditioned-v1',
      minimumRayCount: 3,
      minimumRayQuality: 0.26,
      maximumRayResidual: 0.055,
      rayRetentionSeconds: 75,
      minimumOriginSeparationNormalized: 0.018,
      hypothesisLookAheadNormalized: 0.11,
      viewpointAdvanceNormalized: [0.035, 0.06, 0.085],
      viewpointLateralOffsetNormalized: [0.025, 0.045, 0.065],
      visitedPoseExclusionNormalized: 0.022,
      obstacleProbeRadiusNormalized: 0.042,
      confirmationCoreRadiusNormalized: 0.018,
      confirmationRingRadiusNormalized: 0.055,
      confirmationArrivalRadiusNormalized: 0.014,
      confirmationDwellSeconds: 1.5,
      retainedRaysAfterFailedConfirmation: 1,
      candidateRequiresSurfaceSupport: false,
      declarationRequiresSurfaceSupport: true,
    })
    expect(manifest.frozenComparator).toEqual({
      version: 'quad-adaptive-viewpoint-v1',
      minimumRayCount: 3,
      minimumRayQuality: 0.26,
      maximumRayResidual: 0.055,
      rayRetentionSeconds: 75,
      minimumOriginSeparationNormalized: 0.018,
      viewpointRadiiNormalized: [0.05, 0.08, 0.11],
      viewpointAnglesDegrees: [90, -90, 60, -60, 120, -120, 150, -150],
      obstacleProbeRadiusNormalized: 0.042,
      confirmationCoreRadiusNormalized: 0.018,
      confirmationRingRadiusNormalized: 0.055,
      confirmationArrivalRadiusNormalized: 0.014,
      confirmationDwellSeconds: 1.5,
      candidateRequiresSurfaceSupport: false,
      declarationRequiresSurfaceSupport: true,
    })
    expect(M10_ARMS.map((arm) => arm.id)).toEqual([
      'geometry-active', 'adaptive-active', 'geometry-passive', 'geometry-zero-strength-sham',
    ])
    expect(M10_ARMS.find((arm) => arm.id === 'adaptive-active')?.algorithmId)
      .toBe('quad-sniff-adaptive')
  })

  it('keeps absent source truth outside the controller configuration', () => {
    const manifest = createM10Manifest()
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
