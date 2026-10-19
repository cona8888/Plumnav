/** Frozen M10 untouched-development screen for geometry-conditioned Quad acquisition/confirmation. */
import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  QUAD_ADAPTIVE_VIEWPOINT_POLICY,
  QUAD_GEOMETRY_CONDITIONED_POLICY,
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

export const M10_GEOMETRY_DEVELOPMENT_SCHEMA_VERSION = 'm10-geometry-conditioned-development-manifest-v1'
export const M10_EXPERIMENT_SEED = 2_026_090_7
export const M10_DURATION_SECONDS = 180

export type M10Condition = 'emitting' | 'absent'
export type M10ArmId =
  | 'geometry-active'
  | 'adaptive-active'
  | 'geometry-passive'
  | 'geometry-zero-strength-sham'
export type M10Arm = {
  id: M10ArmId
  algorithmId: AlgorithmId
  policy: 'geometry-conditioned' | 'adaptive-viewpoint'
  configOverrides: Partial<SimulationConfig>
}
export const M10_ARMS: readonly M10Arm[] = [
  {
    id: 'geometry-active', algorithmId: 'quad-sniff', policy: 'geometry-conditioned',
    configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0.78 },
  },
  {
    id: 'adaptive-active', algorithmId: 'quad-sniff-adaptive', policy: 'adaptive-viewpoint',
    configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0.78 },
  },
  {
    id: 'geometry-passive', algorithmId: 'quad-passive', policy: 'geometry-conditioned',
    configOverrides: { activeSniffEnabled: false, activeSniffStrength: 0 },
  },
  {
    id: 'geometry-zero-strength-sham', algorithmId: 'quad-sniff', policy: 'geometry-conditioned',
    configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0 },
  },
]

export type M10Cell = {
  id: string
  condition: M10Condition
  scenarioKind: 'open' | 'obstructed'
  orientationBin: OrientationBin
  replicate: number
  pairingKey: string
  counterfactualPairingKey: string
  counterfactualSourcePositionNormalized: Vec2
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  config: SimulationConfig
}
export type M10Manifest = {
  schemaVersion: typeof M10_GEOMETRY_DEVELOPMENT_SCHEMA_VERSION
  partition: 'development-verification'
  purpose: 'untouched-seed development screen of one evidence-led geometry-conditioned viewpoint and failed-confirmation reacquisition policy'
  requiredSimulatorVersion: '0.14.0'
  requiredTelemetrySchema: 'quad-candidate-formation-v1'
  claimBoundary: string
  evidenceBasis: {
    m9ManifestSha256: string
    m9RawResultsSha256: string
    m9ScientificResultsSha256: string
    m9CoreInventorySha256: string
    m9AnalysisSha256: string
    m9ReportSha256: string
  }
  frozenRevision: typeof QUAD_GEOMETRY_CONDITIONED_POLICY
  frozenComparator: typeof QUAD_ADAPTIVE_VIEWPOINT_POLICY
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
  conditions: readonly M10Condition[]
  arms: readonly M10Arm[]
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  cells: M10Cell[]
}

const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, item]) => [key, canonicalize(item)]))
    : value
const stableJson = (value: unknown) => `${JSON.stringify(canonicalize(value), null, 2)}\n`
export const m10ManifestSha256 = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

