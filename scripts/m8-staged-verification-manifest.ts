/** Frozen M8 untouched-development verification for the single staged Quad revision. */
import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { QUAD_STAGED_CROSSWIND_POLICY } from '../src/sim/algorithms/quadSoilSniff'
import { validateSimulationConfig } from '../src/sim/config'
import { CONTROLLER_OBSERVATION_MODEL_VERSION } from '../src/sim/controllerObservationModel'
import {
  createBalancedResearchScenarios,
  validateBalancedScenarioSet,
  type OrientationBin,
} from '../src/sim/research/scenarioAblations'
import { createScenario } from '../src/sim/scenarios'
import type { AlgorithmId, SimulationConfig, TargetStatus, Vec2 } from '../src/sim/types'

export const M8_STAGED_VERIFICATION_SCHEMA_VERSION = 'm8-staged-policy-verification-manifest-v1'
export const M8_EXPERIMENT_SEED = 2_026_090_5
export const M8_DURATION_SECONDS = 180

export type M8Condition = 'emitting' | 'absent'
export type M8ArmId =
  | 'staged-active'
  | 'legacy-active'
  | 'staged-passive'
  | 'staged-zero-strength-sham'
export type M8Arm = {
  id: M8ArmId
  algorithmId: AlgorithmId
  policy: 'staged-three-ray' | 'legacy-four-ray-surface'
  configOverrides: Partial<SimulationConfig>
}
export const M8_ARMS: readonly M8Arm[] = [
  {
    id: 'staged-active', algorithmId: 'quad-sniff', policy: 'staged-three-ray',
    configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0.78 },
  },
  {
    id: 'legacy-active', algorithmId: 'quad-sniff-legacy', policy: 'legacy-four-ray-surface',
    configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0.78 },
  },
  {
    id: 'staged-passive', algorithmId: 'quad-passive', policy: 'staged-three-ray',
    configOverrides: { activeSniffEnabled: false, activeSniffStrength: 0 },
  },
  {
    id: 'staged-zero-strength-sham', algorithmId: 'quad-sniff', policy: 'staged-three-ray',
    configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0 },
  },
]

export type M8Cell = {
  id: string
  condition: M8Condition
  scenarioKind: 'open' | 'obstructed'
  orientationBin: OrientationBin
  replicate: number
  pairingKey: string
  counterfactualPairingKey: string
  counterfactualSourcePositionNormalized: Vec2
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  config: SimulationConfig
}
export type M8Manifest = {
  schemaVersion: typeof M8_STAGED_VERIFICATION_SCHEMA_VERSION
  partition: 'development-verification'
  purpose: 'untouched-seed verification of one evidence-led staged crosswind-triangulation policy'
  requiredSimulatorVersion: '0.12.0'
  requiredTelemetrySchema: 'quad-candidate-formation-v1'
  claimBoundary: string
  evidenceBasis: {
    m7ManifestSha256: string
    m7RawResultsSha256: string
    m7ScientificResultsSha256: string
    m7AnalysisSha256: string
  }
  frozenRevision: typeof QUAD_STAGED_CROSSWIND_POLICY
  unchangedDeclarationPolicy: true
  decisionRule: {
    primaryEndpoint: string
    safetyEndpoint: string
    obstacleEndpoint: string
    proceedCriteria: readonly string[]
    failureAction: string
  }
  design: {
    basePairedWorlds: 64
    conditionWorlds: 128
    armsPerConditionWorld: 4
    plannedSimulationRuns: 512
    fixedBudgetSeconds: 180
    physicsMode: 'grid'
    gridResolution: 96
    requestedPhysicsStepSeconds: 0.0125
  }
  conditions: readonly M8Condition[]
  arms: readonly M8Arm[]
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  cells: M8Cell[]
}

const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, item]) => [key, canonicalize(item)]))
    : value
const stableJson = (value: unknown) => `${JSON.stringify(canonicalize(value), null, 2)}\n`
export const m8ManifestSha256 = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

