import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateSimulationConfig } from '../src/sim/config'
import { createManifest } from './headless-benchmark'
import { createPhase2PilotManifest } from './phase2-pilot-manifest'
import {
  GRID_COMMISSIONING_ARMS,
  GRID_COMMISSIONING_REQUESTED_STEP_SECONDS,
  createGridCommissioningManifest,
  finalizeGridCommissioning,
  gridCommissioningSha256,
  gridScientificSha256,
  prepareGridCommissioning,
  selectGridShard,
} from './grid-commissioning'

describe('isolated grid commissioning design', () => {
  it('freezes exactly three arms over four paired development-only layouts', () => {
    const manifest = createGridCommissioningManifest()
    expect(createGridCommissioningManifest()).toEqual(manifest)
    expect(manifest.cells).toHaveLength(12)
    expect(new Set(manifest.cells.map((cell) => cell.id)).size).toBe(12)
    expect(manifest.arms.map((arm) => arm.id)).toEqual(
      GRID_COMMISSIONING_ARMS.map((arm) => arm.id),
    )
    const layouts = new Map<string, typeof manifest.cells>()
    for (const cell of manifest.cells) {
      const group = layouts.get(cell.pairingKey) ?? []
      group.push(cell)
      layouts.set(cell.pairingKey, group)
      expect(cell.partition).toBe('development')
      expect(cell.config.targetStatus).toBe('emitting')
      expect(cell.config.durationSeconds).toBe(30)
      expect(cell.config.checkpointSeconds).toEqual([30])
      expect(cell.config.physicsMode).toBe('grid')
      expect(cell.config.gridResolution).toBe(96)
      expect(cell.config.physicsStepSeconds).toBe(GRID_COMMISSIONING_REQUESTED_STEP_SECONDS)
      expect(cell.physics.effectiveStepSeconds).toBe(GRID_COMMISSIONING_REQUESTED_STEP_SECONDS)
      expect(cell.config.stopOnNativeDeclaration).toBe(false)
      expect(() => validateSimulationConfig(cell.config)).not.toThrow()
    }
    expect(layouts.size).toBe(4)
    for (const group of layouts.values()) {
      expect(group).toHaveLength(3)
      expect(new Set(group.map((cell) => cell.armId))).toEqual(
        new Set(GRID_COMMISSIONING_ARMS.map((arm) => arm.id)),
      )
      const base = group[0]!
      for (const cell of group.slice(1)) {
        expect(cell.seedPartition).toEqual(base.seedPartition)
        expect(cell.config.sourcePositionOverride).toEqual(base.config.sourcePositionOverride)
        expect(cell.config.robotStartPositionOverride).toEqual(base.config.robotStartPositionOverride)
      }
    }
    expect(new Set(manifest.cells.map((cell) => cell.orientationBin))).toEqual(
      new Set(['downwind', 'upwind', 'crosswind-left', 'crosswind-right']),
    )
    expect(manifest.cells.filter((cell) => cell.scenarioKind === 'open')).toHaveLength(6)
    expect(manifest.cells.filter((cell) => cell.scenarioKind === 'obstructed')).toHaveLength(6)
    expect(gridCommissioningSha256(manifest)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('uses seeds disjoint from the existing headless and Phase 2 schedules', () => {
    const manifest = createGridCommissioningManifest()
    const existing = [
      ...createManifest('commissioning').cells,
      ...createManifest('ci').cells,
      ...createManifest('pilot').cells,
      ...createManifest('full').cells,
    ]
    const existingByRole = {
      worldSeed: new Set(existing.map((cell) => cell.baseSeeds.seed)),
      sourceSeed: new Set(existing.map((cell) => cell.baseSeeds.sourceSeed)),
      controllerSeed: new Set(existing.map((cell) => cell.baseSeeds.controllerSeed)),
      observationModelSeed: new Set(existing.map((cell) => cell.baseSeeds.observationModelSeed)),
    }
    for (const cell of createPhase2PilotManifest().cells) {
      for (const role of Object.keys(existingByRole) as Array<keyof typeof existingByRole>) {
        existingByRole[role].add(cell.seedPartition[role])
      }
    }
    for (const cell of manifest.cells) {
      for (const role of Object.keys(existingByRole) as Array<keyof typeof existingByRole>) {
        expect(existingByRole[role].has(cell.seedPartition[role])).toBe(false)
      }
    }
  })

  it('partitions all 12 cells exactly once for the allowed worker counts', () => {
    const cells = createGridCommissioningManifest().cells
    for (const workers of [1, 2, 4, 6]) {
      const shards = Array.from({ length: workers }, (_, index) =>
        selectGridShard(cells, index, workers))
      expect(shards.flat()).toHaveLength(cells.length)
      expect(new Set(shards.flat().map((cell) => cell.id)).size).toBe(cells.length)
      expect(Math.max(...shards.map((shard) => shard.length)) -
        Math.min(...shards.map((shard) => shard.length))).toBeLessThanOrEqual(1)
    }
    expect(() => selectGridShard([], 0, 0)).toThrow()
    expect(() => selectGridShard([], 2, 2)).toThrow()
  })

  it('excludes only host timing fields from exact scientific equivalence', () => {
    const first = [
      'cell,outcome,simulated_time_s,mean_compute_ms,p95_compute_ms',
      'c1,success,30,1.2,2.3',
      '',
    ].join('\n')
    expect(gridScientificSha256(first.replace('1.2,2.3', '100,200')))
      .toBe(gridScientificSha256(first))
    expect(gridScientificSha256(first.replace('success', 'failure')))
      .not.toBe(gridScientificSha256(first))
  })

  it('refuses to finalize a partial grid commissioning output', async () => {
    const output = await mkdtemp(join(tmpdir(), 'plumenav-grid-partial-'))
    try {
      await prepareGridCommissioning(output)
      await expect(finalizeGridCommissioning(output)).rejects.toThrow(/partial finalization/)
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  })
})
