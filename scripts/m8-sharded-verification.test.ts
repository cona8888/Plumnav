import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SIMULATOR_VERSION } from '../src/sim/config'
import type { BatchResult, MetricSnapshot, SimulationConfig } from '../src/sim/types'
import type { M8Arm, M8Cell } from './m8-staged-verification-manifest'
import {
  executeM8Shard,
  finalizeM8Verification,
  m8ScientificProjection,
  prepareM8Verification,
  selectM8Shard,
} from './m8-sharded-verification'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const fakeMetric = (cell: M8Cell): MetricSnapshot => ({
  elapsedSeconds: 180,
  targetStatus: cell.condition,
  terminalOutcome: cell.condition === 'absent' ? 'correct-rejection-at-deadline' : 'deadline-nondeclaration-present',
  normalizedError: cell.condition === 'absent' ? null : 0.2,
  errorMeters: cell.condition === 'absent' ? null : 20,
  surfaceErrorNormalized: cell.condition === 'absent' ? null : 0.2,
  surfaceErrorMeters: cell.condition === 'absent' ? null : 20,
  success: false,
  pathLengthNormalized: 1,
  pathLengthMeters: 100,
  normalizedPathOverhead: cell.condition === 'absent' ? null : 1.2,
  surfacePathLengthNormalized: 1,
  surfacePathLengthMeters: 100,
  surfacePathOverhead: cell.condition === 'absent' ? null : 1.2,
  elevationGainMeters: 0,
  elevationLossMeters: 0,
  meanTerrainMobilityScale: 1,
  samples: 1,
  passiveSamples: 1,
  activeReturnSamples: 0,
  hitCount: 0,
  activeReturnHits: 0,
  contactEpisodes: 0,
  plumeTimeSeconds: 0,
  reacquisitions: 0,
  nativeDeclaration: false,
  declarationTimeSeconds: null,
  declarationErrorNormalized: null,
  falseDeclarations: 0,
  spuriousDeclaration: false,
  nativeAbstention: false,
  abstentionTimeSeconds: null,
  correctRejection: cell.condition === 'absent' ? true : null,
  correctAbstention: false,
  collisionAttempts: 0,
  activeProbeCount: 0,
  quadSniffCycles: 0,
  quadChannelReturns: 0,
  quadPassiveCycles: 0,
  quadPassiveChannelReturns: 0,
  quadPassiveSamplingSeconds: 0,
  quadSuctionEnergy: 0,
  meanQuadContrast: 0,
  quadValidDirections: 0,
  quadDirectionAbstentions: 0,
  quadSaturatedChannels: 0,
  meanQuadSupport: 0,
  meanQuadIntegrationSamples: 0,
  meanQuadEffectiveSamples: 0,
  quadDeclarationEvaluations: 1,
  quadDeclarationCandidateEvaluations: 0,
  quadDeclarationMaxScore: 0,
  quadDeclarationMaxGatesPassed: 0,
  quadDeclarationBestEvidence: null,
  quadDeclarationGatePasses: {
    candidate: 0,
    'stability-count': 0,
    'stability-span': 0,
    'stability-radius': 0,
    'surface-count': 0,
    'surface-score': 0,
    'passive-core-count': 0,
    'passive-core-hits': 0,
    'passive-ring-count': 0,
    'passive-core-mean': 0,
    'passive-contrast': 0,
    'recent-passive-hit': 0,
    'candidate-distance': 0,
    'aggregate-score': 0,
  },
  quadCandidateFormationEvaluations: 1,
  quadCandidateProvisionalRayEvaluations: 0,
  quadCandidateMaxGradientRayPoolCount: 0,
  quadCandidateMaxProvisionalRayCount: 0,
  quadCandidateMaxQuality: 0,
  quadCandidateMinResidual: null,
  quadCandidateMaxSurfaceSupport: 0,
  quadCandidateBestFormation: null,
  quadCandidateGatePasses: {
    'provisional-ray': 0,
    'ray-count': 0,
    'ray-quality': 0,
    'ray-residual': 0,
    'surface-support': 0,
  },
  activeSamplingSeconds: 0,
  airPulseEnergy: 0,
  meanComputeMs: 1,
  p95ComputeMs: 2,
  estimate: { x: 0.5, y: 0.5 },
})
const fakeExecute = async (cell: M8Cell, arm: M8Arm, config: SimulationConfig) => [{
  algorithmId: arm.algorithmId,
  scenarioKind: cell.scenarioKind,
  seed: config.seed,
  checkpointSeconds: 180,
  config,
  observationModelVersion: cell.observationModelVersion,
  observationModelSeed: config.observationModelSeed,
  metrics: fakeMetric(cell),
} as BatchResult]

