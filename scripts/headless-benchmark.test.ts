import { describe, expect, it } from 'vitest'
import {
  ALGORITHMS,
  BENCHMARK_ARMS,
  analysisPartitionsForProfile,
  createManifest,
  validateRowsAgainstManifest,
} from './headless-benchmark'
import type { HeadlessResultRow } from './analyze-headless-results'

describe('publication benchmark manifest', () => {
  it('uses development rows for development-only summaries and test rows otherwise', () => {
    expect(analysisPartitionsForProfile('commissioning')).toEqual(['development'])
    expect(analysisPartitionsForProfile('m5-development')).toEqual(['development'])
    expect(analysisPartitionsForProfile('ci')).toEqual(['test'])
    expect(analysisPartitionsForProfile('pilot')).toEqual(['test'])
    expect(analysisPartitionsForProfile('full')).toEqual(['test'])
  })

  it('uses an independent development-only schedule for worker commissioning', () => {
    const commissioning = createManifest('commissioning')
    const ci = createManifest('ci')
    expect(commissioning.partitions).toEqual(['development'])
    expect(commissioning.cells).toHaveLength(24)
    expect(commissioning.cells.every((cell) => cell.partition === 'development')).toBe(true)
    const ciSeeds = new Set(ci.cells.map((cell) => cell.baseSeeds.seed))
    expect(commissioning.cells.some((cell) => ciSeeds.has(cell.baseSeeds.seed))).toBe(false)
  })

  it('is deterministic and balances four source-wind bins in every partition and scenario', () => {
    const first = createManifest('ci')
    expect(createManifest('ci')).toEqual(first)
    expect(first.partitions).toEqual(['development', 'validation', 'test'])
    expect(first.algorithms).toEqual(ALGORITHMS)
    expect(first.arms.map((arm) => arm.id)).toEqual(BENCHMARK_ARMS.map((arm) => arm.id))
    for (const partition of first.partitions) {
      for (const scenario of ['open', 'obstructed'] as const) {
        expect(first.cells
          .filter((cell) => cell.partition === partition && cell.scenarioKind === scenario)
          .map((cell) => cell.orientationBin),
        ).toEqual(['downwind', 'crosswind-left', 'upwind', 'crosswind-right'])
      }
    }
  })

  it('keeps test seeds distinct from development and validation seeds', () => {
    const manifest = createManifest('full')
    const seeds = manifest.cells.map((cell) => cell.baseSeeds.seed)
    expect(new Set(seeds).size).toBe(seeds.length)
    expect(manifest.layoutsPerScenarioAndPartition).toBe(200)
    expect(manifest.cells.filter((cell) => cell.partition === 'test')).toHaveLength(400)
    expect(manifest.cells.filter((cell) => cell.partition === 'test' && cell.scenarioKind === 'open')).toHaveLength(200)
  })

  it('rejects raw rows that do not match the frozen manifest', () => {
    const manifest = createManifest('ci')
    manifest.cells = [manifest.cells[0]!]
    manifest.arms = [manifest.arms[0]!]
    const cell = manifest.cells[0]!
    cell.config.checkpointSeconds = [20]
    const digest = 'b'.repeat(64)
    const row: HeadlessResultRow = {
      manifestSha256: digest,
      partition: cell.partition,
      scenarioId: cell.id,
      scenario: cell.scenarioKind,
      targetStatus: cell.config.targetStatus,
      terminalOutcome: 'deadline-nondeclaration-present',
      orientationBin: cell.orientationBin,
      replicate: cell.replicate,
      methodArm: manifest.arms[0]!.id,
      seed: cell.baseSeeds.seed,
      sourceSeed: cell.baseSeeds.sourceSeed,
      controllerSeed: cell.baseSeeds.controllerSeed,
      observationModelSeed: cell.baseSeeds.observationModelSeed,
      observationModelVersion: manifest.observationModelVersion,
      sourceX: cell.config.sourcePositionOverride!.x,
      sourceY: cell.config.sourcePositionOverride!.y,
      robotStartX: cell.config.robotStartPositionOverride!.x,
      robotStartY: cell.config.robotStartPositionOverride!.y,
      robotStartHeadingDegrees: cell.config.robotStartHeadingDegrees!,
      windDirectionDegrees: cell.config.windDirectionDegrees,
      physicsMode: cell.config.physicsMode,
      gridResolution: cell.config.gridResolution,
      physicsStepSeconds: cell.config.physicsStepSeconds,
      effectivePhysicsStepSeconds: null,
      quadChannelNoiseCorrelation: cell.config.quadChannelNoiseCorrelation,
      quadChannelGainMismatch: cell.config.quadChannelGainMismatch,
      quadChannelCrossTalk: cell.config.quadChannelCrossTalk,
      quadChannelLagMismatch: cell.config.quadChannelLagMismatch,
      checkpointSeconds: 20,
      success: false,
      normalizedError: 0.4,
      nativeDeclaration: false,
      declarationTimeSeconds: null,
      falseDeclarations: 0,
    }
    expect(() => validateRowsAgainstManifest([row], manifest, digest)).not.toThrow()
    expect(() => validateRowsAgainstManifest([
      { ...row, sourceSeed: row.sourceSeed + 1 },
    ], manifest, digest)).toThrow(/seed, placement, or physics mismatch/)
    expect(() => validateRowsAgainstManifest([
      { ...row, observationModelVersion: 'edited-model' },
    ], manifest, digest)).toThrow(/seed, placement, or physics mismatch/)
  })
})
