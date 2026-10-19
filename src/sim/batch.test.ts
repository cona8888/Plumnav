import { describe, expect, it } from 'vitest'
import { batchResultsToCsv, runBatch, summarizeBatch } from './batch'
import { createDefaultConfig, SIMULATOR_VERSION } from './config'
import type { BatchResult, MetricSnapshot } from './types'

const metric = (error: number, success: boolean): MetricSnapshot => ({
  elapsedSeconds: 60,
  targetStatus: 'emitting',
  terminalOutcome: 'pending',
  normalizedError: error,
  errorMeters: error * 100,
  surfaceErrorNormalized: error,
  surfaceErrorMeters: error * 100,
  success,
  pathLengthNormalized: 1,
  pathLengthMeters: 100,
  normalizedPathOverhead: 1.5,
  surfacePathLengthNormalized: 1,
  surfacePathLengthMeters: 100,
  surfacePathOverhead: 1.5,
  elevationGainMeters: 0,
  elevationLossMeters: 0,
  meanTerrainMobilityScale: 1,
  samples: 20,
  passiveSamples: 18,
  activeReturnSamples: 2,
  hitCount: 3,
  activeReturnHits: 1,
  contactEpisodes: 2,
  plumeTimeSeconds: 4,
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
  activeProbeCount: 2,
  quadSniffCycles: 3,
  quadChannelReturns: 12,
  quadPassiveCycles: 0,
  quadPassiveChannelReturns: 0,
  quadPassiveSamplingSeconds: 0,
  quadSuctionEnergy: 4.2,
  meanQuadContrast: 0.31,
  quadValidDirections: 2,
  quadDirectionAbstentions: 1,
  quadSaturatedChannels: 0,
  meanQuadSupport: 0.86,
  meanQuadIntegrationSamples: 4,
  meanQuadEffectiveSamples: 3.6,
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
  activeSamplingSeconds: 1.5,
  airPulseEnergy: 0.8,
  meanComputeMs: 2,
  p95ComputeMs: 3,
  estimate: { x: 0.5, y: 0.5 },
})

