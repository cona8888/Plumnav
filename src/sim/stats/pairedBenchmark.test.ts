import { describe, expect, it } from 'vitest'
import type { BatchResult } from '../types'
import {
  analyzePairedAbsentSafetyResults,
  analyzePairedBatchResults,
  bootstrapPairedMeanDifference,
  bootstrapPairedRiskDifference,
  exactMcNemarP,
  fixedBudgetDecisionTime,
  holmAdjust,
  pairedBinary,
  summarizeDeclarations,
  wilsonInterval,
} from './pairedBenchmark'

describe('publication paired statistics', () => {
  it('calculates paired risks and exact McNemar from discordant pairs', () => {
    const result = pairedBinary([true, true, false, false], [true, false, true, false])
    expect(result.riskDifference).toBe(0)
    expect(result.referenceOnly).toBe(1)
    expect(result.candidateOnly).toBe(1)
    expect(result.mcnemarExactP).toBe(1)
    expect(exactMcNemarP(4, 0)).toBe(0.125)
    expect(pairedBinary([false, false], [true, false]).riskRatio).toBeNull()
  })

  it('uses valid Wilson boundaries and deterministic paired bootstrap', () => {
    const interval = wilsonInterval(0, 10)
    expect(interval.low).toBe(0)
    expect(interval.high).toBeGreaterThan(0)
    const a = bootstrapPairedMeanDifference([1, 2, 3], [2, 4, 6], { seed: 42, resamples: 200 })
    const b = bootstrapPairedMeanDifference([1, 2, 3], [2, 4, 6], { seed: 42, resamples: 200 })
    expect(a).toEqual(b)
    expect(a.estimate).toBe(2)
    expect(() => bootstrapPairedMeanDifference([1], [Number.NaN])).toThrow(RangeError)
  })

  it('bootstraps a paired binary risk difference deterministically', () => {
    const a = bootstrapPairedRiskDifference([true, false, false, true], [true, true, false, false], { seed: 73, resamples: 200 })
    const b = bootstrapPairedRiskDifference([true, false, false, true], [true, true, false, false], { seed: 73, resamples: 200 })
    expect(a).toEqual(b)
    expect(a.estimate).toBe(0)
    expect(a.low).toBeLessThanOrEqual(0)
    expect(a.high).toBeGreaterThanOrEqual(0)
  })

  it('keeps abstentions in unconditional declaration risk and treats failures as budget time', () => {
    const declarations = summarizeDeclarations([true, true, false, false], [false, true, false, false])
    expect(declarations.falseDeclarationProbability.estimate).toBe(0.25)
    expect(declarations.declarationCoverage.estimate).toBe(0.5)
    expect(declarations.declarationPrecision?.estimate).toBe(0.5)
    expect(summarizeDeclarations([false], [false]).declarationPrecision).toBeNull()
    expect(fixedBudgetDecisionTime([2, null, 13], 10)).toEqual({
      meanPenalizedSeconds: 22 / 3,
      budgetSeconds: 10,
      observations: 3,
      correctDeclarations: 1,
    })
  })

  it('performs monotone Holm correction while retaining unperformed tests', () => {
    expect(holmAdjust([0.01, null, 0.04, 0.03])).toEqual([0.03, null, 0.06, 0.06])
  })
})

const batch = (algorithmId: string, seed: number, success: boolean, error: number, declarationTime: number | null, falseDeclarations = 0): BatchResult => ({
  algorithmId: algorithmId as BatchResult['algorithmId'], scenarioKind: 'open', seed, checkpointSeconds: 10,
  observationModelVersion: 'controller-observation-v1', observationModelSeed: seed + 30,
  config: { sourceSeed: seed + 10, controllerSeed: seed + 20, observationModelSeed: seed + 30, targetStatus: 'emitting', obstacleComplexityLevel: 0, terrainSlopeDegrees: 0, terrainUphillDirectionDegrees: 0, gasBuoyancy: 'neutral', terrainGasDriftScale: 1, robotSlopeLimitDegrees: 45 } as BatchResult['config'],
  metrics: { success, normalizedError: error, nativeDeclaration: declarationTime !== null, declarationTimeSeconds: declarationTime, falseDeclarations } as BatchResult['metrics'],
})

const absentBatch = (
  algorithmId: string,
  seed: number,
  spuriousDeclaration: boolean,
  correctAbstention = false,
): BatchResult => {
  const row = batch(algorithmId, seed, false, 0, spuriousDeclaration ? 4 : null, spuriousDeclaration ? 1 : 0)
  return {
    ...row,
    config: { ...row.config, targetStatus: 'absent' },
    metrics: {
      ...row.metrics,
      targetStatus: 'absent',
      terminalOutcome: spuriousDeclaration
        ? 'spurious-declaration'
        : correctAbstention
          ? 'correct-abstention'
          : 'correct-rejection-at-deadline',
      success: null,
      normalizedError: null,
      spuriousDeclaration,
      correctRejection: !spuriousDeclaration,
      correctAbstention,
    },
  }
}

