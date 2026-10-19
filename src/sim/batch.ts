import { DEFAULT_PHYSICS_STEP_SECONDS, SIMULATOR_VERSION } from './config'
import {
  QUAD_CANDIDATE_FORMATION_GATE_NAMES,
  QUAD_DECLARATION_GATE_NAMES,
} from './algorithms/quadSoilSniff'
import { SimulationEngine } from './engine'
import { GridPlume } from './gridPlume'
import {
  FRACTAL_OBSTACLE_GENERATOR_VERSION,
  generateFractalObstacles,
  obstacleLayoutHash,
  rasterizedObstacleFraction,
  summarizeObstacleComplexity,
} from './fractalObstacles'
import { percentile } from './math'
import { createScenario } from './scenarios'
import { TERRAIN_MODEL_VERSION, terrainGasDrift } from './terrain'
import type {
  AlgorithmId,
  BatchResult,
  BatchSummary,
  ScenarioKind,
  SimulationConfig,
} from './types'

export type BatchProgress = {
  completed: number
  total: number
  currentAlgorithm: AlgorithmId
  currentScenario: ScenarioKind
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const throwIfAborted = (signal?: AbortSignal) => {
  if (!signal?.aborted) return
  const error = new Error('Benchmark cancelled')
  error.name = 'AbortError'
  throw error
}

const definedNumbers = (values: readonly (number | null)[]) =>
  values.filter((value): value is number => value !== null)

const percentileOrNull = (values: readonly (number | null)[], quantile: number) => {
  const defined = definedNumbers(values)
  return defined.length > 0 ? percentile(defined, quantile) : null
}

export const runBatch = async (
  baseConfig: SimulationConfig,
  algorithmIds: AlgorithmId[],
  scenarioKinds: ScenarioKind[],
  runsPerCell: number,
  onProgress?: (progress: BatchProgress) => void,
  signal?: AbortSignal,
) => {
  const results: BatchResult[] = []
  const baseSnapshot: SimulationConfig = {
    ...baseConfig,
    ...(baseConfig.localInletSampling ? { localInletSampling: structuredClone(baseConfig.localInletSampling) } : {}),
    ...(baseConfig.physicalAtmosphere ? { physicalAtmosphere: structuredClone(baseConfig.physicalAtmosphere) } : {}),
    checkpointSeconds: [...baseConfig.checkpointSeconds],
    sourcePositionOverride: baseConfig.sourcePositionOverride
      ? { ...baseConfig.sourcePositionOverride }
      : undefined,
    robotStartPositionOverride: baseConfig.robotStartPositionOverride
      ? { ...baseConfig.robotStartPositionOverride }
      : undefined,
  }
  const algorithmSnapshot = [...algorithmIds]
  const scenarioSnapshot = [...scenarioKinds]
  const total = algorithmSnapshot.length * scenarioSnapshot.length * runsPerCell
  let completed = 0

  for (const algorithmId of algorithmSnapshot) {
    for (const scenarioKind of scenarioSnapshot) {
      for (let run = 0; run < runsPerCell; run += 1) {
        throwIfAborted(signal)
        const seed = baseSnapshot.seed + run * 7_919
        const sourceSeed = baseSnapshot.sourceSeed + run * 15_485_863
        const controllerSeed = baseSnapshot.controllerSeed + run * 104_729
        const observationModelSeed = baseSnapshot.observationModelSeed + run * 1_000_003
        const config: SimulationConfig = {
          ...baseSnapshot,
          algorithmId,
          scenarioKind,
          seed,
          sourceSeed,
          controllerSeed,
          observationModelSeed,
          stopOnNativeDeclaration: false,
          checkpointSeconds: [...baseSnapshot.checkpointSeconds],
        }
        const engine = new SimulationEngine(config)
        let stepsSinceYield = 0
        while (!engine.isCompleted()) {
          engine.step()
          stepsSinceYield += 1
          // Information-based controllers can make one run computationally
          // substantial. Yield between small deterministic chunks so the UI
          // remains responsive and cancellation takes effect promptly.
          if (stepsSinceYield >= 60) {
            stepsSinceYield = 0
            throwIfAborted(signal)
            await tick()
          }
        }
        const frame = engine.getFrame()
        for (const checkpointSeconds of config.checkpointSeconds) {
          const metrics = frame.checkpoints[checkpointSeconds]
          if (!metrics) continue
          results.push({
            algorithmId,
            scenarioKind,
            seed,
            checkpointSeconds,
            config: {
              ...config,
              ...(config.localInletSampling ? { localInletSampling: structuredClone(config.localInletSampling) } : {}),
              ...(config.physicalAtmosphere ? { physicalAtmosphere: structuredClone(config.physicalAtmosphere) } : {}),
              checkpointSeconds: [...config.checkpointSeconds],
              sourcePositionOverride: config.sourcePositionOverride
                ? { ...config.sourcePositionOverride }
                : undefined,
              robotStartPositionOverride: config.robotStartPositionOverride
                ? { ...config.robotStartPositionOverride }
                : undefined,
            },
            observationModelVersion: engine.environment.observationModelVersion,
            observationModelSeed: engine.environment.observationModelSeed,
            metrics,
            effectivePhysicsStepSeconds: engine.plume instanceof GridPlume ? engine.plume.stepSeconds : null,
          })
        }
        completed += 1
        onProgress?.({ completed, total, currentAlgorithm: algorithmId, currentScenario: scenarioKind })
        await tick()
      }
    }
  }
  return { results, summaries: summarizeBatch(results) }
}

export const summarizeBatch = (results: BatchResult[]): BatchSummary[] => {
  const groups = new Map<string, BatchResult[]>()
  for (const result of results) {
    if (result.metrics.targetStatus !== result.config.targetStatus) {
      throw new Error('Batch metric target status does not match its immutable configuration')
    }
    const obstacleComplexityLevel =
      result.scenarioKind === 'obstructed' ? result.config.obstacleComplexityLevel : 0
    const key = [
      result.algorithmId,
      result.scenarioKind,
      result.config.targetStatus,
      obstacleComplexityLevel,
      result.config.terrainSlopeDegrees,
      result.config.terrainUphillDirectionDegrees,
      result.config.gasBuoyancy,
      result.config.terrainGasDriftScale,
      result.config.robotSlopeLimitDegrees,
      result.checkpointSeconds,
      ...(result.config.localInletSampling ? [JSON.stringify(result.config.localInletSampling)] : []),
      ...(result.config.physicalAtmosphere ? [JSON.stringify(result.config.physicalAtmosphere)] : []),
    ].join('|')
    const group = groups.get(key) ?? []
    group.push(result)
    groups.set(key, group)
  }

  return [...groups.values()].map((group) => {
    const first = group[0]
    if (!first) throw new Error('Unexpected empty batch group')
    const errors = group.map((item) => item.metrics.normalizedError)
    const declarations = group.filter((item) => item.metrics.nativeDeclaration)
    const correctDeclarations = group.filter(
      (item) => item.metrics.terminalOutcome === 'correct-declaration',
    )
    const correctRejections = group.map((item) => item.metrics.correctRejection)
    const allRejectionsResolved = correctRejections.every((value) => value !== null)
    return {
      algorithmId: first.algorithmId,
      scenarioKind: first.scenarioKind,
      targetStatus: first.config.targetStatus,
      obstacleComplexityLevel:
        first.scenarioKind === 'obstructed' ? first.config.obstacleComplexityLevel : 0,
      terrainSlopeDegrees: first.config.terrainSlopeDegrees,
      terrainUphillDirectionDegrees: first.config.terrainUphillDirectionDegrees,
      gasBuoyancy: first.config.gasBuoyancy,
      terrainGasDriftScale: first.config.terrainGasDriftScale,
      robotSlopeLimitDegrees: first.config.robotSlopeLimitDegrees,
      runs: group.length,
      checkpointSeconds: first.checkpointSeconds,
      medianNormalizedError: percentileOrNull(errors, 0.5),
      p90NormalizedError: percentileOrNull(errors, 0.9),
      successRate: first.config.targetStatus === 'absent'
        ? null
        : group.filter((item) => item.metrics.success).length / group.length,
      medianTimeSeconds: percentile(group.map((item) => item.metrics.elapsedSeconds), 0.5),
      medianPathOverhead: percentileOrNull(
        group.map((item) => item.metrics.normalizedPathOverhead),
        0.5,
      ),
      medianSurfacePathOverhead: percentileOrNull(
        group.map((item) => item.metrics.surfacePathOverhead),
        0.5,
      ),
      medianTerrainMobilityScale: percentile(
        group.map((item) => item.metrics.meanTerrainMobilityScale),
        0.5,
      ),
      medianElevationGainMeters: percentile(
        group.map((item) => item.metrics.elevationGainMeters),
        0.5,
      ),
      medianComputeMs: percentile(group.map((item) => item.metrics.meanComputeMs), 0.5),
      medianPlumeContacts: percentile(group.map((item) => item.metrics.contactEpisodes), 0.5),
      medianActiveProbes: percentile(group.map((item) => item.metrics.activeProbeCount), 0.5),
      medianPulseEnergy: percentile(group.map((item) => item.metrics.airPulseEnergy), 0.5),
      medianQuadSniffCycles: percentile(
        group.map((item) => item.metrics.quadSniffCycles),
        0.5,
      ),
      medianQuadSuctionEnergy: percentile(
        group.map((item) => item.metrics.quadSuctionEnergy),
        0.5,
      ),
      medianQuadContrast: percentile(
        group.map((item) => item.metrics.meanQuadContrast),
        0.5,
      ),
      medianQuadValidDirectionRate: percentile(
        group.map((item) =>
          item.metrics.quadValidDirections /
          Math.max(1, item.metrics.quadValidDirections + item.metrics.quadDirectionAbstentions),
        ),
        0.5,
      ),
      medianQuadSupport: percentile(
        group.map((item) => item.metrics.meanQuadSupport),
        0.5,
      ),
      medianQuadIntegrationSamples: percentile(
        group.map((item) => item.metrics.meanQuadIntegrationSamples),
        0.5,
      ),
      medianQuadEffectiveSamples: percentile(
        group.map((item) => item.metrics.meanQuadEffectiveSamples),
        0.5,
      ),
      declarationRate: declarations.length / group.length,
      correctDeclarationRate: correctDeclarations.length / group.length,
      falseDeclarationRate:
        declarations.length > 0
          ? declarations.filter((item) => item.metrics.falseDeclarations > 0).length /
            declarations.length
          : 0,
      spuriousDeclarationRate:
        group.filter((item) => item.metrics.spuriousDeclaration).length / group.length,
      correctRejectionRate:
        first.config.targetStatus === 'absent' && allRejectionsResolved
          ? correctRejections.filter(Boolean).length / group.length
          : null,
      correctAbstentionRate:
        first.config.targetStatus === 'absent'
          ? group.filter((item) => item.metrics.correctAbstention).length / group.length
          : null,
    }
  })
}

export const batchResultsToCsv = (results: BatchResult[]) => {
  const includeSI = results.some(r => r.config.physicalAtmosphere ||
    r.config.localInletSampling?.effectiveDiffusivityMetresSquaredPerSecond !== undefined)
  const header = [
    'algorithm',
    'scenario',
    'target_status',
    'seed',
    'source_seed',
    'controller_seed',
    'controller_observation_model_seed',
    'controller_observation_model_version',
    'source_x_normalized',
    'source_y_normalized',
    'robot_start_x_normalized',
    'robot_start_y_normalized',
    'robot_start_heading_deg',
    'placement_overridden',
    'estimate_x_normalized',
    'estimate_y_normalized',
    'obstacle_complexity_level',
    'obstacle_count',
    'obstacle_occupied_fraction',
    'obstacle_normalized_perimeter',
    'obstacle_layout_hash',
    'obstacle_generator_version',
    'obstacle_raster_resolution',
    'obstacle_rasterized_fraction',
    'terrain_slope_deg',
    'terrain_grade_percent',
    'terrain_uphill_direction_deg',
    'terrain_nominal_rise_m_per_domain',
    'gas_buoyancy_class',
    'terrain_gas_drift_scale',
    'terrain_gas_drift_normalized_s',
    'terrain_drift_to_mean_air_speed',
    'robot_reference_grade_deg',
    'terrain_model_version',
    'checkpoint_s',
    'terminal_outcome',
    'normalized_error',
    'error_m',
    'surface_error_normalized',
    'surface_error_m',
    'proximity_success',
    'path_normalized',
    'path_m',
    'direct_distance_path_overhead',
    'surface_path_normalized',
    'surface_path_m',
    'surface_direct_path_overhead',
    'elevation_gain_m',
    'elevation_loss_m',
    'mean_terrain_mobility_scale',
    'samples',
    'passive_samples',
    'active_return_samples',
    'passive_hit_samples',
    'active_return_hits',
    'passive_contact_episodes',
    'plume_time_s',
    'reacquisitions',
    'native_declaration',
    'declaration_time_s',
    'declaration_error_normalized',
    'false_declarations',
    'spurious_declaration',
    'native_abstention',
    'abstention_time_s',
    'correct_rejection',
    'correct_abstention',
    'collision_attempts',
    'active_probe_count',
    'quad_sniff_cycles',
    'quad_channel_returns',
    'quad_passive_cycles',
    'quad_passive_channel_returns',
    'quad_passive_sampling_s',
    'active_sampling_s',
    'air_pulse_energy',
    'quad_suction_energy_proxy',
    'mean_quad_directional_contrast',
    'quad_valid_directions',
    'quad_direction_abstentions',
    'quad_saturated_channels',
    'mean_quad_support',
    'mean_quad_integration_samples',
    'mean_quad_effective_samples',
    'quad_declaration_evaluations',
    'quad_declaration_candidate_evaluations',
    'quad_declaration_max_score',
    'quad_declaration_max_gates_passed',
    'quad_declaration_best_failed_gates',
    'quad_declaration_best_candidate_x',
    'quad_declaration_best_candidate_y',
    'quad_declaration_best_ray_score',
    'quad_declaration_best_stability_score',
    'quad_declaration_best_surface_score',
    'quad_declaration_best_passive_score',
    'quad_declaration_best_ray_quality',
    'quad_declaration_best_ray_residual',
    'quad_declaration_best_stability_count',
    'quad_declaration_best_stability_span_s',
    'quad_declaration_best_stability_radius',
    'quad_declaration_best_surface_count',
    'quad_declaration_best_surface_mean_score',
    'quad_declaration_best_passive_core_count',
    'quad_declaration_best_passive_core_hits',
    'quad_declaration_best_passive_ring_count',
    'quad_declaration_best_passive_core_mean',
    'quad_declaration_best_passive_contrast',
    'quad_declaration_best_seconds_since_passive_hit',
    'quad_declaration_best_distance_to_candidate',
    ...QUAD_DECLARATION_GATE_NAMES.map((gate) =>
      `quad_declaration_gate_passes_${gate.replaceAll('-', '_')}`),
    'quad_candidate_formation_evaluations',
    'quad_candidate_provisional_ray_evaluations',
    'quad_candidate_max_gradient_ray_pool_count',
    'quad_candidate_max_provisional_ray_count',
    'quad_candidate_max_quality',
    'quad_candidate_min_residual',
    'quad_candidate_max_surface_support',
    'quad_candidate_best_failed_gates',
    'quad_candidate_best_provisional_x',
    'quad_candidate_best_provisional_y',
    'quad_candidate_best_gradient_ray_pool_count',
    'quad_candidate_best_provisional_ray_count',
    'quad_candidate_best_quality',
    'quad_candidate_best_residual',
    'quad_candidate_best_surface_support',
    'quad_candidate_best_trusted',
    'quad_candidate_best_gates_passed',
    ...QUAD_CANDIDATE_FORMATION_GATE_NAMES.map((gate) =>
      `quad_candidate_gate_passes_${gate.replaceAll('-', '_')}`),
    'mean_compute_ms',
    'p95_compute_ms',
    'domain_side_m',
    'duration_s',
    'stop_on_native_declaration',
    'fixed_dt_s',
    'physics_step_s',
    'effective_physics_step_s',
    'robot_speed_normalized_s',
    'sensor_profile_id',
    'sensor_ppm_per_normalized_unit',
    'sensor_detection_floor_normalized',
    'sensor_noise',
    'sensor_lag_s',
    'sensor_threshold_scale',
    'sensor_saturation',
    'sensor_false_positive_rate',
    'sensor_false_negative_rate',
    'quad_channel_noise_correlation',
    'quad_channel_gain_mismatch',
    'quad_channel_crosstalk',
    'quad_channel_lag_mismatch',
    'wind_noise_rad',
    'active_sniff_enabled',
    'active_sniff_strength',
    'active_sniff_reach_normalized',
    'active_sniff_cycle_s',
    'physics_mode',
    'grid_resolution',
    'wind_direction_toward_deg',
    'wind_speed_scale',
    'turbulence_scale',
    'gust_fraction_of_mean',
    'diffusivity_scale',
    'source_emission_rate_scale',
    'effective_source_emission_rate_scale',
    'success_threshold_normalized',
    'simulator_version',
    ...(includeSI ? ['si_configuration_json'] : []),
  ]
  const rows = results.map((result) => {
    const metric = result.metrics
    const experimentConfig = result.config
    if (metric.targetStatus !== experimentConfig.targetStatus) {
      throw new Error('Cannot export a batch row whose metric target status differs from its configuration')
    }
    const obstacleComplexityLevel =
      result.scenarioKind === 'obstructed' ? experimentConfig.obstacleComplexityLevel : 0
    const scenario = createScenario(result.scenarioKind, result.seed, experimentConfig)
    const isProcessFloor = result.scenarioKind === 'obstructed'
    const obstacles = isProcessFloor
      ? generateFractalObstacles(result.seed, obstacleComplexityLevel)
      : []
    const obstacleSummary = summarizeObstacleComplexity(obstacles)
    const terrainDrift = terrainGasDrift(scenario)
    const terrainDriftSpeed = Math.hypot(terrainDrift.x, terrainDrift.y)
    const meanAirSpeed = Math.hypot(scenario.baseWind.x, scenario.baseWind.y)
    return [
      result.algorithmId,
      result.scenarioKind,
      experimentConfig.targetStatus,
      result.seed,
      experimentConfig.sourceSeed,
      experimentConfig.controllerSeed,
      result.observationModelSeed,
      result.observationModelVersion,
      scenario.source?.x ?? '',
      scenario.source?.y ?? '',
      scenario.robotStart.x,
      scenario.robotStart.y,
      experimentConfig.robotStartHeadingDegrees ?? 0,
      experimentConfig.sourcePositionOverride || experimentConfig.robotStartPositionOverride
        ? 1
        : 0,
      metric.estimate?.x ?? '',
      metric.estimate?.y ?? '',
      obstacleComplexityLevel,
      obstacleSummary.count,
      obstacleSummary.occupiedFraction,
      obstacleSummary.normalizedPerimeter,
      isProcessFloor ? obstacleLayoutHash(obstacles) : 'none',
      isProcessFloor ? FRACTAL_OBSTACLE_GENERATOR_VERSION : 'none',
      isProcessFloor && experimentConfig.physicsMode === 'grid'
        ? experimentConfig.gridResolution
        : '',
      isProcessFloor && experimentConfig.physicsMode === 'grid'
        ? rasterizedObstacleFraction(obstacles, experimentConfig.gridResolution)
        : '',
      experimentConfig.terrainSlopeDegrees,
      Math.tan((experimentConfig.terrainSlopeDegrees * Math.PI) / 180) * 100,
      experimentConfig.terrainUphillDirectionDegrees,
      Math.tan((experimentConfig.terrainSlopeDegrees * Math.PI) / 180) *
        experimentConfig.domainMeters,
      experimentConfig.gasBuoyancy,
      experimentConfig.terrainGasDriftScale,
      terrainDriftSpeed,
      terrainDriftSpeed / Math.max(meanAirSpeed, 1e-12),
      experimentConfig.robotSlopeLimitDegrees,
      TERRAIN_MODEL_VERSION,
      result.checkpointSeconds,
      metric.terminalOutcome,
      metric.normalizedError ?? '',
      metric.errorMeters ?? '',
      metric.surfaceErrorNormalized ?? '',
      metric.surfaceErrorMeters ?? '',
      metric.success === null ? '' : metric.success ? 1 : 0,
      metric.pathLengthNormalized,
      metric.pathLengthMeters,
      metric.normalizedPathOverhead ?? '',
      metric.surfacePathLengthNormalized,
      metric.surfacePathLengthMeters,
      metric.surfacePathOverhead ?? '',
      metric.elevationGainMeters,
      metric.elevationLossMeters,
      metric.meanTerrainMobilityScale,
      metric.samples,
      metric.passiveSamples,
      metric.activeReturnSamples,
      metric.hitCount,
      metric.activeReturnHits,
      metric.contactEpisodes,
      metric.plumeTimeSeconds,
      metric.reacquisitions,
      metric.nativeDeclaration ? 1 : 0,
      metric.declarationTimeSeconds ?? '',
      metric.declarationErrorNormalized ?? '',
      metric.falseDeclarations,
      metric.spuriousDeclaration ? 1 : 0,
      metric.nativeAbstention ? 1 : 0,
      metric.abstentionTimeSeconds ?? '',
      metric.correctRejection === null ? '' : metric.correctRejection ? 1 : 0,
      metric.correctAbstention ? 1 : 0,
      metric.collisionAttempts,
      metric.activeProbeCount,
      metric.quadSniffCycles,
      metric.quadChannelReturns,
      metric.quadPassiveCycles,
      metric.quadPassiveChannelReturns,
      metric.quadPassiveSamplingSeconds,
      metric.activeSamplingSeconds,
      metric.airPulseEnergy,
      metric.quadSuctionEnergy,
      metric.meanQuadContrast,
      metric.quadValidDirections,
      metric.quadDirectionAbstentions,
      metric.quadSaturatedChannels,
      metric.meanQuadSupport,
      metric.meanQuadIntegrationSamples,
      metric.meanQuadEffectiveSamples,
      metric.quadDeclarationEvaluations,
      metric.quadDeclarationCandidateEvaluations,
      metric.quadDeclarationMaxScore,
      metric.quadDeclarationMaxGatesPassed,
      metric.quadDeclarationBestEvidence
        ? QUAD_DECLARATION_GATE_NAMES
            .filter((gate) => !metric.quadDeclarationBestEvidence!.gates[gate])
            .join('|')
        : QUAD_DECLARATION_GATE_NAMES.join('|'),
      metric.quadDeclarationBestEvidence?.candidate?.x ?? '',
      metric.quadDeclarationBestEvidence?.candidate?.y ?? '',
      metric.quadDeclarationBestEvidence?.rayScore ?? '',
      metric.quadDeclarationBestEvidence?.stabilityScore ?? '',
      metric.quadDeclarationBestEvidence?.surfaceScore ?? '',
      metric.quadDeclarationBestEvidence?.passiveScore ?? '',
      metric.quadDeclarationBestEvidence?.raw.rayQuality ?? '',
      metric.quadDeclarationBestEvidence?.raw.rayResidual ?? '',
      metric.quadDeclarationBestEvidence?.raw.stabilityCount ?? '',
      metric.quadDeclarationBestEvidence?.raw.stabilitySpan ?? '',
      metric.quadDeclarationBestEvidence?.raw.stabilityRadius ?? '',
      metric.quadDeclarationBestEvidence?.raw.surfaceCount ?? '',
      metric.quadDeclarationBestEvidence?.raw.surfaceMeanScore ?? '',
      metric.quadDeclarationBestEvidence?.raw.passiveCoreCount ?? '',
      metric.quadDeclarationBestEvidence?.raw.passiveCoreHits ?? '',
      metric.quadDeclarationBestEvidence?.raw.passiveRingCount ?? '',
      metric.quadDeclarationBestEvidence?.raw.passiveCoreMean ?? '',
      metric.quadDeclarationBestEvidence?.raw.passiveContrast ?? '',
      metric.quadDeclarationBestEvidence?.raw.secondsSincePassiveHit ?? '',
      metric.quadDeclarationBestEvidence?.raw.distanceToCandidate ?? '',
      ...QUAD_DECLARATION_GATE_NAMES.map((gate) =>
        metric.quadDeclarationGatePasses?.[gate] ?? 0),
      metric.quadCandidateFormationEvaluations ?? 0,
      metric.quadCandidateProvisionalRayEvaluations ?? 0,
      metric.quadCandidateMaxGradientRayPoolCount ?? 0,
      metric.quadCandidateMaxProvisionalRayCount ?? 0,
      metric.quadCandidateMaxQuality ?? 0,
      metric.quadCandidateMinResidual ?? '',
      metric.quadCandidateMaxSurfaceSupport ?? 0,
      metric.quadCandidateBestFormation
        ? QUAD_CANDIDATE_FORMATION_GATE_NAMES
            .filter((gate) => !metric.quadCandidateBestFormation!.gates[gate])
            .join('|')
        : QUAD_CANDIDATE_FORMATION_GATE_NAMES.join('|'),
      metric.quadCandidateBestFormation?.provisionalCandidate?.x ?? '',
      metric.quadCandidateBestFormation?.provisionalCandidate?.y ?? '',
      metric.quadCandidateBestFormation?.gradientRayPoolCount ?? '',
      metric.quadCandidateBestFormation?.provisionalRayCount ?? '',
      metric.quadCandidateBestFormation?.provisionalRayQuality ?? '',
      metric.quadCandidateBestFormation?.provisionalRayResidual ?? '',
      metric.quadCandidateBestFormation?.surfaceSupportCount ?? '',
      metric.quadCandidateBestFormation?.trustedCandidate ? 1 : 0,
      metric.quadCandidateBestFormation?.gatesPassed ?? 0,
      ...QUAD_CANDIDATE_FORMATION_GATE_NAMES.map((gate) =>
        metric.quadCandidateGatePasses?.[gate] ?? 0),
      metric.meanComputeMs,
      metric.p95ComputeMs,
      experimentConfig.domainMeters,
      experimentConfig.durationSeconds,
      experimentConfig.stopOnNativeDeclaration ? 1 : 0,
      experimentConfig.fixedDt,
      experimentConfig.physicsStepSeconds ?? DEFAULT_PHYSICS_STEP_SECONDS,
      result.effectivePhysicsStepSeconds ?? '',
      experimentConfig.robotSpeed,
      experimentConfig.sensorProfileId,
      experimentConfig.sensorPpmPerNormalizedUnit,
      experimentConfig.sensorDetectionFloor,
      experimentConfig.sensorNoise,
      experimentConfig.sensorLag,
      experimentConfig.sensorThresholdScale,
      experimentConfig.sensorSaturation,
      experimentConfig.sensorFalsePositiveRate,
      experimentConfig.sensorFalseNegativeRate,
      experimentConfig.quadChannelNoiseCorrelation,
      experimentConfig.quadChannelGainMismatch,
      experimentConfig.quadChannelCrossTalk,
      experimentConfig.quadChannelLagMismatch,
      experimentConfig.windNoise,
      experimentConfig.activeSniffEnabled ? 1 : 0,
      experimentConfig.activeSniffStrength,
      experimentConfig.activeSniffReach,
      experimentConfig.activeSniffCycleSeconds,
      experimentConfig.physicalAtmosphere?.version ?? experimentConfig.physicsMode,
      experimentConfig.gridResolution,
      experimentConfig.windDirectionDegrees,
      experimentConfig.windSpeedScale,
      experimentConfig.turbulenceScale,
      experimentConfig.gustStrength,
      experimentConfig.diffusivityScale,
      experimentConfig.emissionRateScale,
      experimentConfig.targetStatus === 'emitting'
        ? experimentConfig.emissionRateScale
        : 0,
      experimentConfig.successThreshold,
      SIMULATOR_VERSION,
      ...(includeSI ? ['"' + JSON.stringify({ localInletSampling: experimentConfig.localInletSampling,
        physicalAtmosphere: experimentConfig.physicalAtmosphere }).replaceAll('"', '""') + '"'] : []),
    ].join(',')
  })
  return [header.join(','), ...rows].join('\n')
}
