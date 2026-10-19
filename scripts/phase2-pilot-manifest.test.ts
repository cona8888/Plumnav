import { describe, expect, it } from 'vitest'
import { validateSimulationConfig } from '../src/sim/config'
import { createPhase2PilotManifest, PHASE2_PILOT_ARMS, phase2PilotSha256 } from './phase2-pilot-manifest'

describe('Phase 2 development pilot manifest', () => {
  it('is deterministic and explicitly development-only', () => {
    const manifest = createPhase2PilotManifest()
    expect(createPhase2PilotManifest()).toEqual(manifest)
    expect(manifest.partition).toBe('development')
    expect(manifest.design.sourcePresentOnly).toBe(true)
    expect(manifest.design.finalCheckpointSeconds).toBe(180)
    expect(manifest.claimBoundary).toContain('no powered')
    expect(manifest.cells.every((cell) => cell.partition === 'development')).toBe(true)
    expect(JSON.stringify(manifest)).not.toMatch(/validation|test/i)
  })

  it('keeps every arm on the same paired layouts and four bins', () => {
    const manifest = createPhase2PilotManifest()
    expect(PHASE2_PILOT_ARMS.map((arm) => arm.id)).toEqual([
      'coverage',
      'surge-cast',
      'infotaxis',
      'quad-active',
      'quad-zero-strength-sham',
    ])
    expect(manifest.cells).toHaveLength(5 * 2 * 4 * 2)
    const keysByArm = PHASE2_PILOT_ARMS.map((arm) => manifest.cells.filter((cell) => cell.armId === arm.id).map((cell) => cell.pairingKey))
    for (const keys of keysByArm) expect(keys).toEqual(keysByArm[0])
    expect(new Set(manifest.cells.map((cell) => cell.orientationBin))).toEqual(new Set(['downwind', 'crosswind-left', 'upwind', 'crosswind-right']))
  })

  it('separates world, source, controller, and observation-model streams and validates configs', () => {
    const manifest = createPhase2PilotManifest()
    for (const cell of manifest.cells) {
      expect(cell.config.seed).toBe(cell.seedPartition.worldSeed)
      expect(cell.config.sourceSeed).toBe(cell.seedPartition.sourceSeed)
      expect(cell.config.controllerSeed).toBe(cell.seedPartition.controllerSeed)
      expect(cell.config.observationModelSeed).toBe(cell.seedPartition.observationModelSeed)
      expect(new Set(Object.values(cell.seedPartition)).size).toBe(4)
      expect(cell.observationModelVersion).toBe(manifest.observationModelVersion)
      expect(cell.config.checkpointSeconds).toEqual([180])
      expect(cell.physics.requestedStepSeconds).toBe(0.0125)
      expect(cell.physics.effectiveStepSeconds).toBeLessThanOrEqual(cell.physics.requestedStepSeconds)
      validateSimulationConfig(cell.config)
    }
  })

  it('hashes the canonical manifest without running a runner', () => {
    const manifest = createPhase2PilotManifest()
    expect(phase2PilotSha256(manifest)).toMatch(/^[a-f0-9]{64}$/)
    expect(phase2PilotSha256({ b: 2, a: { d: 4, c: 3 } })).toBe(
      phase2PilotSha256({ a: { c: 3, d: 4 }, b: 2 }),
    )
  })
})