describe.skipIf(SIMULATOR_VERSION !== '0.12.0')('M8 sharded staged verification integrity', () => {
  it('selects complete, disjoint deterministic shards', () => {
    const values = Array.from({ length: 128 }, (_, index) => index)
    const shards = Array.from({ length: 6 }, (_, index) => selectM8Shard(values, index, 6))
    expect(shards.flat().sort((first, second) => first - second)).toEqual(values)
    expect(new Set(shards.flat()).size).toBe(128)
    expect(() => selectM8Shard(values, 6, 6)).toThrow(/Invalid M8 shard/)
  })

  it('prepares only the exact frozen 128-cell, 512-run design', async () => {
    const output = await mkdtemp(join(tmpdir(), 'plumenav-m8-prepare-'))
    try {
      const prepared = await prepareM8Verification(output)
      expect(prepared.manifest.cells).toHaveLength(128)
      expect(prepared.manifest.design.plannedSimulationRuns).toBe(512)
      expect(prepared.manifestSha256).toBe('bf3b3bf04b2d4b3ede7f47b2e10aaadc8128d28ec642719ef6232511f4042631')
      await expect(prepareM8Verification(output)).rejects.toThrow(/pass --resume/)
      await expect(prepareM8Verification(output, true)).resolves.toMatchObject({
        manifestSha256: prepared.manifestSha256,
      })
    } finally { await rm(output, { recursive: true, force: true }) }
  })

  it('writes four-arm atomic cells, resumes, repairs semantic tampering, and finalizes deterministically', async () => {
    const output = await mkdtemp(join(tmpdir(), 'plumenav-m8-run-'))
    let calls = 0
    const execute = async (cell: M8Cell, arm: M8Arm, config: SimulationConfig) => {
      calls += 1
      return fakeExecute(cell, arm, config)
    }
    try {
      const prepared = await prepareM8Verification(output)
      const first = await executeM8Shard({ outputDirectory: output, shardIndex: 0, shardCount: 1, executeArm: execute })
      expect(first.completedCells).toBe(128)
      expect(first.assignedRuns).toBe(512)
      expect(calls).toBe(512)
      const second = await executeM8Shard({ outputDirectory: output, shardIndex: 0, shardCount: 1, executeArm: execute })
      expect(second.skippedCells).toBe(128)
      expect(calls).toBe(512)

      const absentCell = prepared.manifest.cells.find((cell) => cell.condition === 'absent')!
      const csvPath = join(output, 'cells', `${absentCell.id}.csv`)
      const metadataPath = join(output, 'cells', `${absentCell.id}.json`)
      const lines = (await readFile(csvPath, 'utf8')).trimEnd().split('\n')
      const header = lines[0]!.split(',')
      const sourceIndex = header.indexOf('source_x_normalized')
      const firstRow = lines[1]!.split(',')
      firstRow[sourceIndex] = '0.5'
      lines[1] = firstRow.join(',')
      const tampered = `${lines.join('\n')}\n`
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { artifactSha256: string; scientificSha256: string }
      metadata.artifactSha256 = sha256(tampered)
      metadata.scientificSha256 = sha256(m8ScientificProjection(tampered))
      await writeFile(csvPath, tampered, 'utf8')
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')

      const repaired = await executeM8Shard({ outputDirectory: output, shardIndex: 0, shardCount: 1, executeArm: execute })
      expect(repaired.completedCells).toBe(1)
      expect(repaired.skippedCells).toBe(127)
      expect(calls).toBe(516)

      const finalized = await finalizeM8Verification(output)
      expect(finalized.rawResultRows).toBe(512)
      const raw = await readFile(join(output, 'raw-results.csv'), 'utf8')
      expect(raw.trimEnd().split('\n')).toHaveLength(513)
      expect(finalized.rawResultsSha256).toBe(sha256(raw))
      expect(finalized.scientificResultsSha256).toBe(sha256(m8ScientificProjection(raw)))
      const absentRows = raw.trimEnd().split('\n').slice(1).filter((row) => row.split(',')[5] === 'absent')
      expect(absentRows).toHaveLength(256)
      const sourceColumn = raw.split('\n')[0]!.split(',').indexOf('source_x_normalized')
      expect(absentRows.every((row) => row.split(',')[sourceColumn] === '')).toBe(true)
      const columns = raw.split('\n')[0]!.split(',')
      const policyColumn = columns.indexOf('candidate_policy')
      const policies = new Set(raw.trimEnd().split('\n').slice(1).map((row) => row.split(',')[policyColumn]))
      expect(policies).toEqual(new Set(['staged-three-ray', 'legacy-four-ray-surface']))
    } finally { await rm(output, { recursive: true, force: true }) }
  })

  it('refuses partial finalization', async () => {
    const output = await mkdtemp(join(tmpdir(), 'plumenav-m8-partial-'))
    try {
      await prepareM8Verification(output)
      await expect(finalizeM8Verification(output)).rejects.toThrow(/invalid or missing completion/)
    } finally { await rm(output, { recursive: true, force: true }) }
  })
})
