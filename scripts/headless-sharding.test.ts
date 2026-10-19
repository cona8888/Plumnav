import { describe, expect, it } from 'vitest'
import {
  createManifest,
  scientificCsvSha256,
  scientificProjectionForCsv,
  selectManifestShard,
} from './headless-benchmark'

describe('headless benchmark sharding contract', () => {
  it('assigns every cell exactly once and preserves manifest order', () => {
    const cells = Array.from({ length: 17 }, (_, index) => `cell-${index}`)
    for (const shardCount of [1, 4, 8, 12]) {
      const shards = Array.from({ length: shardCount }, (_, shardIndex) =>
        selectManifestShard(cells, shardIndex, shardCount))
      const flattened = shards.flat()
      expect(flattened).toHaveLength(cells.length)
      expect(new Set(flattened)).toEqual(new Set(cells))
      for (const shard of shards) {
        expect(shard.map((cell) => cells.indexOf(cell)))
          .toEqual([...shard.map((cell) => cells.indexOf(cell))].sort((a, b) => a - b))
      }
      expect(Array.from({ length: shardCount }, (_, shardIndex) =>
        selectManifestShard(cells, shardIndex, shardCount))).toEqual(shards)
    }
  })

  it('rejects invalid shard coordinates', () => {
    expect(() => selectManifestShard([], 0, 0)).toThrow(/positive integer/)
    expect(() => selectManifestShard([], -1, 2)).toThrow(/shardIndex/)
    expect(() => selectManifestShard([], 2, 2)).toThrow(/shardIndex/)
    expect(() => selectManifestShard([], 0.5, 2)).toThrow(/shardIndex/)
  })

  it('excludes only host execution timing from the scientific digest', () => {
    const first = [
      'manifest_sha256,cell,value,simulated_time_s,mean_compute_ms,p95_compute_ms',
      'abc,c1,0.25,20,1.2,3.4',
      '',
    ].join('\n')
    const timingChanged = first.replace('1.2,3.4', '999,1000')
    const scienceChanged = first.replace('0.25,20', '0.26,20')
    expect(scientificCsvSha256(timingChanged)).toBe(scientificCsvSha256(first))
    expect(scientificProjectionForCsv(timingChanged)).toBe(scientificProjectionForCsv(first))
    expect(scientificCsvSha256(scienceChanged)).not.toBe(scientificCsvSha256(first))
  })

  it('keeps worker scheduling out of the scientific manifest', () => {
    const manifest = createManifest('ci') as unknown as Record<string, unknown>
    expect(manifest.workerCount).toBeUndefined()
    expect(manifest.workerId).toBeUndefined()
    expect(manifest.cells).toBeDefined()
  })
})
