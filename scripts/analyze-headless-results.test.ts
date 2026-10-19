import { describe, expect, it } from 'vitest'
import {
  analyzeHeadlessRows,
  headlessAnalysisToCsv,
  parseHeadlessResultsCsv,
  type HeadlessResultRow,
} from './analyze-headless-results'

const row = (
  scenarioId: string,
  methodArm: HeadlessResultRow['methodArm'],
  success: boolean,
  normalizedError: number,
  declarationTimeSeconds: number | null,
  falseDeclarations = 0,
  overrides: Partial<HeadlessResultRow> = {},
): HeadlessResultRow => ({
  manifestSha256: 'a'.repeat(64),
  partition: 'test',
  scenarioId,
  scenario: 'open',
  targetStatus: 'emitting',
  terminalOutcome: declarationTimeSeconds === null
    ? 'deadline-nondeclaration-present'
    : falseDeclarations > 0
      ? 'wrong-declaration'
      : 'correct-declaration',
  orientationBin: 'downwind',
  replicate: Number(scenarioId.at(-1)),
  methodArm,
  seed: 101,
  sourceSeed: 202,
  controllerSeed: 303,
  observationModelSeed: 404,
  observationModelVersion: 'controller-observation-v1',
  sourceX: 0.8,
  sourceY: 0.5,
  robotStartX: 0.2,
  robotStartY: 0.5,
  robotStartHeadingDegrees: 0,
  windDirectionDegrees: 270,
  physicsMode: 'filament',
  gridResolution: 48,
  physicsStepSeconds: 0.25,
  effectivePhysicsStepSeconds: null,
  quadChannelNoiseCorrelation: 0,
  quadChannelGainMismatch: 0,
  quadChannelCrossTalk: 0,
  quadChannelLagMismatch: 0,
  checkpointSeconds: 180,
  success,
  normalizedError,
  nativeDeclaration: declarationTimeSeconds !== null,
  declarationTimeSeconds,
  falseDeclarations,
  ...overrides,
})