export const createM10Manifest = (): M10Manifest => {
  const layouts = createBalancedResearchScenarios({
    experimentSeed: M10_EXPERIMENT_SEED,
    replicatesPerOrientation: 4,
    scenarioKinds: ['open', 'obstructed'],
  })
  const validation = validateBalancedScenarioSet(layouts)
  if (!validation.valid) throw new Error(validation.errors.join('; '))
  if (layouts.length !== 32) throw new Error(`Expected 32 M10 base worlds, found ${layouts.length}`)
  const conditions: readonly M10Condition[] = ['emitting', 'absent']
  const cells: M10Cell[] = []
  for (const layout of layouts) {
    const source = layout.config.sourcePositionOverride
    if (!source) throw new Error(`${layout.id}: missing counterfactual source placement`)
    for (const condition of conditions) {
      const targetStatus: TargetStatus = condition
      const config: SimulationConfig = {
        ...layout.config,
        algorithmId: 'quad-sniff',
        targetStatus,
        durationSeconds: M10_DURATION_SECONDS,
        checkpointSeconds: [M10_DURATION_SECONDS],
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
    schemaVersion: M10_GEOMETRY_DEVELOPMENT_SCHEMA_VERSION,
    partition: 'development-verification',
    purpose: 'untouched-seed development screen of one evidence-led geometry-conditioned viewpoint and failed-confirmation reacquisition policy',
    requiredSimulatorVersion: '0.14.0',
    requiredTelemetrySchema: 'quad-candidate-formation-v1',
    claimBoundary: 'untouched development-verification only; no nominal validation, test, superiority, novelty, field, methane, landfill, urban, buried-pipeline, or deployment claim',
    evidenceBasis: {
      m9ManifestSha256: '07493ac2293e41ae239b3b59b9b8024dceb138af79f45554a9c9742d0ba6fed0',
      m9RawResultsSha256: '45a2458eb2e69686f1d19b5f79fd55986f06feecafbc75010601f3225d2188a2',
      m9ScientificResultsSha256: 'fd307845dd7954b18ad6f42aba079b9c9a44428da72df33db1225096fbc1d6f9',
      m9CoreInventorySha256: 'c575d32ce2d79e4322a417ccf9a35b3e13c210643386c9182ff1ae2d85e6834e',
      m9AnalysisSha256: '22521f48ecb45743313223a35fce70a264391e21441d589b30dc1a81435d4660',
      m9ReportSha256: '59c542f3963d83431cfcda343602c083e825e186b8f7c191cfac3c34c1f1cbdd',
    },
    frozenRevision: QUAD_GEOMETRY_CONDITIONED_POLICY,
    frozenComparator: QUAD_ADAPTIVE_VIEWPOINT_POLICY,
    unchangedDeclarationPolicy: true,
    decisionRule: {
      primaryEndpoint: 'paired source-present worlds reaching a geometrically trusted candidate: geometry-active versus frozen M9 adaptive-active',
      safetyEndpoint: 'spurious source declarations in truly absent worlds for every arm',
      obstacleEndpoint: 'trusted-candidate formation and passive-confirmation progression in source-present obstructed worlds',
      proceedCriteria: [
        'geometry-active reaches a trusted candidate in at least 6 of 32 emitting worlds',
        'paired geometry-only trusted-candidate worlds exceed adaptive-only worlds by at least 6 with two-sided exact McNemar p <= 0.05',
        'geometry-active reaches a trusted candidate in at least 3 of 16 obstructed emitting worlds',
        'geometry-active retains at least 3 usable gradient rays in at least 10 of 32 emitting worlds and passes the ray-quality gate at least once in at least 6 of 32 emitting worlds',
        'geometry-active progresses through all frozen declaration evidence gates for candidate, surface-count, passive-core-count and passive-ring-count in at least 2 of 32 emitting worlds',
        'geometry-active produces at least 1 correct native source declaration and zero wrong source declarations in 32 emitting worlds',
        'geometry-active produces zero spurious declarations in 32 absent worlds',
        'no downstream declaration threshold is changed after outcomes are viewed',
      ],
      failureAction: 'do not open nominal validation/test seeds; report the failed development criterion and return to upstream acquisition design',
    },
    design: {
      basePairedWorlds: 32,
      conditionWorlds: 64,
      armsPerConditionWorld: 4,
      plannedSimulationRuns: 256,
      fixedBudgetSeconds: M10_DURATION_SECONDS,
      physicsMode: 'grid',
      gridResolution: 96,
      requestedPhysicsStepSeconds: 0.0125,
    },
    conditions,
    arms: M10_ARMS,
    observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
    cells,
  }
}

export const writeM10Manifest = async (outputDirectory: string) => {
  const manifest = createM10Manifest()
  const manifestSha256 = m10ManifestSha256(manifest)
  await mkdir(outputDirectory, { recursive: true })
  const outputPath = join(outputDirectory, 'm10-geometry-development-manifest.json')
  const temporary = `${outputPath}.${process.pid}.tmp`
  await writeFile(temporary, stableJson({ ...manifest, manifestSha256 }), 'utf8')
  await rename(temporary, outputPath)
  return { manifest, manifestSha256, outputPath }
}