describe('batch reporting', () => {
  it('groups summaries and exports raw values', () => {
    const results: BatchResult[] = [
      { algorithmId: 'coverage', scenarioKind: 'open', seed: 1, checkpointSeconds: 60, observationModelVersion: 'controller-observation-v1', observationModelSeed: 3_145_739, config: { ...createDefaultConfig('coverage', 'open'), seed: 1 }, metrics: metric(0.01, true) },
      { algorithmId: 'coverage', scenarioKind: 'open', seed: 2, checkpointSeconds: 60, observationModelVersion: 'controller-observation-v1', observationModelSeed: 3_145_739, config: { ...createDefaultConfig('coverage', 'open'), seed: 2 }, metrics: metric(0.03, false) },
    ]
    const summaries = summarizeBatch(results)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.medianNormalizedError).toBeCloseTo(0.02)
    expect(summaries[0]?.successRate).toBe(0.5)
    expect(summaries[0]?.obstacleComplexityLevel).toBe(0)
    expect(summaries[0]?.medianActiveProbes).toBe(2)
    expect(summaries[0]?.medianPulseEnergy).toBe(0.8)
    expect(summaries[0]?.medianQuadSniffCycles).toBe(3)
    expect(summaries[0]?.medianQuadSuctionEnergy).toBe(4.2)
    expect(summaries[0]?.medianQuadContrast).toBe(0.31)
    expect(summaries[0]?.medianQuadValidDirectionRate).toBeCloseTo(2 / 3)
    expect(summaries[0]?.medianQuadSupport).toBe(0.86)
    expect(summaries[0]?.medianQuadIntegrationSamples).toBe(4)
    expect(summaries[0]?.medianQuadEffectiveSamples).toBe(3.6)
    const csv = batchResultsToCsv(results)
    expect(csv).toContain('normalized_error')
    expect(csv).toContain('controller_observation_model_seed')
    expect(csv).toContain('controller_observation_model_version')
    expect(csv).toContain('quad_declaration_max_gates_passed')
    expect(csv).toContain('quad_declaration_gate_passes_aggregate_score')
    expect(csv).toContain('quad_candidate_provisional_ray_evaluations')
    expect(csv).toContain('quad_candidate_gate_passes_surface_support')
    expect(csv.split('\n')).toHaveLength(3)

    const configuredCsv = batchResultsToCsv(
      results.map((result) => ({
        ...result,
        effectivePhysicsStepSeconds: 0.02,
        scenarioKind: 'obstructed' as const,
        config: {
          ...result.config,
          scenarioKind: 'obstructed' as const,
          sourceSeed: 7727,
          controllerSeed: 991,
          obstacleComplexityLevel: 4,
          windDirectionDegrees: 90,
          diffusivityScale: 2,
          emissionRateScale: 1.75,
          physicsMode: 'grid',
          gridResolution: 64,
          physicsStepSeconds: 0.04,
          sensorFalsePositiveRate: 0.08,
          quadChannelNoiseCorrelation: 0.6,
          quadChannelGainMismatch: 0.12,
          quadChannelCrossTalk: 0.25,
          quadChannelLagMismatch: 0.3,
          activeSniffEnabled: true,
          activeSniffStrength: 0.7,
          activeSniffReach: 0.08,
          activeSniffCycleSeconds: 1,
          stopOnNativeDeclaration: true,
          terrainSlopeDegrees: 12,
          terrainUphillDirectionDegrees: 135,
          gasBuoyancy: 'dense' as const,
          terrainGasDriftScale: 1.4,
          robotSlopeLimitDegrees: 28,
        },
      })),
    )
    const [header, firstRow] = configuredCsv.split('\n').map((line) => line.split(','))
    expect(firstRow).toHaveLength(header?.length ?? 0)
    expect(header).toContain('wind_direction_toward_deg')
    expect(firstRow?.[header?.indexOf('wind_direction_toward_deg') ?? -1]).toBe('90')
    expect(firstRow?.[header?.indexOf('diffusivity_scale') ?? -1]).toBe('2')
    expect(firstRow?.[header?.indexOf('source_emission_rate_scale') ?? -1]).toBe('1.75')
    expect(firstRow?.[header?.indexOf('physics_mode') ?? -1]).toBe('grid')
    expect(firstRow?.[header?.indexOf('grid_resolution') ?? -1]).toBe('64')
    expect(firstRow?.[header?.indexOf('physics_step_s') ?? -1]).toBe('0.04')
    expect(firstRow?.[header?.indexOf('effective_physics_step_s') ?? -1]).toBe('0.02')
    expect(firstRow?.[header?.indexOf('sensor_profile_id') ?? -1]).toBe('normalized-reference')
    expect(firstRow?.[header?.indexOf('sensor_ppm_per_normalized_unit') ?? -1]).toBe('1000')
    expect(firstRow?.[header?.indexOf('sensor_detection_floor_normalized') ?? -1]).toBe('0')
    expect(firstRow?.[header?.indexOf('sensor_false_positive_rate') ?? -1]).toBe('0.08')
    expect(firstRow?.[header?.indexOf('quad_channel_noise_correlation') ?? -1]).toBe('0.6')
    expect(firstRow?.[header?.indexOf('quad_channel_gain_mismatch') ?? -1]).toBe('0.12')
    expect(firstRow?.[header?.indexOf('quad_channel_crosstalk') ?? -1]).toBe('0.25')
    expect(firstRow?.[header?.indexOf('quad_channel_lag_mismatch') ?? -1]).toBe('0.3')
    expect(firstRow?.[header?.indexOf('active_probe_count') ?? -1]).toBe('2')
    expect(firstRow?.[header?.indexOf('quad_sniff_cycles') ?? -1]).toBe('3')
    expect(firstRow?.[header?.indexOf('quad_channel_returns') ?? -1]).toBe('12')
    expect(firstRow?.[header?.indexOf('quad_suction_energy_proxy') ?? -1]).toBe('4.2')
    expect(firstRow?.[header?.indexOf('mean_quad_directional_contrast') ?? -1]).toBe('0.31')
    expect(firstRow?.[header?.indexOf('quad_valid_directions') ?? -1]).toBe('2')
    expect(firstRow?.[header?.indexOf('quad_direction_abstentions') ?? -1]).toBe('1')
    expect(firstRow?.[header?.indexOf('mean_quad_support') ?? -1]).toBe('0.86')
    expect(firstRow?.[header?.indexOf('mean_quad_integration_samples') ?? -1]).toBe('4')
    expect(firstRow?.[header?.indexOf('mean_quad_effective_samples') ?? -1]).toBe('3.6')
    expect(firstRow?.[header?.indexOf('active_sampling_s') ?? -1]).toBe('1.5')
    expect(firstRow?.[header?.indexOf('air_pulse_energy') ?? -1]).toBe('0.8')
    expect(firstRow?.[header?.indexOf('active_sniff_enabled') ?? -1]).toBe('1')
    expect(firstRow?.[header?.indexOf('active_sniff_strength') ?? -1]).toBe('0.7')
    expect(firstRow?.[header?.indexOf('active_sniff_reach_normalized') ?? -1]).toBe('0.08')
    expect(firstRow?.[header?.indexOf('active_sniff_cycle_s') ?? -1]).toBe('1')
    expect(firstRow?.[header?.indexOf('stop_on_native_declaration') ?? -1]).toBe('1')
    expect(firstRow?.[header?.indexOf('controller_seed') ?? -1]).toBe('991')
    expect(firstRow?.[header?.indexOf('source_seed') ?? -1]).toBe('7727')
    expect(Number(firstRow?.[header?.indexOf('source_x_normalized') ?? -1])).toBeGreaterThan(0)
    expect(Number(firstRow?.[header?.indexOf('robot_start_x_normalized') ?? -1])).toBeGreaterThan(0)
    expect(firstRow?.[header?.indexOf('estimate_x_normalized') ?? -1]).toBe('0.5')
    expect(firstRow?.[header?.indexOf('obstacle_complexity_level') ?? -1]).toBe('4')
    expect(firstRow?.[header?.indexOf('obstacle_count') ?? -1]).toBe('16')
    expect(Number(firstRow?.[header?.indexOf('obstacle_occupied_fraction') ?? -1])).toBeGreaterThan(0)
    expect(Number(firstRow?.[header?.indexOf('obstacle_normalized_perimeter') ?? -1])).toBeGreaterThan(0)
    expect(firstRow?.[header?.indexOf('obstacle_layout_hash') ?? -1]).toMatch(/^[0-9a-f]{8}$/)
    expect(firstRow?.[header?.indexOf('obstacle_generator_version') ?? -1]).toBe('bsp-fractal-v1')
    expect(firstRow?.[header?.indexOf('obstacle_raster_resolution') ?? -1]).toBe('64')
    expect(Number(firstRow?.[header?.indexOf('obstacle_rasterized_fraction') ?? -1])).toBeGreaterThan(0)
    expect(firstRow?.[header?.indexOf('terrain_slope_deg') ?? -1]).toBe('12')
    expect(Number(firstRow?.[header?.indexOf('terrain_grade_percent') ?? -1])).toBeCloseTo(
      Math.tan(12 * Math.PI / 180) * 100,
      10,
    )
    expect(firstRow?.[header?.indexOf('terrain_uphill_direction_deg') ?? -1]).toBe('135')
    expect(firstRow?.[header?.indexOf('gas_buoyancy_class') ?? -1]).toBe('dense')
    expect(firstRow?.[header?.indexOf('terrain_gas_drift_scale') ?? -1]).toBe('1.4')
    expect(Number(firstRow?.[header?.indexOf('terrain_gas_drift_normalized_s') ?? -1])).toBeGreaterThan(0)
    expect(firstRow?.[header?.indexOf('robot_reference_grade_deg') ?? -1]).toBe('28')
    expect(firstRow?.[header?.indexOf('terrain_model_version') ?? -1]).toBe('planar-2p5d-v1')
    expect(firstRow?.[header?.indexOf('simulator_version') ?? -1]).toBe(SIMULATOR_VERSION)
  })

  it('keeps process-floor complexity levels in separate summary strata', () => {
    const base = createDefaultConfig('coverage', 'obstructed')
    const results: BatchResult[] = [
      {
        algorithmId: 'coverage',
        scenarioKind: 'obstructed',
        seed: 4,
        checkpointSeconds: 60,
        observationModelVersion: 'controller-observation-v1',
        observationModelSeed: 3_145_739,
        config: { ...base, seed: 4, obstacleComplexityLevel: 2 },
        metrics: metric(0.02, false),
      },
      {
        algorithmId: 'coverage',
        scenarioKind: 'obstructed',
        seed: 4,
        checkpointSeconds: 60,
        observationModelVersion: 'controller-observation-v1',
        observationModelSeed: 3_145_739,
        config: { ...base, seed: 4, obstacleComplexityLevel: 5, gridResolution: 48 },
        metrics: metric(0.08, false),
      },
    ]
    const summaries = summarizeBatch(results)
    expect(summaries).toHaveLength(2)
    expect(summaries.map((summary) => summary.obstacleComplexityLevel)).toEqual([2, 5])
  })

  it('keeps terrain and gas-response settings in separate summary strata', () => {
    const base = createDefaultConfig('coverage', 'open')
    const results: BatchResult[] = [
      {
        algorithmId: 'coverage',
        scenarioKind: 'open',
        seed: 8,
        checkpointSeconds: 60,
        observationModelVersion: 'controller-observation-v1',
        observationModelSeed: 3_145_739,
        config: { ...base, seed: 8 },
        metrics: metric(0.02, false),
      },
      {
        algorithmId: 'coverage',
        scenarioKind: 'open',
        seed: 8,
        checkpointSeconds: 60,
        observationModelVersion: 'controller-observation-v1',
        observationModelSeed: 3_145_739,
        config: {
          ...base,
          seed: 8,
          terrainSlopeDegrees: 15,
          terrainUphillDirectionDegrees: 90,
          gasBuoyancy: 'dense',
          terrainGasDriftScale: 1.5,
        },
        metrics: metric(0.08, false),
      },
    ]
    const summaries = summarizeBatch(results)
    expect(summaries).toHaveLength(2)
    expect(summaries.map((summary) => summary.terrainSlopeDegrees)).toEqual([0, 15])
  })

  it('reports false declarations conditionally instead of rewarding abstention', () => {
    const falseDeclaration: MetricSnapshot = {
      ...metric(0.2, false),
      nativeDeclaration: true,
      declarationTimeSeconds: 24,
      declarationErrorNormalized: 0.2,
      falseDeclarations: 1,
      terminalOutcome: 'wrong-declaration',
    }
    const results: BatchResult[] = [
      { algorithmId: 'coverage', scenarioKind: 'open', seed: 1, checkpointSeconds: 60, observationModelVersion: 'controller-observation-v1', observationModelSeed: 3_145_739, config: { ...createDefaultConfig('coverage', 'open'), seed: 1 }, metrics: falseDeclaration },
      { algorithmId: 'coverage', scenarioKind: 'open', seed: 2, checkpointSeconds: 60, observationModelVersion: 'controller-observation-v1', observationModelSeed: 3_145_739, config: { ...createDefaultConfig('coverage', 'open'), seed: 2 }, metrics: metric(0.2, false) },
    ]
    const summary = summarizeBatch(results)[0]
    expect(summary?.declarationRate).toBe(0.5)
    expect(summary?.falseDeclarationRate).toBe(1)
    expect(summary?.correctDeclarationRate).toBe(0)
  })

  it('exports target-absent safety outcomes without fabricated source errors', () => {
    const config = {
      ...createDefaultConfig('coverage', 'open'),
      targetStatus: 'absent' as const,
      durationSeconds: 60,
      checkpointSeconds: [60],
    }
    const absentMetrics: MetricSnapshot = {
      ...metric(0.2, false),
      targetStatus: 'absent',
      terminalOutcome: 'correct-rejection-at-deadline',
      normalizedError: null,
      errorMeters: null,
      surfaceErrorNormalized: null,
      surfaceErrorMeters: null,
      success: null,
      normalizedPathOverhead: null,
      surfacePathOverhead: null,
      correctRejection: true,
    }
    const result: BatchResult = {
      algorithmId: 'coverage',
      scenarioKind: 'open',
      seed: config.seed,
      checkpointSeconds: 60,
      observationModelVersion: 'controller-observation-v1',
      observationModelSeed: config.observationModelSeed,
      config,
      metrics: absentMetrics,
    }
    const summary = summarizeBatch([result])[0]
    expect(summary?.targetStatus).toBe('absent')
    expect(summary?.medianNormalizedError).toBeNull()
    expect(summary?.successRate).toBeNull()
    expect(summary?.correctRejectionRate).toBe(1)
    const [header, row] = batchResultsToCsv([result]).split('\n').map((line) => line.split(','))
    expect(row?.[header?.indexOf('target_status') ?? -1]).toBe('absent')
    expect(row?.[header?.indexOf('source_x_normalized') ?? -1]).toBe('')
    expect(row?.[header?.indexOf('normalized_error') ?? -1]).toBe('')
    expect(row?.[header?.indexOf('correct_rejection') ?? -1]).toBe('1')
    expect(row?.[header?.indexOf('effective_source_emission_rate_scale') ?? -1]).toBe('0')
  })

  it('supports prompt benchmark cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runBatch(createDefaultConfig(), ['coverage'], ['open'], 1, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('snapshots flow configuration before asynchronous batch yields', async () => {
    const mutableConfig = {
      ...createDefaultConfig('coverage', 'open'),
      durationSeconds: 16,
      checkpointSeconds: [16],
      windDirectionDegrees: 90,
    }
    const pending = runBatch(mutableConfig, ['coverage'], ['open'], 2)
    mutableConfig.windDirectionDegrees = 270
    mutableConfig.windSpeedScale = 2
    mutableConfig.emissionRateScale = 3
    mutableConfig.sourceSeed = 77
    mutableConfig.controllerSeed = 99
    mutableConfig.observationModelSeed = 123
    mutableConfig.obstacleComplexityLevel = 4
    mutableConfig.physicsMode = 'grid'
    mutableConfig.sensorFalsePositiveRate = 0.2
    mutableConfig.terrainSlopeDegrees = 18
    mutableConfig.terrainUphillDirectionDegrees = 225
    mutableConfig.gasBuoyancy = 'dense'
    mutableConfig.terrainGasDriftScale = 2.4
    mutableConfig.robotSlopeLimitDegrees = 12
    const result = await pending
    expect(result.results).toHaveLength(2)
    result.results.forEach((item, index) => {
      expect(item.config.windDirectionDegrees).toBe(90)
      expect(item.config.windSpeedScale).toBe(1)
      expect(item.config.emissionRateScale).toBe(1)
      expect(item.config.sourceSeed).toBe(2_097_169 + index * 15_485_863)
      expect(item.config.controllerSeed).toBe(1_048_573 + index * 104_729)
      expect(item.config.observationModelSeed).toBe(3_145_739 + index * 1_000_003)
      expect(item.observationModelSeed).toBe(item.config.observationModelSeed)
      expect(item.observationModelVersion).toBe('controller-observation-v1')
      expect(item.config.obstacleComplexityLevel).toBe(3)
      expect(item.config.physicsMode).toBe('filament')
      expect(item.config.sensorFalsePositiveRate).toBe(0)
      expect(item.config.terrainSlopeDegrees).toBe(0)
      expect(item.config.terrainUphillDirectionDegrees).toBe(0)
      expect(item.config.gasBuoyancy).toBe('neutral')
      expect(item.config.terrainGasDriftScale).toBe(1)
      expect(item.config.robotSlopeLimitDegrees).toBe(25)
    })
  })
})
