import { describe, expect, it } from 'vitest'
import { createScenario } from '../src/sim/scenarios'
import {
  M6_ARMS,
  createM6CalibrationManifest,
  m6CalibrationSha256,
} from './m6-calibration-manifest'

describe('M6 matched calibration design', () => {
  it('freezes 128 base worlds, two conditions and four paired arms', () => {
    const first = createM6CalibrationManifest()
    const second = createM6CalibrationManifest()
    expect(m6CalibrationSha256(first)).toBe(m6CalibrationSha256(second))
    expect(first.cells).toHaveLength(256)
    expect(first.design.plannedSimulationRuns).toBe(1024)
    expect(first.arms.map((arm) => arm.id)).toEqual(M6_ARMS.map((arm) => arm.id))
    expect(new Set(first.cells.map((cell) => cell.id)).size).toBe(256)
    expect(new Set(first.cells.map((cell) => cell.counterfactualPairingKey)).size).toBe(128)
  })

  it('keeps public worlds matched while withholding absent-source coordinates', () => {
    const manifest = createM6CalibrationManifest()
    const groups = new Map<string, typeof manifest.cells>()
    for (const cell of manifest.cells) {
      const group = groups.get(cell.counterfactualPairingKey) ?? []
      group.push(cell)
      groups.set(cell.counterfactualPairingKey, group)
    }
    for (const cells of groups.values()) {
      expect(cells.map((cell) => cell.condition)).toEqual(['emitting', 'absent'])
      const [emitting, absent] = cells
      expect(absent!.config.sourcePositionOverride).toBeUndefined()
      expect(emitting!.config.sourcePositionOverride).toEqual(
        emitting!.counterfactualSourcePositionNormalized,
      )
      expect(absent!.config.robotStartPositionOverride).toEqual(
        emitting!.config.robotStartPositionOverride,
      )
      expect(absent!.seedPartition).toEqual(emitting!.seedPartition)
      expect(createScenario(absent!.scenarioKind, absent!.config.seed, absent!.config).source)
        .toBeNull()
    }
  })

  it('uses fresh development seeds and the frozen grid budget', () => {
    const manifest = createM6CalibrationManifest()
    expect(manifest.cells.every((cell) =>
      cell.config.durationSeconds === 180 &&
      cell.config.physicsMode === 'grid' &&
      cell.config.gridResolution === 96 &&
      cell.config.physicsStepSeconds === 0.0125 &&
      cell.config.stopOnNativeDeclaration === false
    )).toBe(true)
    const emitting = manifest.cells.filter((cell) => cell.condition === 'emitting')
    expect(new Set(emitting.map((cell) => cell.config.seed)).size).toBe(128)
  })
})
