/**
 * Frozen development-only safety design. It contains no outcomes and must not
 * be pooled with the source-present Phase 2 pilot or held-out comparisons.
 */
import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createBalancedResearchScenarios,
  validateBalancedScenarioSet,
} from '../src/sim/research/scenarioAblations'
import { createScenario } from '../src/sim/scenarios'
import { validateSimulationConfig } from '../src/sim/config'
import { CONTROLLER_OBSERVATION_MODEL_VERSION } from '../src/sim/controllerObservationModel'
import type { AlgorithmId, TargetStatus, SimulationConfig } from '../src/sim/types'

export const PHASE3_SOURCE_ABSENT_SCHEMA_VERSION = 'phase3-source-absent-safety-manifest-v4'
export const PHASE3_CHECKPOINT_SECONDS = 180

/** Frozen Phase 3 algorithm set; later comparators require a new manifest generation. */
export const PHASE3_ALGORITHMS: readonly AlgorithmId[] = [
  'coverage',
  'surge-cast',
  'zigzag-spiral',
  'infotaxis',
  'smc-kl',
  'pmfs',
  'pulse-sniff',
  'quad-sniff',
]

export type Phase3SafetyCondition = 'absent' | 'zero-emission'

export type Phase3SafetyCell = {
  id: string
  algorithmId: AlgorithmId
  condition: Phase3SafetyCondition
  scenarioKind: 'open' | 'obstructed'
  /** Orientation of the matched counterfactual source; no source exists in an absent cell. */
  counterfactualOrientationBin: string
  replicate: number
  /** Pairs algorithms within one truth condition. */
  analysisPairingKey: string
  /** Links absent and zero-emission rows that share the same public world. */
  counterfactualPairingKey: string
  seedPartition: {
    worldSeed: number
    sourceSeed: number
    controllerSeed: number
    observationModelSeed: number
  }
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  config: SimulationConfig
}

export type Phase3SafetyManifest = {
  schemaVersion: typeof PHASE3_SOURCE_ABSENT_SCHEMA_VERSION
  partition: 'development'
  purpose: 'target-absent safety and zero-emission contract development only'
  claimBoundary: 'descriptive only; no confirmatory or superiority claim'
  design: {
    targetAbsentHasNoSourceCoordinate: true
    zeroEmissionRetainsSourceCoordinate: true
    controllerBlindToCondition: true
    matchedPublicWorldAcrossConditions: true
    fixedBudgetSeconds: 180
  }
  conditions: readonly Phase3SafetyCondition[]
  algorithms: readonly AlgorithmId[]
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  cells: Phase3SafetyCell[]
}

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
export const phase3SafetySha256 = (value: unknown) =>
  createHash('sha256').update(stableJson(value)).digest('hex')

export const createPhase3SafetyManifest = (): Phase3SafetyManifest => {
  const layouts = createBalancedResearchScenarios({
    experimentSeed: 2_026_082_9,
    replicatesPerOrientation: 2,
    scenarioKinds: ['open', 'obstructed'],
  })
  const layoutValidation = validateBalancedScenarioSet(layouts)
  if (!layoutValidation.valid) throw new Error(layoutValidation.errors.join('; '))
  const conditions: readonly Phase3SafetyCondition[] = ['absent', 'zero-emission']
  const cells: Phase3SafetyCell[] = []
  for (const algorithmId of PHASE3_ALGORITHMS) {
    for (const layout of layouts) {
      for (const condition of conditions) {
        const targetStatus: TargetStatus = condition
        const config: SimulationConfig = {
          ...layout.config,
          algorithmId,
          targetStatus,
          durationSeconds: PHASE3_CHECKPOINT_SECONDS,
          checkpointSeconds: [PHASE3_CHECKPOINT_SECONDS],
          stopOnNativeDeclaration: false,
          // A no-target row must not carry a source override. The zero-emission
          // row retains the matched source geometry for a fair control.
          sourcePositionOverride: condition === 'absent'
            ? undefined
            : layout.config.sourcePositionOverride
            ? { ...layout.config.sourcePositionOverride }
            : undefined,
          robotStartPositionOverride: layout.config.robotStartPositionOverride
            ? { ...layout.config.robotStartPositionOverride }
            : undefined,
        }
        validateSimulationConfig(config)
        const scenario = createScenario(layout.scenarioKind, config.seed, config)
        if (condition === 'absent' && scenario.source !== null) throw new Error('Absent cell retained a source')
        if (condition === 'zero-emission' && scenario.source === null) throw new Error('Zero-emission cell lost source geometry')
        cells.push({
          id: `${algorithmId}-${condition}-${layout.id}`,
          algorithmId,
          condition,
          scenarioKind: layout.scenarioKind,
          counterfactualOrientationBin: layout.orientationBin,
          replicate: layout.replicate,
          analysisPairingKey: `${condition}-${layout.id}`,
          counterfactualPairingKey: layout.id,
          seedPartition: layout.seedPartition,
          observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
          config,
        })
      }
    }
  }
  return {
    schemaVersion: PHASE3_SOURCE_ABSENT_SCHEMA_VERSION,
    partition: 'development',
    purpose: 'target-absent safety and zero-emission contract development only',
    claimBoundary: 'descriptive only; no confirmatory or superiority claim',
    design: {
      targetAbsentHasNoSourceCoordinate: true,
      zeroEmissionRetainsSourceCoordinate: true,
      controllerBlindToCondition: true,
      matchedPublicWorldAcrossConditions: true,
      fixedBudgetSeconds: PHASE3_CHECKPOINT_SECONDS,
    },
    conditions,
    algorithms: PHASE3_ALGORITHMS,
    observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
    cells,
  }
}

export const writePhase3SafetyManifest = async (outputDirectory: string) => {
  const manifest = createPhase3SafetyManifest()
  const manifestSha256 = phase3SafetySha256(manifest)
  await mkdir(outputDirectory, { recursive: true })
  const outputPath = join(outputDirectory, 'phase3-source-absent-safety-manifest.json')
  const temporaryPath = `${outputPath}.tmp`
  await writeFile(temporaryPath, stableJson({ ...manifest, manifestSha256 }), 'utf8')
  await rename(temporaryPath, outputPath)
  return { manifest, manifestSha256, outputPath }
}
