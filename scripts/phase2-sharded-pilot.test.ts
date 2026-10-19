import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPhase2PilotManifest, phase2PilotSha256 } from './phase2-pilot-manifest'
import {
  PHASE2_SHARDED_SCHEMA_VERSION,
  executePhase2ShardedPilotShard,
  finalizePhase2ShardedPilot,
  preparePhase2ShardedPilot,
  selectPhase2Shard,
} from './phase2-sharded-pilot'

const frozenManifestPath = resolve(
  import.meta.dirname,
  '..',
  'research',
  'protocols',
  'phase2_development_pilot',
  'phase2-pilot-manifest.json',
)
const frozenDigest = '1afc56280b0661bbeba68477d067d58bddc2acd7b3ff622b9c1664279ed8dcb1'

const fakeResult = (cell: any) => ({
  algorithmId: cell.config.algorithmId,
  scenarioKind: cell.scenarioKind,
  seed: cell.config.seed,
  checkpointSeconds: 180,
  config: cell.config,
  observationModelVersion: cell.observationModelVersion,
  observationModelSeed: cell.config.observationModelSeed,
  effectivePhysicsStepSeconds: cell.physics.effectiveStepSeconds,
  metrics: {
    targetStatus: 'emitting',
    terminalDeclaration: 'source-localized',
    localizationError: 0.01,
  },
})

describe('Phase 2 sharded pilot design and integrity', () => {
  it('exposes the expected schema and preserves the frozen manifest bytes', async () => {
    expect(PHASE2_SHARDED_SCHEMA_VERSION).toMatch(/^phase2-/)
    const before = await readFile(frozenManifestPath)
    const parsed = JSON.parse(before.toString()) as { manifestSha256: string }
    expect(parsed.manifestSha256).toBe(frozenDigest)
    expect(phase2PilotSha256(createPhase2PilotManifest())).toBe(frozenDigest)

    const output = await mkdtemp(join(tmpdir(), 'phase2-sharded-design-'))
    try {
      const prepared = await preparePhase2ShardedPilot(output)
      expect(prepared.manifest.cells).toHaveLength(80)
      expect(prepared.manifestSha256).toBe(frozenDigest)
      expect(await readFile(frozenManifestPath)).toEqual(before)
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  })

  it('partitions all 80 cells exactly once and retains complete paired layouts', () => {
    const cells = createPhase2PilotManifest().cells
    for (const workerCount of [1, 6]) {
      const shards = Array.from({ length: workerCount }, (_, shardIndex) =>
        selectPhase2Shard(cells, shardIndex, workerCount))
      const flattened = shards.flat()
      expect(flattened).toHaveLength(80)
      expect(new Set(flattened.map((cell) => cell.id)).size).toBe(80)
      expect(Math.max(...shards.map((shard) => shard.length)) -
        Math.min(...shards.map((shard) => shard.length))).toBeLessThanOrEqual(1)
    }
    const byPair = new Map<string, Set<string>>()
    for (const cell of cells) {
      const arms = byPair.get(cell.pairingKey) ?? new Set<string>()
      arms.add(cell.armId)
      byPair.set(cell.pairingKey, arms)
    }
    expect(byPair.size).toBe(16)
    for (const arms of byPair.values()) expect(arms).toEqual(new Set([
      'coverage', 'surge-cast', 'infotaxis', 'quad-active', 'quad-zero-strength-sham',
    ]))
    expect(() => selectPhase2Shard(cells, 6, 6)).toThrow()
    expect(() => selectPhase2Shard(cells, 0, 0)).toThrow()
  })

  it('runs a complete fake-executor campaign, rejects partial finalization, and resumes one tampered cell', async () => {
    const output = await mkdtemp(join(tmpdir(), 'phase2-sharded-fake-'))
    let executions = 0
    const executeCell = async (cell: any) => {
      executions += 1
      return [fakeResult(cell)]
    }
    try {
      await preparePhase2ShardedPilot(output)
      await expect(finalizePhase2ShardedPilot(output)).rejects.toThrow(/partial/i)
      for (const shardIndex of [0, 1, 2, 3, 4, 5]) {
        await executePhase2ShardedPilotShard({
          outputDirectory: output,
          shardIndex,
          shardCount: 6,
          executeCell,
        })
      }
      expect(executions).toBe(80)
      const finalized = await finalizePhase2ShardedPilot(output)
      expect(finalized.completedCells).toBe(80)
      expect(finalized.manifestSha256).toBe(frozenDigest)

      const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
      const cellId = manifest.cells[0].id as string
      const csvPath = join(output, 'cells', `${cellId}.csv`)
      const original = await readFile(csvPath, 'utf8')
      await writeFile(csvPath, `${original}tamper\n`, 'utf8')
      const resumed = await executePhase2ShardedPilotShard({
        outputDirectory: output,
        shardIndex: 0,
        shardCount: 6,
        executeCell,
        resume: true,
      })
      expect(resumed.completedCells).toBe(1)
      expect(resumed.skippedCells).toBe(13)
      expect(executions).toBe(81)
      await finalizePhase2ShardedPilot(output)
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  })

})
