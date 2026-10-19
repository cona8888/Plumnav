/** Frozen M7 development design for uncensored candidate-formation diagnosis. */
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

export const M7_PRE_CANDIDATE_SCHEMA_VERSION = 'm7-precandidate-diagnostic-manifest-v1'
export const M7_EXPERIMENT_SEED = 2_026_090_4
export const M7_DURATION_SECONDS = 180

export type M7Condition = 'emitting' | 'absent'
export type M7ArmId = 'quad-active' | 'quad-passive' | 'quad-zero-strength-sham'
export type M7Arm = {
  id: M7ArmId
  algorithmId: AlgorithmId
  configOverrides: Partial<SimulationConfig>
}
export const M7_ARMS: readonly M7Arm[] = [
  { id: 'quad-active', algorithmId: 'quad-sniff', configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0.78 } },
  { id: 'quad-passive', algorithmId: 'quad-passive', configOverrides: { activeSniffEnabled: false, activeSniffStrength: 0 } },
  { id: 'quad-zero-strength-sham', algorithmId: 'quad-sniff', configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0 } },
]

export type M7Cell = {
  id: string
  condition: M7Condition
  scenarioKind: 'open' | 'obstructed'
  orientationBin: OrientationBin
  replicate: number
  pairingKey: string
  counterfactualPairingKey: string
  counterfactualSourcePositionNormalized: Vec2
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  config: SimulationConfig
}
export type M7Manifest = {
  schemaVersion: typeof M7_PRE_CANDIDATE_SCHEMA_VERSION
  partition: 'development'
  purpose: 'uncensored provisional-ray and trusted-candidate formation diagnosis'
  requiredSimulatorVersion: '0.11.0'
  requiredTelemetrySchema: 'quad-candidate-formation-v1'
  claimBoundary: string
  design: {
    basePairedWorlds: 32
    conditionWorlds: 64
    armsPerConditionWorld: 3
    plannedSimulationRuns: 192
    fixedBudgetSeconds: 180
    physicsMode: 'grid'
    gridResolution: 96
    requestedPhysicsStepSeconds: 0.0125
  }
  conditions: readonly M7Condition[]
  arms: readonly M7Arm[]
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  cells: M7Cell[]
}

const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, item]) => [key, canonicalize(item)]))
    : value
const stableJson = (value: unknown) => `${JSON.stringify(canonicalize(value), null, 2)}\n`
export const m7ManifestSha256 = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

export const createM7Manifest = (): M7Manifest => {
  const layouts = createBalancedResearchScenarios({
    experimentSeed: M7_EXPERIMENT_SEED,
    replicatesPerOrientation: 4,
    scenarioKinds: ['open', 'obstructed'],
  })
  const validation = validateBalancedScenarioSet(layouts)
  if (!validation.valid) throw new Error(validation.errors.join('; '))
  if (layouts.length !== 32) throw new Error(`Expected 32 M7 base worlds, found ${layouts.length}`)
  const conditions: readonly M7Condition[] = ['emitting', 'absent']
  const cells: M7Cell[] = []
  for (const layout of layouts) {
    const source = layout.config.sourcePositionOverride
    if (!source) throw new Error(`${layout.id}: missing counterfactual source placement`)
    for (const condition of conditions) {
      const targetStatus: TargetStatus = condition
      const config: SimulationConfig = {
        ...layout.config,
        algorithmId: 'quad-sniff',
        targetStatus,
        durationSeconds: M7_DURATION_SECONDS,
        checkpointSeconds: [M7_DURATION_SECONDS],
        stopOnNativeDeclaration: false,
        physicsMode: 'grid',
        gridResolution: 96,
        physicsStepSeconds: 0.0125,
        sourcePositionOverride: condition === 'emitting' ? { ...source } : undefined,
        robotStartPositionOverride: layout.config.robotStartPositionOverride
          ? { ...layout.config.robotStartPositionOverride }
          : undefined,
      }
      validateSimulationConfig(config)
      const scenario = createScenario(layout.scenarioKind, config.seed, config)
      if ((condition === 'emitting') !== Boolean(scenario.source)) {
        throw new Error(`${layout.id}/${condition}: target-presence contract failed`)
      }
      cells.push({
        id: `${layout.id}-${condition}`,
        condition,
        scenarioKind: layout.scenarioKind,
        orientationBin: layout.orientationBin,
        replicate: layout.replicate,
        pairingKey: `${condition}|${layout.id}`,
        counterfactualPairingKey: layout.id,
        counterfactualSourcePositionNormalized: { ...source },
        observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
        config,
      })
    }
  }
  return {
    schemaVersion: M7_PRE_CANDIDATE_SCHEMA_VERSION,
    partition: 'development',
    purpose: 'uncensored provisional-ray and trusted-candidate formation diagnosis',
    requiredSimulatorVersion: '0.11.0',
    requiredTelemetrySchema: 'quad-candidate-formation-v1',
    claimBoundary: 'development-only diagnostic; no threshold tuning, validation, test, superiority, novelty, field, methane, landfill, urban, buried-pipeline, or deployment claim',
    design: {
      basePairedWorlds: 32,
      conditionWorlds: 64,
      armsPerConditionWorld: 3,
      plannedSimulationRuns: 192,
      fixedBudgetSeconds: M7_DURATION_SECONDS,
      physicsMode: 'grid',
      gridResolution: 96,
      requestedPhysicsStepSeconds: 0.0125,
    },
    conditions,
    arms: M7_ARMS,
    observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
    cells,
  }
}

export const writeM7Manifest = async (outputDirectory: string) => {
  const manifest = createM7Manifest()
  const manifestSha256 = m7ManifestSha256(manifest)
  await mkdir(outputDirectory, { recursive: true })
  const outputPath = join(outputDirectory, 'm7-precandidate-manifest.json')
  const temporary = `${outputPath}.${process.pid}.tmp`
  await writeFile(temporary, stableJson({ ...manifest, manifestSha256 }), 'utf8')
  await rename(temporary, outputPath)
  return { manifest, manifestSha256, outputPath }
}
