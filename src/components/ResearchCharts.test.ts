import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from '../sim/config'
import type { BatchResult, MetricSnapshot } from '../sim/types'
import { aggregateResearchChartData, wilsonScoreInterval } from './ResearchCharts'

const metric = (normalizedError: number, success: boolean): MetricSnapshot => ({
  elapsedSeconds: 60,
  targetStatus: 'emitting',
  terminalOutcome: 'pending',
  normalizedError,
  errorMeters: normalizedError * 100,
  surfaceErrorNormalized: normalizedError,
  surfaceErrorMeters: normalizedError * 100,
  success,
  pathLengthNormalized: 0.5,
  pathLengthMeters: 50,
  normalizedPathOverhead: 1.5,
  surfacePathLengthNormalized: 0.5,
  surfacePathLengthMeters: 50,
  surfacePathOverhead: 1.5,
  elevationGainMeters: 0,
  elevationLossMeters: 0,
  meanTerrainMobilityScale: 1,
  samples: 120,
  passiveSamples: 120,
  activeReturnSamples: 0,
  hitCount: 12,
  activeReturnHits: 0,
  contactEpisodes: 3,
  plumeTimeSeconds: 8,
  reacquisitions: 1,
  nativeDeclaration: false,
  declarationTimeSeconds: null,
  declarationErrorNormalized: null,
  falseDeclarations: 0,
  spuriousDeclaration: false,
  nativeAbstention: false,
  abstentionTimeSeconds: null,
  correctRejection: null,
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
  quadDeclarationEvaluations: 0,
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
    quadCandidateFormationEvaluations: 0,
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
  meanComputeMs: 0.2,
  p95ComputeMs: 0.4,
  estimate: { x: 0.5, y: 0.5 },
})

const result = (
  seed: number,
  normalizedError: number,
  success: boolean,
  scenarioKind: 'open' | 'obstructed' = 'open',
  obstacleComplexityLevel = 3,
  terrainSlopeDegrees = 0,
  gasBuoyancy: 'neutral' | 'dense' | 'light' = 'neutral',
): BatchResult => ({
  algorithmId: 'coverage',
  scenarioKind,
  seed,
  checkpointSeconds: 60,
  observationModelVersion: 'controller-observation-v1',
  observationModelSeed: 3_145_739,
  config: {
    ...createDefaultConfig('coverage', scenarioKind),
    seed,
    obstacleComplexityLevel,
    terrainSlopeDegrees,
    gasBuoyancy,
  },
  metrics: metric(normalizedError, success),
})

describe('research chart statistics', () => {
  it('uses Wilson intervals that remain valid at extreme observed rates', () => {
    const [noneLow, noneHigh] = wilsonScoreInterval(0, 5)
    const [allLow, allHigh] = wilsonScoreInterval(5, 5)

    expect(noneLow).toBe(0)
    expect(noneHigh).toBeCloseTo(0.4345, 4)
    expect(allLow).toBeCloseTo(0.5655, 4)
    expect(allHigh).toBe(1)
  })

  it('aggregates median, IQR and observed success from raw seeded runs', () => {
    const data = aggregateResearchChartData([
      result(1, 0.01, true),
      result(2, 0.03, true),
      result(3, 0.05, false),
      result(4, 0.07, false),
    ])
    const point = data[0]?.series[0]?.points[0]

    expect(point?.runs).toBe(4)
    expect(point?.medianError).toBeCloseTo(0.04)
    expect(point?.errorQ1).toBeCloseTo(0.025)
    expect(point?.errorQ3).toBeCloseTo(0.055)
    expect(point?.successRate).toBe(0.5)
    expect(point?.successLow).toBeLessThan(0.5)
    expect(point?.successHigh).toBeGreaterThan(0.5)
  })

  it('does not pool obstructed process-floor complexity strata', () => {
    const data = aggregateResearchChartData([
      result(1, 0.02, false, 'obstructed', 2),
      result(1, 0.08, false, 'obstructed', 5),
    ])
    expect(data).toHaveLength(2)
    expect(data.map((scenario) => scenario.obstacleComplexityLevel)).toEqual([2, 5])
    expect(data.map((scenario) => scenario.series[0]?.points[0]?.medianError)).toEqual([
      0.02,
      0.08,
    ])
  })

  it('does not pool flat and sloped gas-response strata', () => {
    const data = aggregateResearchChartData([
      result(1, 0.02, false, 'open', 0, 0, 'neutral'),
      result(1, 0.08, false, 'open', 0, 15, 'dense'),
    ])
    expect(data).toHaveLength(2)
    expect(data.map((scenario) => scenario.terrainSlopeDegrees)).toEqual([0, 15])
    expect(data.map((scenario) => scenario.gasBuoyancy)).toEqual(['neutral', 'dense'])
  })
})
