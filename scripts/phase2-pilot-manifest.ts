/**
 * Development-only Phase 2 pilot design.
 *
 * This module freezes a small, paired source-present smoke/runtime arm.  It
 * deliberately produces no runs or outcome data; a later, explicitly chosen
 * runner may consume the manifest.
 */
import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GridPlume } from '../src/sim/gridPlume'
import { validateSimulationConfig } from '../src/sim/config'
import { CONTROLLER_OBSERVATION_MODEL_VERSION } from '../src/sim/controllerObservationModel'
import {
  createBalancedResearchScenarios,
  validateBalancedScenarioSet,
  validateResearchScenario,
  type OrientationBin,
} from '../src/sim/research/scenarioAblations'
import { createScenario } from '../src/sim/scenarios'
import type { AlgorithmId, ScenarioKind, SimulationConfig } from '../src/sim/types'

export const PHASE2_PILOT_SCHEMA_VERSION = 'phase2-development-pilot-manifest-v4'
export const PHASE2_FINAL_CHECKPOINT_SECONDS = 180
export const PHASE2_GRID_RESOLUTION = 96
export const PHASE2_REQUESTED_PHYSICS_STEP_SECONDS = 0.0125

export type Phase2PilotArm = {
  id: 'coverage' | 'surge-cast' | 'infotaxis' | 'quad-active' | 'quad-zero-strength-sham'
  algorithmId: AlgorithmId
  label: string
  configOverrides: Partial<SimulationConfig>
}

export const PHASE2_PILOT_ARMS: readonly Phase2PilotArm[] = [
  { id: 'coverage', algorithmId: 'coverage', label: 'Coverage', configOverrides: {} },
  { id: 'surge-cast', algorithmId: 'surge-cast', label: 'Surge-cast', configOverrides: {} },
  { id: 'infotaxis', algorithmId: 'infotaxis', label: 'Infotaxis', configOverrides: {} },
  { id: 'quad-active', algorithmId: 'quad-sniff', label: 'Quad active', configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0.78 } },
  { id: 'quad-zero-strength-sham', algorithmId: 'quad-sniff', label: 'Quad timing-matched zero-strength sham', configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0 } },
]

export type Phase2PilotCell = {
  id: string
  armId: Phase2PilotArm['id']
  partition: 'development'
  scenarioKind: ScenarioKind
  orientationBin: OrientationBin
  replicate: number
  pairingKey: string
  seedPartition: {
    worldSeed: number
    sourceSeed: number
    controllerSeed: number
    observationModelSeed: number
  }
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  config: SimulationConfig
  physics: {
    mode: 'grid'
    resolution: number
    requestedStepSeconds: number
    effectiveStepSeconds: number
  }
}

export type Phase2PilotManifest = {
  schemaVersion: typeof PHASE2_PILOT_SCHEMA_VERSION
  partition: 'development'
  purpose: 'smoke, runtime, and variance estimation after truth-controller separation'
  estimand: 'paired arm-minus-arm difference in source-present correct terminal declaration at 180 seconds'
  claimBoundary: 'descriptive pilot only; no powered, confirmatory, or performance claim'
  exclusions: readonly string[]
  design: { sourcePresentOnly: true; scenarioKinds: readonly ScenarioKind[]; orientationBins: readonly OrientationBin[]; replicatesPerOrientation: number; finalCheckpointSeconds: 180; pairedLayouts: true }
  arms: readonly Phase2PilotArm[]
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  cells: Phase2PilotCell[]
}

/** Canonical JSON: object key order never affects a protocol digest. */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}
const stableJson = (value: unknown) => `${JSON.stringify(canonicalize(value), null, 2)}\n`
export const phase2PilotSha256 = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

const copyConfig = (config: SimulationConfig): SimulationConfig => ({
  ...config,
  checkpointSeconds: [...config.checkpointSeconds],
  sourcePositionOverride: config.sourcePositionOverride && { ...config.sourcePositionOverride },
  robotStartPositionOverride: config.robotStartPositionOverride && { ...config.robotStartPositionOverride },
})

export const createPhase2PilotManifest = (): Phase2PilotManifest => {
  const layouts = createBalancedResearchScenarios({
    experimentSeed: 2_026_082_9,
    replicatesPerOrientation: 2,
    scenarioKinds: ['open', 'obstructed'],
  })
  const setValidation = validateBalancedScenarioSet(layouts)
  if (!setValidation.valid) throw new Error(setValidation.errors.join('; '))
  const cells: Phase2PilotCell[] = []
  for (const arm of PHASE2_PILOT_ARMS) {
    for (const layout of layouts) {
      const validation = validateResearchScenario(layout)
      if (!validation.valid) throw new Error(`${layout.id}: ${validation.errors.join('; ')}`)
      const config = {
        ...copyConfig(layout.config),
        ...arm.configOverrides,
        algorithmId: arm.algorithmId,
        durationSeconds: PHASE2_FINAL_CHECKPOINT_SECONDS,
        checkpointSeconds: [PHASE2_FINAL_CHECKPOINT_SECONDS],
        physicsMode: 'grid',
        gridResolution: PHASE2_GRID_RESOLUTION,
        physicsStepSeconds: PHASE2_REQUESTED_PHYSICS_STEP_SECONDS,
        stopOnNativeDeclaration: false,
      } satisfies SimulationConfig
      validateSimulationConfig(config)
      const scenario = createScenario(layout.scenarioKind, config.seed, config)
      const plume = new GridPlume(scenario, config.seed, { resolution: config.gridResolution, stepSeconds: config.physicsStepSeconds })
      cells.push({
        id: `${arm.id}-${layout.id}`,
        armId: arm.id,
        partition: 'development',
        scenarioKind: layout.scenarioKind,
        orientationBin: layout.orientationBin,
        replicate: layout.replicate,
        pairingKey: layout.id,
        seedPartition: layout.seedPartition,
        observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
        config,
        physics: { mode: 'grid', resolution: plume.resolution, requestedStepSeconds: PHASE2_REQUESTED_PHYSICS_STEP_SECONDS, effectiveStepSeconds: plume.stepSeconds },
      })
    }
  }
  return {
    schemaVersion: PHASE2_PILOT_SCHEMA_VERSION,
    partition: 'development',
    purpose: 'smoke, runtime, and variance estimation after truth-controller separation',
    estimand: 'paired arm-minus-arm difference in source-present correct terminal declaration at 180 seconds',
    claimBoundary: 'descriptive pilot only; no powered, confirmatory, or performance claim',
    exclusions: ['source-absent safety', 'held-out inference', 'endpoint optimization', 'pooled claims across later study phases'],
    design: { sourcePresentOnly: true, scenarioKinds: ['open', 'obstructed'], orientationBins: ['downwind', 'crosswind-left', 'upwind', 'crosswind-right'], replicatesPerOrientation: 2, finalCheckpointSeconds: 180, pairedLayouts: true },
    arms: PHASE2_PILOT_ARMS,
    observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
    cells,
  }
}

export const writePhase2PilotManifest = async (outputDirectory: string) => {
  const manifest = createPhase2PilotManifest()
  const manifestSha256 = phase2PilotSha256(manifest)
  await mkdir(outputDirectory, { recursive: true })
  const outputPath = join(outputDirectory, 'phase2-pilot-manifest.json')
  const temporaryPath = `${outputPath}.tmp`
  await writeFile(temporaryPath, stableJson({ ...manifest, manifestSha256 }), 'utf8')
  await rename(temporaryPath, outputPath)
  return { manifest, manifestSha256, outputPath }
}
