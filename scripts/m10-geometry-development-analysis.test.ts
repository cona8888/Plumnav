import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SIMULATOR_VERSION } from '../src/sim/config'
import type { BatchResult, MetricSnapshot, SimulationConfig } from '../src/sim/types'
import type { M10Arm, M10Cell } from './m10-geometry-development-manifest'
import {
  executeM10Shard,
  finalizeM10Verification,
  prepareM10Verification,
} from './m10-sharded-development'

const fakeMetric = (cell: M10Cell): MetricSnapshot => ({
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
const fakeExecute = async (cell: M10Cell, arm: M10Arm, config: SimulationConfig) => [{
  algorithmId: arm.algorithmId,
  scenarioKind: cell.scenarioKind,
  seed: config.seed,
  checkpointSeconds: 180,
  config,
  observationModelVersion: cell.observationModelVersion,
  observationModelSeed: config.observationModelSeed,
  metrics: { ...fakeMetric(cell), quadSuctionEnergy: config.activeSniffEnabled && config.activeSniffStrength > 0 ? 1 : 0 },
} as BatchResult]


import { analyzeM10GeometryDevelopment, exactM10McNemarP } from './m10-geometry-development-analysis'
import { verifyM10Results } from './m10-verify-results'

describe('M10 independent verification and frozen analysis (synthetic outcomes)', () => {
  it('computes paired exact probabilities at the improvement boundary', () => {
    expect(exactM10McNemarP(0, 0)).toBe(1)
    expect(exactM10McNemarP(5, 0)).toBe(0.0625)
    expect(exactM10McNemarP(6, 0)).toBe(0.03125)
    expect(exactM10McNemarP(2, 2)).toBe(1)
  })

  it('reproduces the completed M10 decision and frozen output hashes', async () => {
    const archive = resolve(import.meta.dirname, '../research/evidence/m10_geometry_conditioned_development_2026-09-05')
    const output = await mkdtemp(join(tmpdir(), 'plumenav-m10-completed-analysis-'))
    try {
      const result = await analyzeM10GeometryDevelopment(archive, output)
      expect(result.analysisSha256).toBe('f33cfe47d33b0da4551b7125a9d94aba31c9f50643623ea4fc8c406ca80b78ba')
      expect(result.reportSha256).toBe('d530f4a20341559ff35706fe6e2828b8d02e737599c185c99e3dd66586d6f10d')
      expect(result.proceedToNominalValidation).toBe(false)
      expect(result.failedCriteria).toEqual(['C5-passive-confirmation-progression', 'C6-correct-native-declaration'])
      const analysis = JSON.parse(await readFile(join(output, 'm10-geometry-development-analysis.json'), 'utf8'))
      expect(analysis.criteria.map((criterion: { passed: boolean }) => criterion.passed))
        .toEqual([true, true, true, true, false, false, true, true])
      expect(analysis.pairedTrustedCandidates).toMatchObject({
        pairs: 32, geometryOnly: 12, adaptiveOnly: 0, both: 1, neither: 19,
        exactMcNemarP: 0.00048828125,
      })
    } finally { await rm(output, { recursive: true, force: true }) }
  }, 20_000)

  it.skipIf(SIMULATOR_VERSION !== '0.14.0')('rejects incomplete data and deterministically halts a complete no-candidate campaign', async () => {
    const output = await mkdtemp(join(tmpdir(), 'plumenav-m10-independent-synthetic-'))
    const analysisOutput = await mkdtemp(join(tmpdir(), 'plumenav-m10-analysis-synthetic-'))
    try {
      await prepareM10Verification(output)
      await expect(verifyM10Results(output)).rejects.toThrow()
      await executeM10Shard({ outputDirectory: output, shardIndex: 0, shardCount: 1, executeArm: fakeExecute })
      await finalizeM10Verification(output)
      const verified = await verifyM10Results(output)
      expect(verified.verifiedCoreArtifacts).toBe(133)
      expect(verified.rows).toBe(256)
      const first = await analyzeM10GeometryDevelopment(output, analysisOutput)
      const second = await analyzeM10GeometryDevelopment(output, analysisOutput)
      expect(first.analysisSha256).toBe(second.analysisSha256)
      expect(first.reportSha256).toBe(second.reportSha256)
      expect(first.proceedToNominalValidation).toBe(false)
      const analysis = JSON.parse(await readFile(join(analysisOutput, 'm10-geometry-development-analysis.json'), 'utf8'))
      expect(analysis.criteria.map((criterion: { passed: boolean }) => criterion.passed))
        .toEqual([false, false, false, false, false, false, true, true])
      expect(analysis.criteria[3].id).toBe('C4-ray-conditioning-mechanism')
      expect(analysis.criteria[3].threshold).toEqual({ minimumThreeRayWorlds: 10, minimumQualityWorlds: 6 })
      expect(analysis.pairedTrustedCandidates).toMatchObject({ pairs: 32, both: 0, neither: 32, exactMcNemarP: 1 })
      const report = await readFile(join(analysisOutput, 'm10-geometry-development-report.md'), 'utf8')
      expect(report).toContain('eight criteria')
      expect(report).toContain('cannot establish simultaneous')
      await writeFile(join(output, 'raw-results.csv'), 'tampered\n', 'utf8')
      await expect(verifyM10Results(output)).rejects.toThrow(/byte count mismatch|SHA-256 mismatch/)
    } finally {
      await rm(output, { recursive: true, force: true })
      await rm(analysisOutput, { recursive: true, force: true })
    }
  }, 20_000)
})
