import type { AlgorithmId, ScenarioKind, SimulationConfig } from './types'
import { validateLocalInletConfig } from './localInletSampling'
import { validatePhysicalAtmosphere } from './physicalAtmosphere'

export const SIMULATOR_VERSION = '0.20.1' as const

export const SENSOR_THRESHOLD_BY_SCENARIO: Record<ScenarioKind, number> = {
  open: 0.115,
  obstructed: 0.105,
}

export const DEFAULT_SENSOR_CONTROLS = {
  sensorProfileId: 'normalized-reference',
  sensorPpmPerNormalizedUnit: 1_000,
  sensorDetectionFloor: 0,
  sensorNoise: 0.025,
  sensorLag: 0.05,
  windNoise: 0.07,
  sensorThresholdScale: 1,
  sensorSaturation: 1.5,
  sensorFalsePositiveRate: 0,
  sensorFalseNegativeRate: 0,
} satisfies Pick<
  SimulationConfig,
  | 'sensorNoise'
  | 'sensorProfileId'
  | 'sensorPpmPerNormalizedUnit'
  | 'sensorDetectionFloor'
  | 'sensorLag'
  | 'windNoise'
  | 'sensorThresholdScale'
  | 'sensorSaturation'
  | 'sensorFalsePositiveRate'
  | 'sensorFalseNegativeRate'
>

export const DEFAULT_ACTIVE_SNIFF_CONTROLS = {
  activeSniffEnabled: true,
  activeSniffStrength: 0.78,
  activeSniffReach: 0.065,
  activeSniffCycleSeconds: 0.75,
} satisfies Pick<
  SimulationConfig,
  | 'activeSniffEnabled'
  | 'activeSniffStrength'
  | 'activeSniffReach'
  | 'activeSniffCycleSeconds'
>

/**
 * Deliberately simple Quad-Suction nuisance terms for sensitivity analyses.
 * They are not a claim of calibrated inlet, pump, or electronics behaviour.
 */
export const DEFAULT_QUAD_CHANNEL_NUISANCE_CONTROLS = {
  quadChannelNoiseCorrelation: 0,
  quadChannelGainMismatch: 0,
  quadChannelCrossTalk: 0,
  quadChannelLagMismatch: 0,
} satisfies Pick<
  SimulationConfig,
  | 'quadChannelNoiseCorrelation'
  | 'quadChannelGainMismatch'
  | 'quadChannelCrossTalk'
  | 'quadChannelLagMismatch'
>

export const DEFAULT_PHYSICS_CONTROLS = {
  physicsMode: 'filament',
  gridResolution: 48,
  physicsStepSeconds: 0.25,
} satisfies Pick<SimulationConfig, 'physicsMode' | 'gridResolution' | 'physicsStepSeconds'>
export const DEFAULT_PHYSICS_STEP_SECONDS = DEFAULT_PHYSICS_CONTROLS.physicsStepSeconds

export const DEFAULT_OBSTACLE_COMPLEXITY_LEVEL = 3

export const DEFAULT_TERRAIN_CONTROLS = {
  terrainSlopeDegrees: 0,
  terrainUphillDirectionDegrees: 0,
  gasBuoyancy: 'neutral',
  terrainGasDriftScale: 1,
  robotSlopeLimitDegrees: 25,
} satisfies Pick<
  SimulationConfig,
  | 'terrainSlopeDegrees'
  | 'terrainUphillDirectionDegrees'
  | 'gasBuoyancy'
  | 'terrainGasDriftScale'
  | 'robotSlopeLimitDegrees'
>

export const DEFAULT_FLOW_CONTROLS = {
  targetStatus: 'emitting',
  windDirectionDegrees: 265,
  windSpeedScale: 1,
  turbulenceScale: 1,
  gustStrength: 0.12,
  diffusivityScale: 1,
  emissionRateScale: 1,
} satisfies Pick<
  SimulationConfig,
  | 'targetStatus'
  | 'windDirectionDegrees'
  | 'windSpeedScale'
  | 'turbulenceScale'
  | 'gustStrength'
  | 'diffusivityScale'
  | 'emissionRateScale'
>

