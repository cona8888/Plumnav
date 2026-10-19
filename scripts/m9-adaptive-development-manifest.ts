/** Frozen M9 untouched-development screen for adaptive Quad acquisition/confirmation. */
import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  QUAD_ADAPTIVE_VIEWPOINT_POLICY,
  QUAD_STAGED_CROSSWIND_POLICY,
} from '../src/sim/algorithms/quadSoilSniff'
import { validateSimulationConfig } from '../src/sim/config'
import { CONTROLLER_OBSERVATION_MODEL_VERSION } from '../src/sim/controllerObservationModel'
import {
  createBalancedResearchScenarios,
  validateBalancedScenarioSet,
  type OrientationBin,
} from '../src/sim/research/scenarioAblations'
import { createScenario } from '../src/sim/scenarios'
import type { AlgorithmId, SimulationConfig, TargetStatus, Vec2 } from '../src/sim/types'

export const M9_ADAPTIVE_DEVELOPMENT_SCHEMA_VERSION = 'm9-adaptive-viewpoint-development-manifest-v1'
export const M9_EXPERIMENT_SEED = 2_026_090_6
export const M9_DURATION_SECONDS = 180

export type M9Condition = 'emitting' | 'absent'
export type M9ArmId =
  | 'adaptive-active'
  | 'staged-active'
  | 'adaptive-passive'
  | 'adaptive-zero-strength-sham'
export type M9Arm = {
  id: M9ArmId
  algorithmId: AlgorithmId
  policy: 'adaptive-viewpoint' | 'staged-three-ray'
  configOverrides: Partial<SimulationConfig>
}
export const M9_ARMS: readonly M9Arm[] = [
  {
    id: 'adaptive-active', algorithmId: 'quad-sniff', policy: 'adaptive-viewpoint',
    configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0.78 },
  },
  {
    id: 'staged-active', algorithmId: 'quad-sniff-staged', policy: 'staged-three-ray',
    configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0.78 },
  },
  {
    id: 'adaptive-passive', algorithmId: 'quad-passive', policy: 'adaptive-viewpoint',
    configOverrides: { activeSniffEnabled: false, activeSniffStrength: 0 },
  },
  {
    id: 'adaptive-zero-strength-sham', algorithmId: 'quad-sniff', policy: 'adaptive-viewpoint',
    configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0 },
  },
]

export type M9Cell = {
  id: string
  condition: M9Condition
  scenarioKind: 'open' | 'obstructed'
  orientationBin: OrientationBin
  replicate: number
  pairingKey: string
  counterfactualPairingKey: string
  counterfactualSourcePositionNormalized: Vec2
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  config: SimulationConfig
}
export type M9Manifest = {
  schemaVersion: typeof M9_ADAPTIVE_DEVELOPMENT_SCHEMA_VERSION
  partition: 'development-verification'
  purpose: 'untouched-seed development screen of one evidence-led adaptive viewpoint and passive-confirmation policy'
  requiredSimulatorVersion: '0.13.0'
  requiredTelemetrySchema: 'quad-candidate-formation-v1'
  claimBoundary: string
  evidenceBasis: {
    m8ManifestSha256: string
    m8RawResultsSha256: string
    m8ScientificResultsSha256: string
    m8AnalysisSha256: string
  }
  frozenRevision: typeof QUAD_ADAPTIVE_VIEWPOINT_POLICY
  frozenComparator: typeof QUAD_STAGED_CROSSWIND_POLICY
  unchangedDeclarationPolicy: true
  decisionRule: {
    primaryEndpoint: string
    safetyEndpoint: string
    obstacleEndpoint: string
    proceedCriteria: readonly string[]
    failureAction: string
  }
  design: {
    basePairedWorlds: 32
    conditionWorlds: 64
    armsPerConditionWorld: 4
    plannedSimulationRuns: 256
    fixedBudgetSeconds: 180
    physicsMode: 'grid'
    gridResolution: 96
    requestedPhysicsStepSeconds: 0.0125
  }
  conditions: readonly M9Condition[]
  arms: readonly M9Arm[]
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  cells: M9Cell[]
}

const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, item]) => [key, canonicalize(item)]))
    : value
const stableJson = (value: unknown) => `${JSON.stringify(canonicalize(value), null, 2)}\n`
export const m9ManifestSha256 = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

