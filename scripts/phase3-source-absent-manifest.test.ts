import { describe, expect, it } from 'vitest'
import {
  createPhase3SafetyManifest,
  phase3SafetySha256,
  PHASE3_ALGORITHMS,
  PHASE3_CHECKPOINT_SECONDS,
} from './phase3-source-absent-manifest'

describe('Phase 3 source-absent safety manifest', () => {
  it('is deterministic, development-only, and separate from Phase 2', () => {
    const first = createPhase3SafetyManifest()
    const second = createPhase3SafetyManifest()
    expect(first).toEqual(second)
    expect(first.partition).toBe('development')
    expect(first.claimBoundary).toMatch(/descriptive only/)
    expect(first.conditions).toEqual(['absent', 'zero-emission'])
    expect(first.algorithms).toEqual(PHASE3_ALGORITHMS)
    expect(first.cells.every((cell) =>
      cell.observationModelVersion === first.observationModelVersion)).toBe(true)
    expect(first.design).toMatchObject({
      targetAbsentHasNoSourceCoordinate: true,
      controllerBlindToCondition: true,
      matchedPublicWorldAcrossConditions: true,
    })
    expect(first.cells).toHaveLength(PHASE3_ALGORITHMS.length * 2 * 16)
    expect(new Set(first.cells.map((cell) => cell.config.targetStatus))).toEqual(
      new Set(['absent', 'zero-emission']),
    )
    expect(phase3SafetySha256(first)).toBe(phase3SafetySha256(second))
    expect(phase3SafetySha256({ b: 2, a: { d: 4, c: 3 } })).toBe(
      phase3SafetySha256({ a: { c: 3, d: 4 }, b: 2 }),
    )
  })

  it('removes source coordinates only for true no-target cells', () => {
    const manifest = createPhase3SafetyManifest()
    const absent = manifest.cells.filter((cell) => cell.condition === 'absent')
    const zero = manifest.cells.filter((cell) => cell.condition === 'zero-emission')
    expect(absent.every((cell) => cell.config.sourcePositionOverride === undefined)).toBe(true)
    expect(zero.every((cell) => cell.config.sourcePositionOverride !== undefined)).toBe(true)
    expect(absent.every((cell) => cell.config.checkpointSeconds[0] === PHASE3_CHECKPOINT_SECONDS)).toBe(true)
    expect(new Set(absent.map((cell) => cell.counterfactualPairingKey))).toEqual(
      new Set(zero.map((cell) => cell.counterfactualPairingKey)),
    )
    expect(absent.every((cell) => cell.analysisPairingKey.startsWith('absent-'))).toBe(true)
  })
})