describe('headless result analysis', () => {
  it('keeps pairs intact and reports candidate-minus-reference effects', () => {
    const rows = [
      row('layout-1', 'coverage', false, 0.4, null),
      row('layout-1', 'quad-active', true, 0.1, 40),
      row('layout-2', 'coverage', true, 0.2, null),
      row('layout-2', 'quad-active', true, 0.1, 60),
      row('layout-3', 'coverage', false, 0.5, null),
      row('layout-3', 'quad-active', false, 0.3, 90, 1),
    ]
    const analysis = analyzeHeadlessRows(rows, {
      referenceArms: ['coverage'],
      bootstrapResamples: 100,
    })
    const result = analysis.comparisons[0]
    expect(result?.pairs).toBe(3)
    expect(result?.estimateSuccess.riskDifference).toBeCloseTo(1 / 3)
    expect(result?.normalizedErrorDifference.estimate).toBeCloseTo(-0.2)
    expect(result?.candidateDeclarations.falseDeclarationProbability.estimate).toBeCloseTo(1 / 3)
    expect(result?.correctDeclarationHolmP).toBe(result?.correctDeclaration.mcnemarExactP)
    expect(result?.correctDeclarationHolmP).not.toBe(result?.estimateSuccess.mcnemarExactP)
    expect(headlessAnalysisToCsv(analysis)).toContain('correct_declaration_mcnemar_holm_p')
    expect(analysis.primaryEndpoint).toMatch(/correct terminal declaration/)
  })

  it('strictly parses the runner CSV fields', () => {
    const csv = [
      'manifest_sha256,partition,scenario_id,orientation_bin,replicate,method_arm,seed,source_seed,controller_seed,controller_observation_model_seed,controller_observation_model_version,target_status,source_x_normalized,source_y_normalized,robot_start_x_normalized,robot_start_y_normalized,robot_start_heading_deg,wind_direction_toward_deg,physics_mode,grid_resolution,physics_step_s,effective_physics_step_s,quad_channel_noise_correlation,quad_channel_gain_mismatch,quad_channel_crosstalk,quad_channel_lag_mismatch,scenario,checkpoint_s,terminal_outcome,proximity_success,normalized_error,native_declaration,declaration_time_s,false_declarations',
      `${'a'.repeat(64)},test,test-open-downwind-000,downwind,0,quad-active,101,202,303,404,controller-observation-v1,emitting,0.8,0.5,0.2,0.5,0,270,filament,48,0.25,,0,0,0,0,open,180,correct-declaration,1,0.005,1,42.5,0`,
    ].join('\n')
    expect(parseHeadlessResultsCsv(csv)).toEqual([{
      manifestSha256: 'a'.repeat(64),
      partition: 'test',
      scenarioId: 'test-open-downwind-000',
      targetStatus: 'emitting',
      terminalOutcome: 'correct-declaration',
      orientationBin: 'downwind',
      replicate: 0,
      methodArm: 'quad-active',
      seed: 101,
      sourceSeed: 202,
      controllerSeed: 303,
      observationModelSeed: 404,
      observationModelVersion: 'controller-observation-v1',
      sourceX: 0.8,
      sourceY: 0.5,
      robotStartX: 0.2,
      robotStartY: 0.5,
      robotStartHeadingDegrees: 0,
      windDirectionDegrees: 270,
      physicsMode: 'filament',
      gridResolution: 48,
      physicsStepSeconds: 0.25,
      effectivePhysicsStepSeconds: null,
      quadChannelNoiseCorrelation: 0,
      quadChannelGainMismatch: 0,
      quadChannelCrossTalk: 0,
      quadChannelLagMismatch: 0,
      scenario: 'open',
      checkpointSeconds: 180,
      success: true,
      normalizedError: 0.005,
      nativeDeclaration: true,
      declarationTimeSeconds: 42.5,
      falseDeclarations: 0,
    }])
  })

  it('rejects internally inconsistent declaration fields during CSV parsing', () => {
    const header = 'manifest_sha256,partition,scenario_id,orientation_bin,replicate,method_arm,seed,source_seed,controller_seed,controller_observation_model_seed,controller_observation_model_version,target_status,source_x_normalized,source_y_normalized,robot_start_x_normalized,robot_start_y_normalized,robot_start_heading_deg,wind_direction_toward_deg,physics_mode,grid_resolution,physics_step_s,effective_physics_step_s,quad_channel_noise_correlation,quad_channel_gain_mismatch,quad_channel_crosstalk,quad_channel_lag_mismatch,scenario,checkpoint_s,terminal_outcome,proximity_success,normalized_error,native_declaration,declaration_time_s,false_declarations'
    const prefix = `${'a'.repeat(64)},test,id,downwind,0,quad-active,1,2,3,4,controller-observation-v1,emitting,0.8,0.5,0.2,0.5,0,270,filament,48,0.25,,0,0,0,0,open,180,pending,1,0.005`
    expect(() => parseHeadlessResultsCsv(`${header}\n${prefix},1,,0`)).toThrow('present together')
    expect(() => parseHeadlessResultsCsv(`${header}\n${prefix},0,,1`)).toThrow('requires native_declaration')
  })

  it('rejects method-arm labels outside the frozen runner vocabulary', () => {
    const header = 'manifest_sha256,partition,scenario_id,orientation_bin,replicate,method_arm,seed,source_seed,controller_seed,controller_observation_model_seed,controller_observation_model_version,target_status,source_x_normalized,source_y_normalized,robot_start_x_normalized,robot_start_y_normalized,robot_start_heading_deg,wind_direction_toward_deg,physics_mode,grid_resolution,physics_step_s,effective_physics_step_s,quad_channel_noise_correlation,quad_channel_gain_mismatch,quad_channel_crosstalk,quad_channel_lag_mismatch,scenario,checkpoint_s,terminal_outcome,proximity_success,normalized_error,native_declaration,declaration_time_s,false_declarations'
    const row = `${'a'.repeat(64)},development,id,downwind,0,quad-sham,1,2,3,4,controller-observation-v1,emitting,0.8,0.5,0.2,0.5,0,270,grid,96,0.0125,0.0125,0,0,0,0,open,180,deadline-nondeclaration-present,0,0.3,0,,0`
    expect(() => parseHeadlessResultsCsv(`${header}\n${row}`)).toThrow('Invalid method_arm')
  })

  it('uses one prespecified final checkpoint and keeps partitions separate', () => {
    const rows = [
      row('same-layout', 'coverage', false, 0.9, null, 0, { checkpointSeconds: 30 }),
      row('same-layout', 'quad-active', true, 0.1, 10, 0, { checkpointSeconds: 30 }),
      row('same-layout', 'coverage', true, 0.2, null, 0, { checkpointSeconds: 180 }),
      row('same-layout', 'quad-active', false, 0.8, null, 0, { checkpointSeconds: 180 }),
      row('same-layout', 'coverage', false, 0.7, null, 0, { partition: 'validation', checkpointSeconds: 180 }),
      row('same-layout', 'quad-active', true, 0.2, 20, 0, { partition: 'validation', checkpointSeconds: 180 }),
    ]
    const analysis = analyzeHeadlessRows(rows, {
      referenceArms: ['coverage'],
      bootstrapResamples: 10,
      includePartitions: ['test', 'validation'],
    })
    expect(analysis.comparisons).toHaveLength(2)
    expect(analysis.comparisons.map((item) => item.partition).sort()).toEqual(['test', 'validation'])
    const testComparison = analysis.comparisons.find((item) => item.partition === 'test')
    expect(testComparison?.checkpointSeconds).toBe(180)
    expect(testComparison?.estimateSuccess.riskDifference).toBe(-1)
  })
})