export const createM8Manifest = (): M8Manifest => {
  const layouts = createBalancedResearchScenarios({
    experimentSeed: M8_EXPERIMENT_SEED,
    replicatesPerOrientation: 8,
    scenarioKinds: ['open', 'obstructed'],
  })
  const validation = validateBalancedScenarioSet(layouts)
  if (!validation.valid) throw new Error(validation.errors.join('; '))
  if (layouts.length !== 64) throw new Error(`Expected 64 M8 base worlds, found ${layouts.length}`)
  const conditions: readonly M8Condition[] = ['emitting', 'absent']
  const cells: M8Cell[] = []
  for (const layout of layouts) {
    const source = layout.config.sourcePositionOverride
    if (!source) throw new Error(`${layout.id}: missing counterfactual source placement`)
    for (const condition of conditions) {
      const targetStatus: TargetStatus = condition
      const config: SimulationConfig = {
        ...layout.config,
        algorithmId: 'quad-sniff',
        targetStatus,
        durationSeconds: M8_DURATION_SECONDS,
        checkpointSeconds: [M8_DURATION_SECONDS],
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
    schemaVersion: M8_STAGED_VERIFICATION_SCHEMA_VERSION,
    partition: 'development-verification',
    purpose: 'untouched-seed verification of one evidence-led staged crosswind-triangulation policy',
    requiredSimulatorVersion: '0.12.0',
    requiredTelemetrySchema: 'quad-candidate-formation-v1',
    claimBoundary: 'untouched development-verification only; no nominal validation, test, superiority, novelty, field, methane, landfill, urban, buried-pipeline, or deployment claim',
    evidenceBasis: {
      m7ManifestSha256: 'f74beadeaaa1744c5998d71770d9c22720943780da48d1dd330e1641095e2aca',
      m7RawResultsSha256: '4d515c9db28cff7588b452de0e20d91b1a9e30166daca5905bb37cb56e712fd3',
      m7ScientificResultsSha256: '7a0ae67b6f327607056fcb392cd9cf2f354e51b8556464c846e57cb02b8dffe4',
      m7AnalysisSha256: 'a22a01f8a56cea4b0886466b21eb427a531483f1c2e40de19fb37d9833d48696',
    },
    frozenRevision: QUAD_STAGED_CROSSWIND_POLICY,
    unchangedDeclarationPolicy: true,
    decisionRule: {
      primaryEndpoint: 'paired source-present worlds reaching a geometrically trusted candidate: staged-active versus legacy-active',
      safetyEndpoint: 'spurious source declarations in truly absent worlds for every arm',
      obstacleEndpoint: 'source-present obstructed worlds retaining at least one ray and reaching a trusted candidate',
      proceedCriteria: [
        'staged-active reaches a trusted candidate in at least 8 of 64 emitting worlds',
        'paired staged-only trusted-candidate worlds exceed legacy-only worlds by at least 6 with two-sided exact McNemar p <= 0.05',
        'staged-active reaches a trusted candidate in at least 4 of 32 obstructed emitting worlds',
        'staged-active produces zero spurious declarations in 64 absent worlds',
        'no downstream declaration threshold is changed after outcomes are viewed',
      ],
      failureAction: 'do not open nominal validation/test seeds; report the failed development criterion and return to upstream acquisition design',
    },
    design: {
      basePairedWorlds: 64,
      conditionWorlds: 128,
      armsPerConditionWorld: 4,
      plannedSimulationRuns: 512,
      fixedBudgetSeconds: M8_DURATION_SECONDS,
      physicsMode: 'grid',
      gridResolution: 96,
      requestedPhysicsStepSeconds: 0.0125,
    },
    conditions,
    arms: M8_ARMS,
    observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
    cells,
  }
}

export const writeM8Manifest = async (outputDirectory: string) => {
  const manifest = createM8Manifest()
  const manifestSha256 = m8ManifestSha256(manifest)
  await mkdir(outputDirectory, { recursive: true })
  const outputPath = join(outputDirectory, 'm8-staged-verification-manifest.json')
  const temporary = `${outputPath}.${process.pid}.tmp`
  await writeFile(temporary, stableJson({ ...manifest, manifestSha256 }), 'utf8')
  await rename(temporary, outputPath)
  return { manifest, manifestSha256, outputPath }
}