export const createM9Manifest = (): M9Manifest => {
  const layouts = createBalancedResearchScenarios({
    experimentSeed: M9_EXPERIMENT_SEED,
    replicatesPerOrientation: 4,
    scenarioKinds: ['open', 'obstructed'],
  })
  const validation = validateBalancedScenarioSet(layouts)
  if (!validation.valid) throw new Error(validation.errors.join('; '))
  if (layouts.length !== 32) throw new Error(`Expected 32 M9 base worlds, found ${layouts.length}`)
  const conditions: readonly M9Condition[] = ['emitting', 'absent']
  const cells: M9Cell[] = []
  for (const layout of layouts) {
    const source = layout.config.sourcePositionOverride
    if (!source) throw new Error(`${layout.id}: missing counterfactual source placement`)
    for (const condition of conditions) {
      const targetStatus: TargetStatus = condition
      const config: SimulationConfig = {
        ...layout.config,
        algorithmId: 'quad-sniff',
        targetStatus,
        durationSeconds: M9_DURATION_SECONDS,
        checkpointSeconds: [M9_DURATION_SECONDS],
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
    schemaVersion: M9_ADAPTIVE_DEVELOPMENT_SCHEMA_VERSION,
    partition: 'development-verification',
    purpose: 'untouched-seed development screen of one evidence-led adaptive viewpoint and passive-confirmation policy',
    requiredSimulatorVersion: '0.13.0',
    requiredTelemetrySchema: 'quad-candidate-formation-v1',
    claimBoundary: 'untouched development-verification only; no nominal validation, test, superiority, novelty, field, methane, landfill, urban, buried-pipeline, or deployment claim',
    evidenceBasis: {
      m8ManifestSha256: 'bf3b3bf04b2d4b3ede7f47b2e10aaadc8128d28ec642719ef6232511f4042631',
      m8RawResultsSha256: '59c96289cef1a05e04de29faa6cd21f15fe094ea84aea745c4f41670d6aa7a86',
      m8ScientificResultsSha256: 'b35704e7d90b92e1eb9524b9f1ad5a630da0d4392588bd05d5ad35c7ab4b7f75',
      m8AnalysisSha256: '93427fe9558fdb9ec8ec39956dcc7ceff569c62182627b748c6a81b6d725f036',
    },
    frozenRevision: QUAD_ADAPTIVE_VIEWPOINT_POLICY,
    frozenComparator: QUAD_STAGED_CROSSWIND_POLICY,
    unchangedDeclarationPolicy: true,
    decisionRule: {
      primaryEndpoint: 'paired source-present worlds reaching a geometrically trusted candidate: adaptive-active versus frozen M8 staged-active',
      safetyEndpoint: 'spurious source declarations in truly absent worlds for every arm',
      obstacleEndpoint: 'trusted-candidate formation and passive-confirmation progression in source-present obstructed worlds',
      proceedCriteria: [
        'adaptive-active reaches a trusted candidate in at least 6 of 32 emitting worlds',
        'paired adaptive-only trusted-candidate worlds exceed staged-only worlds by at least 6 with two-sided exact McNemar p <= 0.05',
        'adaptive-active reaches a trusted candidate in at least 3 of 16 obstructed emitting worlds',
        'adaptive-active progresses through all frozen declaration evidence gates for candidate, surface-count, passive-core-count and passive-ring-count in at least 2 of 32 emitting worlds',
        'adaptive-active produces at least 1 correct native source declaration and zero wrong source declarations in 32 emitting worlds',
        'adaptive-active produces zero spurious declarations in 32 absent worlds',
        'no downstream declaration threshold is changed after outcomes are viewed',
      ],
      failureAction: 'do not open nominal validation/test seeds; report the failed development criterion and return to upstream acquisition design',
    },
    design: {
      basePairedWorlds: 32,
      conditionWorlds: 64,
      armsPerConditionWorld: 4,
      plannedSimulationRuns: 256,
      fixedBudgetSeconds: M9_DURATION_SECONDS,
      physicsMode: 'grid',
      gridResolution: 96,
      requestedPhysicsStepSeconds: 0.0125,
    },
    conditions,
    arms: M9_ARMS,
    observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
    cells,
  }
}

export const writeM9Manifest = async (outputDirectory: string) => {
  const manifest = createM9Manifest()
  const manifestSha256 = m9ManifestSha256(manifest)
  await mkdir(outputDirectory, { recursive: true })
  const outputPath = join(outputDirectory, 'm9-adaptive-development-manifest.json')
  const temporary = `${outputPath}.${process.pid}.tmp`
  await writeFile(temporary, stableJson({ ...manifest, manifestSha256 }), 'utf8')
  await rename(temporary, outputPath)
  return { manifest, manifestSha256, outputPath }
}