describe('BatchResult adapter', () => {
  it('joins only complete matching pairs and censors non-declarations at the checkpoint', () => {
    const data = [
      batch('coverage', 1, false, 0.4, null), batch('coverage', 2, true, 0.1, 5), batch('coverage', 3, true, 0.2, null),
      batch('infotaxis', 1, true, 0.2, 2), batch('infotaxis', 2, true, 0.05, 3),
    ]
    const analysis = analyzePairedBatchResults(data, 'coverage', 'infotaxis', { bootstrapSeed: 2, bootstrapResamples: 50 })
    expect(analysis.pairs).toBe(2)
    expect(analysis.unmatchedReference).toBe(1)
    expect(analysis.success.riskDifference).toBe(0.5)
    expect(analysis.successRiskDifference.estimate).toBe(0.5)
    expect(analysis.referenceCorrectDeclarationDecisionTime.meanPenalizedSeconds).toBe(7.5)
    expect(analysis.candidateCorrectDeclarationDecisionTime.meanPenalizedSeconds).toBe(2.5)
  })

  it('rejects duplicate pair keys instead of silently selecting one', () => {
    const row = batch('coverage', 1, true, 0.1, null)
    expect(() => analyzePairedBatchResults([row, row, batch('infotaxis', 1, true, 0.1, null)], 'coverage', 'infotaxis')).toThrow('Duplicate')
  })

  it('does not collide strata which differ only in prescribed placement or heading', () => {
    const referenceMatch = batch('coverage', 1, true, 0.1, null)
    const candidateMatch = batch('infotaxis', 1, true, 0.1, null)
    const referenceHeading = { ...batch('coverage', 2, true, 0.1, null), config: { ...batch('coverage', 2, true, 0.1, null).config, robotStartHeadingDegrees: 0, sourcePositionOverride: { x: 0.2, y: 0.3 } } }
    const candidateHeading = { ...batch('infotaxis', 2, true, 0.1, null), config: { ...batch('infotaxis', 2, true, 0.1, null).config, robotStartHeadingDegrees: 90, sourcePositionOverride: { x: 0.2, y: 0.3 } } }
    const analysis = analyzePairedBatchResults([referenceMatch, candidateMatch, referenceHeading, candidateHeading], 'coverage', 'infotaxis', { bootstrapResamples: 10 })
    expect(analysis.pairs).toBe(1)
    expect(analysis.unmatchedReference).toBe(1)
    expect(analysis.unmatchedCandidate).toBe(1)
  })

  it('does not pair runs made with different measurement contracts', () => {
    const reference = batch('coverage', 4, true, 0.1, null)
    reference.config = {
      ...reference.config,
      sensorProfileId: 'normalized-reference',
      sensorPpmPerNormalizedUnit: 1_000,
      sensorDetectionFloor: 0,
    }
    const candidate = batch('infotaxis', 4, true, 0.1, null)
    candidate.config = {
      ...candidate.config,
      sensorProfileId: 'custom',
      sensorPpmPerNormalizedUnit: 500,
      sensorDetectionFloor: 0.02,
    }
    expect(() => analyzePairedBatchResults(
      [reference, candidate], 'coverage', 'infotaxis', { bootstrapResamples: 10 },
    )).toThrow('No complete paired')
  })

  it('analyzes no-target safety separately without inventing localization error', () => {
    const data = [
      absentBatch('coverage', 1, true),
      absentBatch('coverage', 2, false),
      absentBatch('infotaxis', 1, false, true),
      absentBatch('infotaxis', 2, false),
    ]
    const analysis = analyzePairedAbsentSafetyResults(
      data,
      'coverage',
      'infotaxis',
      { bootstrapSeed: 9, bootstrapResamples: 50 },
    )
    expect(analysis.pairs).toBe(2)
    expect(analysis.spuriousDeclaration.riskDifference).toBe(-0.5)
    expect(analysis.correctRejection.riskDifference).toBe(0.5)
    expect(analysis.correctAbstention.riskDifference).toBe(0.5)
  })

  it('rejects unresolved no-target checkpoints', () => {
    const unresolved = absentBatch('coverage', 1, false)
    unresolved.metrics.correctRejection = null
    expect(() => analyzePairedAbsentSafetyResults(
      [unresolved, absentBatch('infotaxis', 1, false)],
      'coverage',
      'infotaxis',
    )).toThrow(/resolved terminal checkpoints/)
  })
})
