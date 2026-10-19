import { describe, expect, it } from 'vitest'
import {
  benchmarkManifestSha256,
} from './headless-benchmark'
import { createM5DevelopmentManifest } from './m5-development-manifest'

describe('M5 fresh Mac development screen', () => {
  it('freezes 128 paired development worlds and six prespecified arms', () => {
    const first = createM5DevelopmentManifest()
    const second = createM5DevelopmentManifest()
    expect(benchmarkManifestSha256(first)).toBe(benchmarkManifestSha256(second))
    expect(first.profile).toBe('m5-development')
    expect(first.partitions).toEqual(['development'])
    expect(first.cells).toHaveLength(128)
    expect(new Set(first.cells.map((cell) => cell.id)).size).toBe(128)
    expect(first.arms.map((arm) => arm.id)).toEqual([
      'coverage',
      'surge-cast',
      'infotaxis',
      'quad-active',
      'quad-zero-strength-sham',
      'quad-passive',
    ])
  })

  it('uses fresh, grid-resolved, source-present configurations only', () => {
    const manifest = createM5DevelopmentManifest()
    expect(manifest.cells.every((cell) =>
      cell.partition === 'development' &&
      cell.config.targetStatus === 'emitting' &&
      cell.config.durationSeconds === 180 &&
      cell.config.checkpointSeconds.length === 1 &&
      cell.config.checkpointSeconds[0] === 180 &&
      cell.config.physicsMode === 'grid' &&
      cell.config.gridResolution === 96 &&
      cell.config.physicsStepSeconds === 0.0125
    )).toBe(true)
    expect(new Set(manifest.cells.map((cell) => cell.baseSeeds.seed)).size).toBe(128)
  })
})
