/** Frozen, development-only M6 calibration design. Contains no outcomes. */
import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateSimulationConfig } from '../src/sim/config'
import { CONTROLLER_OBSERVATION_MODEL_VERSION } from '../src/sim/controllerObservationModel'
import {
  createBalancedResearchScenarios,
  validateBalancedScenarioSet,
  type OrientationBin,
} from '../src/sim/research/scenarioAblations'
import { createScenario } from '../src/sim/scenarios'
import type { AlgorithmId, SimulationConfig, TargetStatus, Vec2 } from '../src/sim/types'

export const M6_CALIBRATION_SCHEMA_VERSION = 'm6-quad-calibration-manifest-v1'
export const M6_DURATION_SECONDS = 180
export const M6_EXPERIMENT_SEED = 2_026_090_3

export type M6Condition = 'emitting' | 'absent'
export type M6ArmId =
  | 'quad-active'
  | 'quad-passive'
  | 'quad-zero-strength-sham'
  | 'infotaxis'

export type M6Arm = {
  id: M6ArmId
  algorithmId: AlgorithmId
  label: string
  configOverrides: Partial<SimulationConfig>
}

export const M6_ARMS: readonly M6Arm[] = [
  {
    id: 'quad-active',
    algorithmId: 'quad-sniff',
    label: 'Quad-Suction active',
    configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0.78 },
  },
  {
    id: 'quad-passive',
    algorithmId: 'quad-passive',
    label: 'Four-head passive array',
    configOverrides: { activeSniffEnabled: false, activeSniffStrength: 0 },
  },
  {
    id: 'quad-zero-strength-sham',
    algorithmId: 'quad-sniff',
    label: 'Time-matched zero-strength sham',
    configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0 },
  },
  {
    id: 'infotaxis',
    algorithmId: 'infotaxis',
    label: 'Infotaxis sensitivity/specificity reference',
    configOverrides: {},
  },
]

export type M6CalibrationCell = {
  id: string
  condition: M6Condition
  scenarioKind: 'open' | 'obstructed'
  counterfactualOrientationBin: OrientationBin
  replicate: number
  pairingKey: string
  counterfactualPairingKey: string
  counterfactualSourcePositionNormalized: Vec2
  seedPartition: {
    worldSeed: number
    sourceSeed: number
    controllerSeed: number
    observationModelSeed: number
  }
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  config: SimulationConfig
}

export type M6CalibrationManifest = {
  schemaVersion: typeof M6_CALIBRATION_SCHEMA_VERSION
  partition: 'development'
  purpose: 'truth-blind Quad declaration calibration and active-value diagnosis'
  claimBoundary: string
  design: {
    basePairedWorlds: 128
    conditionWorlds: 256
    armsPerConditionWorld: 4
    plannedSimulationRuns: 1024
    emittingAndAbsentSharePublicWorld: true
    absentControllerReceivesNoSourceCoordinate: true
    fixedBudgetSeconds: 180
    physicsMode: 'grid'
    gridResolution: 96
    requestedPhysicsStepSeconds: 0.0125
  }
  conditions: readonly M6Condition[]
  arms: readonly M6Arm[]
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  cells: M6CalibrationCell[]
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}
const stableJson = (value: unknown) => `${JSON.stringify(canonicalize(value), null, 2)}\n`
export const m6CalibrationSha256 = (value: unknown) =>
  createHash('sha256').update(stableJson(value)).digest('hex')

export const createM6CalibrationManifest = (): M6CalibrationManifest => {
  const layouts = createBalancedResearchScenarios({
    experimentSeed: M6_EXPERIMENT_SEED,
    replicatesPerOrientation: 16,
    scenarioKinds: ['open', 'obstructed'],
  })
  const validation = validateBalancedScenarioSet(layouts)
  if (!validation.valid) throw new Error(validation.errors.join('; '))
  if (layouts.length !== 128) throw new Error(`Expected 128 M6 base worlds, found ${layouts.length}`)
  const conditions: readonly M6Condition[] = ['emitting', 'absent']
  const cells: M6CalibrationCell[] = []
  for (const layout of layouts) {
    const counterfactualSource = layout.config.sourcePositionOverride
    if (!counterfactualSource) throw new Error(`${layout.id}: missing source placement`)
    for (const condition of conditions) {
      const targetStatus: TargetStatus = condition
      const config: SimulationConfig = {
        ...layout.config,
        algorithmId: 'quad-sniff',
        targetStatus,
        durationSeconds: M6_DURATION_SECONDS,
        checkpointSeconds: [M6_DURATION_SECONDS],
        stopOnNativeDeclaration: false,
        physicsMode: 'grid',
        gridResolution: 96,
        physicsStepSeconds: 0.0125,
        sourcePositionOverride: condition === 'emitting'
          ? { ...counterfactualSource }
          : undefined,
        robotStartPositionOverride: layout.config.robotStartPositionOverride
          ? { ...layout.config.robotStartPositionOverride }
          : undefined,
      }
      validateSimulationConfig(config)
      const scenario = createScenario(layout.scenarioKind, config.seed, config)
      if ((condition === 'emitting') !== Boolean(scenario.source)) {
        throw new Error(`${layout.id}/${condition}: target presence contract failed`)
      }
      cells.push({
        id: `${layout.id}-${condition}`,
        condition,
        scenarioKind: layout.scenarioKind,
        counterfactualOrientationBin: layout.orientationBin,
        replicate: layout.replicate,
        pairingKey: `${condition}|${layout.id}`,
        counterfactualPairingKey: layout.id,
        counterfactualSourcePositionNormalized: { ...counterfactualSource },
        seedPartition: layout.seedPartition,
        observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
        config,
      })
    }
  }
  return {
    schemaVersion: M6_CALIBRATION_SCHEMA_VERSION,
    partition: 'development',
    purpose: 'truth-blind Quad declaration calibration and active-value diagnosis',
    claimBoundary:
      'development-only calibration; no validation, test, superiority, novelty, field, methane, landfill, urban, or buried-pipeline claim',
    design: {
      basePairedWorlds: 128,
      conditionWorlds: 256,
      armsPerConditionWorld: 4,
      plannedSimulationRuns: 1024,
      emittingAndAbsentSharePublicWorld: true,
      absentControllerReceivesNoSourceCoordinate: true,
      fixedBudgetSeconds: M6_DURATION_SECONDS,
      physicsMode: 'grid',
      gridResolution: 96,
      requestedPhysicsStepSeconds: 0.0125,
    },
    conditions,
    arms: M6_ARMS,
    observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
    cells,
  }
}

export const writeM6CalibrationManifest = async (outputDirectory: string) => {
  const manifest = createM6CalibrationManifest()
  const manifestSha256 = m6CalibrationSha256(manifest)
  await mkdir(outputDirectory, { recursive: true })
  const outputPath = join(outputDirectory, 'm6-calibration-manifest.json')
  const temporaryPath = `${outputPath}.${process.pid}.tmp`
  await writeFile(temporaryPath, stableJson({ ...manifest, manifestSha256 }), 'utf8')
  await rename(temporaryPath, outputPath)
  return { manifest, manifestSha256, outputPath }
}