const requireFinite = (label: string, value: number) => {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`)
}

const validateOptionalUnitPoint = (
  label: string,
  point: SimulationConfig['sourcePositionOverride'],
) => {
  if (!point) return
  requireFinite(`${label}.x`, point.x)
  requireFinite(`${label}.y`, point.y)
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
    throw new RangeError(`${label} must lie inside the normalized unit domain`)
  }
}

export const validateSimulationConfig = (config: SimulationConfig) => {
  validatePhysicalAtmosphere(config, effectiveSensorThreshold(config))
  validateLocalInletConfig(config)
  if (!['emitting', 'zero-emission', 'absent'].includes(config.targetStatus)) {
    throw new RangeError('targetStatus must be emitting, zero-emission, or absent')
  }
  requireFinite('seed', config.seed)
  requireFinite('sourceSeed', config.sourceSeed)
  requireFinite('controllerSeed', config.controllerSeed)
  requireFinite('observationModelSeed', config.observationModelSeed)
  validateOptionalUnitPoint('sourcePositionOverride', config.sourcePositionOverride)
  validateOptionalUnitPoint('robotStartPositionOverride', config.robotStartPositionOverride)
  if (config.targetStatus === 'absent' && config.sourcePositionOverride !== undefined) {
    throw new RangeError('sourcePositionOverride is invalid for a target-absent trial')
  }
  if (config.robotStartHeadingDegrees !== undefined) {
    requireFinite('robotStartHeadingDegrees', config.robotStartHeadingDegrees)
  }
  requireFinite('domainMeters', config.domainMeters)
  requireFinite('durationSeconds', config.durationSeconds)
  requireFinite('fixedDt', config.fixedDt)
  if (config.physicsStepSeconds !== undefined) requireFinite('physicsStepSeconds', config.physicsStepSeconds)
  requireFinite('robotSpeed', config.robotSpeed)
  requireFinite('sensorPpmPerNormalizedUnit', config.sensorPpmPerNormalizedUnit)
  requireFinite('sensorDetectionFloor', config.sensorDetectionFloor)
  requireFinite('sensorNoise', config.sensorNoise)
  requireFinite('sensorLag', config.sensorLag)
  requireFinite('windNoise', config.windNoise)
  requireFinite('sensorThresholdScale', config.sensorThresholdScale)
  requireFinite('sensorSaturation', config.sensorSaturation)
  requireFinite('sensorFalsePositiveRate', config.sensorFalsePositiveRate)
  requireFinite('sensorFalseNegativeRate', config.sensorFalseNegativeRate)
  requireFinite('quadChannelNoiseCorrelation', config.quadChannelNoiseCorrelation)
  requireFinite('quadChannelGainMismatch', config.quadChannelGainMismatch)
  requireFinite('quadChannelCrossTalk', config.quadChannelCrossTalk)
  requireFinite('quadChannelLagMismatch', config.quadChannelLagMismatch)
  requireFinite('activeSniffStrength', config.activeSniffStrength)
  requireFinite('activeSniffReach', config.activeSniffReach)
  requireFinite('activeSniffCycleSeconds', config.activeSniffCycleSeconds)
  requireFinite('gridResolution', config.gridResolution)
  requireFinite('windDirectionDegrees', config.windDirectionDegrees)
  requireFinite('windSpeedScale', config.windSpeedScale)
  requireFinite('turbulenceScale', config.turbulenceScale)
  requireFinite('gustStrength', config.gustStrength)
  requireFinite('diffusivityScale', config.diffusivityScale)
  requireFinite('emissionRateScale', config.emissionRateScale)
  requireFinite('obstacleComplexityLevel', config.obstacleComplexityLevel)
  requireFinite('terrainSlopeDegrees', config.terrainSlopeDegrees)
  requireFinite('terrainUphillDirectionDegrees', config.terrainUphillDirectionDegrees)
  requireFinite('terrainGasDriftScale', config.terrainGasDriftScale)
  requireFinite('robotSlopeLimitDegrees', config.robotSlopeLimitDegrees)
  requireFinite('successThreshold', config.successThreshold)
  for (const checkpoint of config.checkpointSeconds) requireFinite('checkpointSeconds', checkpoint)

  if (!Number.isInteger(config.seed)) throw new RangeError('seed must be an integer')
  if (!Number.isInteger(config.sourceSeed)) throw new RangeError('sourceSeed must be an integer')
  if (!Number.isInteger(config.controllerSeed)) {
    throw new RangeError('controllerSeed must be an integer')
  }
  if (!Number.isInteger(config.observationModelSeed)) {
    throw new RangeError('observationModelSeed must be an integer')
  }
  if (
    config.robotStartHeadingDegrees !== undefined &&
    (config.robotStartHeadingDegrees < 0 || config.robotStartHeadingDegrees >= 360)
  ) {
    throw new RangeError('robotStartHeadingDegrees must be in [0, 360)')
  }
  if (config.domainMeters <= 0) throw new RangeError('domainMeters must be positive')
  if (config.durationSeconds <= 0) throw new RangeError('durationSeconds must be positive')
  if (config.fixedDt <= 0 || config.fixedDt > 1) throw new RangeError('fixedDt must be in (0, 1]')
  if (config.physicsStepSeconds !== undefined && (config.physicsStepSeconds <= 0 || config.physicsStepSeconds > 1)) {
    throw new RangeError('physicsStepSeconds must be in (0, 1]')
  }
  if (config.robotSpeed < 0 || config.robotSpeed > 0.25) {
    throw new RangeError('robotSpeed must be in [0, 0.25] normalized units per second')
  }
  if (config.sensorNoise < 0 || config.sensorLag <= 0 || config.windNoise < 0) {
    throw new RangeError('sensor noise, lag and wind noise must be non-negative (lag > 0)')
  }
  if (!['normalized-reference', 'custom', 'mps-mems', 'mems-mos-tgs8410', 'budget-mq4', 'ndir-platinum', 'tdlas-extractive', 'crds-g2401'].includes(config.sensorProfileId)) {
    throw new RangeError('sensorProfileId is not recognized')
  }
  if (config.sensorPpmPerNormalizedUnit <= 0) {
    throw new RangeError('sensorPpmPerNormalizedUnit must be positive')
  }
  if (config.sensorDetectionFloor < 0 || config.sensorDetectionFloor > 2) {
    throw new RangeError('sensorDetectionFloor must be in [0, 2]')
  }
  if (config.sensorThresholdScale < 0.1 || config.sensorThresholdScale > 3) {
    throw new RangeError('sensorThresholdScale must be in [0.1, 3]')
  }
  if (config.sensorSaturation <= 0 || config.sensorSaturation > 2) {
    throw new RangeError('sensorSaturation must be in (0, 2]')
  }
  if (
    config.sensorSaturation <
    effectiveSensorThreshold(config)
  ) {
    throw new RangeError('sensorSaturation must be at least the effective detection threshold')
  }
  if (typeof config.activeSniffEnabled !== 'boolean') {
    throw new RangeError('activeSniffEnabled must be boolean')
  }
  if (config.activeSniffStrength < 0 || config.activeSniffStrength > 1) {
    throw new RangeError('activeSniffStrength must be in [0, 1]')
  }
  if (!config.localInletSampling && (config.activeSniffReach < 0.005 || config.activeSniffReach > 0.15)) {
    throw new RangeError('activeSniffReach must be in [0.005, 0.15]')
  }
  if (!config.localInletSampling && (config.activeSniffCycleSeconds < 0.5 || config.activeSniffCycleSeconds > 3)) {
    throw new RangeError('activeSniffCycleSeconds must be in [0.5, 3]')
  }
  if (
    config.sensorFalsePositiveRate < 0 ||
    config.sensorFalsePositiveRate > 0.5 ||
    config.sensorFalseNegativeRate < 0 ||
    config.sensorFalseNegativeRate > 0.5
  ) {
    throw new RangeError('sensor false-positive and false-negative rates must be in [0, 0.5]')
  }
  if (config.quadChannelNoiseCorrelation < 0 || config.quadChannelNoiseCorrelation > 1) {
    throw new RangeError('quadChannelNoiseCorrelation must be in [0, 1]')
  }
  if (config.quadChannelGainMismatch < 0 || config.quadChannelGainMismatch > 0.5) {
    throw new RangeError('quadChannelGainMismatch must be in [0, 0.5]')
  }
  if (config.quadChannelCrossTalk < 0 || config.quadChannelCrossTalk > 1) {
    throw new RangeError('quadChannelCrossTalk must be in [0, 1]')
  }
  if (config.quadChannelLagMismatch < 0 || config.quadChannelLagMismatch > 0.9) {
    throw new RangeError('quadChannelLagMismatch must be in [0, 0.9]')
  }
  if (config.physicsMode !== 'filament' && config.physicsMode !== 'grid') {
    throw new RangeError('physicsMode must be filament or grid')
  }
  if (!Number.isInteger(config.gridResolution) || config.gridResolution < 24 || config.gridResolution > 256) {
    throw new RangeError('gridResolution must be an integer in [24, 256]')
  }
  if (config.windDirectionDegrees < 0 || config.windDirectionDegrees > 360) {
    throw new RangeError('windDirectionDegrees must be in [0, 360]')
  }
  if (config.windSpeedScale < 0.1 || config.windSpeedScale > 2.5) {
    throw new RangeError('windSpeedScale must be in [0.1, 2.5]')
  }
  if (config.turbulenceScale < 0 || config.turbulenceScale > 2) {
    throw new RangeError('turbulenceScale must be in [0, 2]')
  }
  if (config.gustStrength < 0 || config.gustStrength > 0.5) {
    throw new RangeError('gustStrength must be in [0, 0.5]')
  }
  if (config.diffusivityScale < 0.1 || config.diffusivityScale > 4) {
    throw new RangeError('diffusivityScale must be in [0.1, 4]')
  }
  if (config.emissionRateScale < 0.001 || config.emissionRateScale > 3) {
    throw new RangeError('emissionRateScale must be in [0.001, 3]')
  }
  if (
    !Number.isInteger(config.obstacleComplexityLevel) ||
    config.obstacleComplexityLevel < 0 ||
    config.obstacleComplexityLevel > 5
  ) {
    throw new RangeError('obstacleComplexityLevel must be an integer in [0, 5]')
  }
  if (
    config.physicsMode === 'grid' &&
    config.scenarioKind === 'obstructed' &&
    config.obstacleComplexityLevel === 5 &&
    config.gridResolution < 48
  ) {
    throw new RangeError('gridResolution must be at least 48 for obstacleComplexityLevel 5')
  }
  if (config.terrainSlopeDegrees < 0 || config.terrainSlopeDegrees > 30) {
    throw new RangeError('terrainSlopeDegrees must be in [0, 30]')
  }
  if (
    config.terrainUphillDirectionDegrees < 0 ||
    config.terrainUphillDirectionDegrees > 360
  ) {
    throw new RangeError('terrainUphillDirectionDegrees must be in [0, 360]')
  }
  if (!['neutral', 'dense', 'light'].includes(config.gasBuoyancy)) {
    throw new RangeError('gasBuoyancy must be neutral, dense or light')
  }
  if (config.terrainGasDriftScale < 0 || config.terrainGasDriftScale > 3) {
    throw new RangeError('terrainGasDriftScale must be in [0, 3]')
  }
  if (config.robotSlopeLimitDegrees < 5 || config.robotSlopeLimitDegrees > 45) {
    throw new RangeError('robotSlopeLimitDegrees must be in [5, 45]')
  }
  if (config.successThreshold <= 0 || config.successThreshold > Math.SQRT2) {
    throw new RangeError('successThreshold must be in (0, sqrt(2)]')
  }
  if (config.checkpointSeconds.some((checkpoint) => checkpoint < 0)) {
    throw new RangeError('checkpointSeconds cannot be negative')
  }
  return config
}

export const effectiveSensorThreshold = (config: SimulationConfig) =>
  (config.sensorDetectionFloor > 0
    ? config.sensorDetectionFloor
    : SENSOR_THRESHOLD_BY_SCENARIO[config.scenarioKind]) * config.sensorThresholdScale

export const createDefaultConfig = (
  algorithmId: AlgorithmId = 'surge-cast',
  scenarioKind: ScenarioKind = 'open',
): SimulationConfig => ({
  algorithmId,
  scenarioKind,
  seed: 42,
  sourceSeed: 2_097_169,
  controllerSeed: 1_048_573,
  observationModelSeed: 3_145_739,
  domainMeters: 100,
  durationSeconds: 180,
  checkpointSeconds: [30, 60, 120, 180],
  fixedDt: 0.25,
  robotSpeed: 0.05,
  ...DEFAULT_SENSOR_CONTROLS,
  ...DEFAULT_QUAD_CHANNEL_NUISANCE_CONTROLS,
  ...DEFAULT_ACTIVE_SNIFF_CONTROLS,
  ...DEFAULT_PHYSICS_CONTROLS,
  ...DEFAULT_FLOW_CONTROLS,
  obstacleComplexityLevel: DEFAULT_OBSTACLE_COMPLEXITY_LEVEL,
  ...DEFAULT_TERRAIN_CONTROLS,
  successThreshold: 0.01,
  stopOnNativeDeclaration: true,
})
