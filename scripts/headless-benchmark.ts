/**
 * Reproducible, headless benchmark orchestration.
 *
 * Use local-sharded-benchmark.ts for real multi-process execution. The legacy
 * Vitest wrapper remains available as a backwards-compatible single-worker
 * entry point for existing automation.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { batchResultsToCsv, runBatch } from '../src/sim/batch'
import { DEFAULT_PHYSICS_STEP_SECONDS } from '../src/sim/config'
import { CONTROLLER_OBSERVATION_MODEL_VERSION } from '../src/sim/controllerObservationModel'
import { GridPlume } from '../src/sim/gridPlume'
import {
  analyzeHeadlessRows,
  headlessAnalysisToCsv,
  parseHeadlessResultsCsv,
  type HeadlessResultRow,
} from './analyze-headless-results'
import {
  QUAD_SUCTION_ABLATIONS,
  createBalancedResearchScenarios,
  validateResearchScenario,
  type OrientationBin,
} from '../src/sim/research/scenarioAblations'
import { createScenario } from '../src/sim/scenarios'
import type {
  AlgorithmId,
  BatchResult,
  ScenarioKind,
  SimulationConfig,
  Vec2,
} from '../src/sim/types'

export const BENCHMARK_SCHEMA_VERSION = 'headless-benchmark-v7'
export const SCIENTIFIC_PROJECTION_SCHEMA_VERSION = 'headless-scientific-projection-v1'
export const ALGORITHMS: AlgorithmId[] = [
  'coverage',
  'surge-cast',
  'zigzag-spiral',
  'infotaxis',
  'smc-kl',
  'pmfs',
  'pulse-sniff',
  'quad-sniff',
  'quad-passive',
]

export type BenchmarkArmId =
  | Exclude<AlgorithmId, 'quad-sniff'>
  | 'quad-active'
  | 'quad-zero-strength-sham'
  | 'quad-sampler-disabled'

export type BenchmarkArm = {
  id: BenchmarkArmId
  algorithmId: AlgorithmId
  label: string
  configOverrides: Partial<SimulationConfig>
}

export const BENCHMARK_ARMS: readonly BenchmarkArm[] = [
  ...ALGORITHMS.filter((algorithmId) => algorithmId !== 'quad-sniff').map(
    (algorithmId): BenchmarkArm => ({
      id: algorithmId,
      algorithmId,
      label: algorithmId,
      configOverrides: {},
    }),
  ),
  {
    id: 'quad-active',
    algorithmId: 'quad-sniff',
    label: 'Quad-Suction active',
    configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0.78 },
  },
  {
    id: 'quad-zero-strength-sham',
    algorithmId: 'quad-sniff',
    label: 'Quad-Suction time-matched zero-strength sham',
    configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0 },
  },
  {
    id: 'quad-sampler-disabled',
    algorithmId: 'quad-sniff',
    label: 'Quad controller with active sampler disabled',
    configOverrides: { activeSniffEnabled: false },
  },
]

export type ProfileName = 'commissioning' | 'm5-development' | 'ci' | 'pilot' | 'full'
export type PartitionName = 'development' | 'validation' | 'test'

export const analysisPartitionsForProfile = (profile: ProfileName): PartitionName[] =>
  profile === 'commissioning' || profile === 'm5-development'
    ? ['development']
    : ['test']

type Profile = {
  durationSeconds: number
  checkpointSeconds: number[]
  /** Four bins make this many independent layouts per scenario and partition. */
  replicatesPerOrientation: number
  partitions: PartitionName[]
  experimentSeeds?: Partial<Record<PartitionName, number>>
  armIds?: readonly BenchmarkArmId[]
  physics?: {
    mode: 'grid'
    resolution: number
    stepSeconds: number
  }
}

export type ManifestCell = {
  id: string
  partition: PartitionName
  scenarioKind: ScenarioKind
  orientationBin: OrientationBin
  replicate: number
  windDirectionDegrees: number
  baseSeeds: Pick<
    SimulationConfig,
    'seed' | 'sourceSeed' | 'controllerSeed' | 'observationModelSeed'
  >
  placementPlan: {
    sourcePositionNormalized: Vec2
    robotStartPositionNormalized: Vec2
    robotStartHeadingDegrees: number
    sourceToStartBearingDegrees: number
    sourceWindAngleDegrees: number
  }
  config: SimulationConfig
}

export type BenchmarkManifest = {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION
  profile: ProfileName
  algorithms: AlgorithmId[]
  arms: BenchmarkArm[]
  unavailableControls: Array<{ id: string; rationale: string }>
  partitions: PartitionName[]
  seedSchedule: string
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  layoutsPerScenarioAndPartition: number
  implementationSha256?: string
  cells: ManifestCell[]
}

export type RunnerOptions = {
  profile: ProfileName
  outputDirectory: string
  dryRun?: boolean
}

export type RuntimeProvenance = {
  node: string
  v8: string
  platform: string
  architecture: string
  osRelease: string
  cpuModel: string
}

export type ImplementationProvenance = {
  schemaVersion: 'headless-implementation-v1'
  files: Array<{ path: string; bytes: number; sha256: string }>
  implementationSha256: string
}

export type PreparedHeadlessBenchmark = {
  manifest: BenchmarkManifest
  manifestSha256: string
  implementationSha256: string
  implementationProvenance: ImplementationProvenance
  runtime: RuntimeProvenance
  runtimeFingerprint: string
  outputDirectory: string
  plannedSimulationRuns: number
}

export type HeadlessShardResult = {
  shardIndex: number
  shardCount: number
  assignedCells: number
  completedCells: number
  skippedCells: number
}

const PROFILES: Record<ProfileName, Profile> = {
  // Independent development-only layouts for local worker commissioning.
  // Three layouts per orientation preserve the 240-run size of the old CI
  // smoke corpus without exposing any validation or test seed.
  commissioning: {
    durationSeconds: 20,
    checkpointSeconds: [20],
    replicatesPerOrientation: 3,
    partitions: ['development'],
    experimentSeeds: { development: 910_039 },
  },
  // Fresh post-repair development screen. Six arms share each of 128 worlds;
  // validation and test partitions are deliberately inaccessible here.
  'm5-development': {
    durationSeconds: 180,
    checkpointSeconds: [180],
    replicatesPerOrientation: 16,
    partitions: ['development'],
    experimentSeeds: { development: 2_026_090_2 },
    armIds: [
      'coverage',
      'surge-cast',
      'infotaxis',
      'quad-active',
      'quad-zero-strength-sham',
      'quad-passive',
    ],
    physics: { mode: 'grid', resolution: 96, stepSeconds: 0.0125 },
  },
  // One independent layout in each of four source-wind bins.
  ci: {
    durationSeconds: 20,
    checkpointSeconds: [20],
    replicatesPerOrientation: 1,
    partitions: ['development', 'validation', 'test'],
  },
  // Eight layouts per orientation bin: suitable for workflow/pilot checks,
  // never for a confirmatory performance claim.
  pilot: {
    durationSeconds: 180,
    checkpointSeconds: [30, 60, 120, 180],
    replicatesPerOrientation: 8,
    partitions: ['development', 'validation', 'test'],
  },
  // Fifty layouts in each of four bins = 200 paired layouts per scenario and
  // partition, matching the preregistered core comparison target.
  full: {
    durationSeconds: 180,
    checkpointSeconds: [30, 60, 120, 180],
    replicatesPerOrientation: 50,
    partitions: ['development', 'validation', 'test'],
  },
}

const PARTITION_EXPERIMENT_SEEDS: Record<PartitionName, number> = {
  development: 110_003,
  validation: 410_009,
  test: 710_023,
}

const stableJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const digest = (value: unknown) =>
  createHash('sha256').update(stableJson(value)).digest('hex')
export const benchmarkManifestSha256 = (value: unknown) => digest(value)
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

const atomicWrite = async (path: string, contents: string) => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

const implementationFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? implementationFiles(path) : [path]
  }))
  return paths.flat()
}

/**
 * Hash the executable simulator, runner and dependency locks. This makes a
 * code change invalidate cell completion records even before a Git history is
 * available. The archived release should additionally record a commit/DOI.
 */
export const getImplementationProvenance = async (): Promise<ImplementationProvenance> => {
  const paths = [
    ...(await implementationFiles(join(projectRoot, 'src', 'sim'))),
    join(projectRoot, 'scripts', 'headless-benchmark.ts'),
    join(projectRoot, 'scripts', 'local-sharded-benchmark.ts'),
    join(projectRoot, 'scripts', 'analyze-headless-results.ts'),
    join(projectRoot, 'scripts', 'vitest.headless.config.ts'),
    join(projectRoot, 'package.json'),
    join(projectRoot, 'pnpm-workspace.yaml'),
    join(projectRoot, 'pnpm-lock.yaml'),
    join(projectRoot, 'tsconfig.json'),
    join(projectRoot, 'tsconfig.app.json'),
    join(projectRoot, 'tsconfig.node.json'),
    join(projectRoot, 'vite.config.ts'),
  ].sort()
  const hash = createHash('sha256')
  const files: ImplementationProvenance['files'] = []
  for (const path of paths) {
    const contents = await readFile(path)
    const relativePath = path.slice(projectRoot.length)
    hash.update(path.slice(projectRoot.length))
    hash.update('\0')
    hash.update(contents)
    hash.update('\0')
    files.push({
      path: relativePath,
      bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    })
  }
  return {
    schemaVersion: 'headless-implementation-v1',
    files,
    implementationSha256: hash.digest('hex'),
  }
}

export const implementationDigest = async () =>
  (await getImplementationProvenance()).implementationSha256

export const getRuntimeProvenance = (): RuntimeProvenance => ({
  node: process.versions.node,
  v8: process.versions.v8,
  platform: platform(),
  architecture: arch(),
  osRelease: release(),
  cpuModel: cpus()[0]?.model ?? 'unknown',
})

export const runtimeProvenanceFingerprint = (runtime: RuntimeProvenance) => digest(runtime)

export const createManifest = (profileName: ProfileName): BenchmarkManifest => {
  const profile = PROFILES[profileName]
  const profileArms = profile.armIds
    ? profile.armIds.map((armId) => {
        const arm = BENCHMARK_ARMS.find((candidate) => candidate.id === armId)
        if (!arm) throw new Error(`${profileName}: unknown benchmark arm ${armId}`)
        return arm
      })
    : BENCHMARK_ARMS
  const cells: ManifestCell[] = []
  for (const partition of profile.partitions) {
    const scenarios = createBalancedResearchScenarios({
      experimentSeed: profile.experimentSeeds?.[partition] ?? PARTITION_EXPERIMENT_SEEDS[partition],
      replicatesPerOrientation: profile.replicatesPerOrientation,
    })
    for (const scenario of scenarios) {
      const validation = validateResearchScenario(scenario)
      if (!validation.valid) {
        throw new Error(`${partition}/${scenario.id}: ${validation.errors.join('; ')}`)
      }
      const config: SimulationConfig = {
        ...scenario.config,
        algorithmId: ALGORITHMS[0],
        targetStatus: 'emitting',
        durationSeconds: profile.durationSeconds,
        checkpointSeconds: [...profile.checkpointSeconds],
        stopOnNativeDeclaration: false,
        ...(profile.physics
          ? {
              physicsMode: profile.physics.mode,
              gridResolution: profile.physics.resolution,
              physicsStepSeconds: profile.physics.stepSeconds,
            }
          : {}),
      }
      cells.push({
        id: `${partition}-${scenario.scenarioKind}-${scenario.orientationBin}-${String(scenario.replicate).padStart(3, '0')}`,
        partition,
        scenarioKind: scenario.scenarioKind,
        orientationBin: scenario.orientationBin,
        replicate: scenario.replicate,
        windDirectionDegrees: config.windDirectionDegrees,
        baseSeeds: {
          seed: config.seed,
          sourceSeed: config.sourceSeed,
          controllerSeed: config.controllerSeed,
          observationModelSeed: config.observationModelSeed,
        },
        placementPlan: {
          sourcePositionNormalized: { ...scenario.privateLayout.source },
          robotStartPositionNormalized: { ...scenario.privateLayout.robotStart },
          robotStartHeadingDegrees: scenario.privateLayout.robotStartHeadingDegrees,
          sourceToStartBearingDegrees: scenario.privateLayout.sourceToStartBearingDegrees,
          sourceWindAngleDegrees: scenario.privateLayout.sourceWindAngleDegrees,
        },
        config,
      })
    }
  }
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    profile: profileName,
    algorithms: profile.armIds
      ? [...new Set(profileArms.map((arm) => arm.algorithmId))]
      : [...ALGORITHMS],
    arms: profileArms.map((arm) => ({
      ...arm,
      configOverrides: { ...arm.configOverrides },
    })),
    unavailableControls: QUAD_SUCTION_ABLATIONS
      .filter((control) => !control.executableNow)
      .map((control) => ({ id: control.id, rationale: control.rationale })),
    partitions: [...profile.partitions],
    seedSchedule:
      'labelled hash streams create one explicit world/source/controller/observation-model seed quadruplet per paired layout; each method arm reuses that quadruplet',
    observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
    layoutsPerScenarioAndPartition: profile.replicatesPerOrientation * 4,
    cells,
  }
}

const SCIENTIFICALLY_EXCLUDED_COLUMNS = new Set([
  // These are measured with performance.now() and reflect host scheduling,
  // not simulated state. All simulated-time columns remain in the projection.
  'mean_compute_ms',
  'p95_compute_ms',
])

/**
 * Canonical scientific payload for exact same-runtime equivalence checks.
 * Row order is intentionally retained because the seeded bootstrap consumes
 * observations in insertion order.
 */
export const scientificProjectionForCsv = (csv: string) => {
  const lines = csv.trimEnd().split(/\r?\n/)
  const header = lines[0]?.split(',') ?? []
  if (header.length === 0 || header[0] === '') throw new Error('CSV header is empty')
  if (new Set(header).size !== header.length) throw new Error('CSV header contains duplicate columns')
  for (const column of SCIENTIFICALLY_EXCLUDED_COLUMNS) {
    if (!header.includes(column)) throw new Error(`Missing execution-timing column: ${column}`)
  }
  const includedIndexes = header
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !SCIENTIFICALLY_EXCLUDED_COLUMNS.has(column))
  const rows = lines.slice(1).filter(Boolean).map((line, rowIndex) => {
    const values = line.split(',')
    if (values.length !== header.length) {
      throw new Error(`CSV row ${rowIndex + 2} has ${values.length} fields; expected ${header.length}`)
    }
    return includedIndexes.map(({ index }) => values[index] ?? '')
  })
  return stableJson({
    schemaVersion: SCIENTIFIC_PROJECTION_SCHEMA_VERSION,
    columns: includedIndexes.map(({ column }) => column),
    rows,
  })
}

export const scientificCsvSha256 = (csv: string) =>
  sha256(scientificProjectionForCsv(csv))

export const selectManifestShard = <T>(
  cells: readonly T[],
  shardIndex: number,
  shardCount: number,
) => {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new RangeError(`shardCount must be a positive integer, received ${shardCount}`)
  }
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new RangeError(`shardIndex must be an integer in [0, ${shardCount}), received ${shardIndex}`)
  }
  return cells.filter((_, index) => index % shardCount === shardIndex)
}

export const headlessCellFingerprint = (
  cell: ManifestCell,
  arms: readonly BenchmarkArm[],
) => digest({ schemaVersion: BENCHMARK_SCHEMA_VERSION, cell, arms })

type CellCompletionMetadata = {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION
  manifestSha256: string
  implementationSha256: string
  runtimeFingerprint: string
  cellId: string
  cellFingerprint: string
  complete: true
  methodArms: BenchmarkArmId[]
  rawRows: number
  artifactSha256: string
  scientificSha256: string
}

type ArmResult = { armId: BenchmarkArmId; result: BatchResult }

const csvHeader = () =>
  `manifest_sha256,partition,scenario_id,orientation_bin,replicate,method_arm,${batchResultsToCsv([]).trimEnd()}`

const rawCsvForCell = (
  cell: ManifestCell,
  results: ArmResult[],
  manifestSha256: string,
) => {
  const rows = results.map(({ armId, result }) => {
    const oneResultCsv = batchResultsToCsv([result]).split('\n')[1]
    if (!oneResultCsv) throw new Error(`Could not render result for ${cell.id}/${armId}`)
    return `${manifestSha256},${cell.partition},${cell.id},${cell.orientationBin},${cell.replicate},${armId},${oneResultCsv}`
  })
  return `${csvHeader()}\n${rows.join('\n')}\n`
}

const runCell = async (cell: ManifestCell, arms: readonly BenchmarkArm[]) => {
  const results: ArmResult[] = []
  for (const arm of arms) {
    const config: SimulationConfig = {
      ...cell.config,
      ...arm.configOverrides,
      algorithmId: arm.algorithmId,
      checkpointSeconds: [...cell.config.checkpointSeconds],
      sourcePositionOverride: cell.config.sourcePositionOverride
        ? { ...cell.config.sourcePositionOverride }
        : undefined,
      robotStartPositionOverride: cell.config.robotStartPositionOverride
        ? { ...cell.config.robotStartPositionOverride }
        : undefined,
    }
    const batch = await runBatch(config, [arm.algorithmId], [cell.scenarioKind], 1)
    for (const result of batch.results) results.push({ armId: arm.id, result })
  }
  return results
}

const almostEqual = (first: number, second: number) =>
  Math.abs(first - second) <= 1e-12

/**
 * Bind every analysis row back to the frozen manifest before calculating any
 * effect. This prevents edited or mixed CSV files with reused scenario IDs
 * from being silently treated as paired observations.
 */
export const validateRowsAgainstManifest = (
  rows: readonly HeadlessResultRow[],
  manifest: BenchmarkManifest,
  manifestSha256: string,
) => {
  const cells = new Map(manifest.cells.map((cell) => [cell.id, cell]))
  const effectivePhysicsSteps = new Map(manifest.cells.map((cell) => {
    if (cell.config.physicsMode !== 'grid') return [cell.id, null] as const
    const plume = new GridPlume(
      createScenario(cell.scenarioKind, cell.config.seed, cell.config),
      cell.config.seed,
      {
        resolution: cell.config.gridResolution,
        stepSeconds: cell.config.physicsStepSeconds ?? DEFAULT_PHYSICS_STEP_SECONDS,
      },
    )
    return [cell.id, plume.stepSeconds] as const
  }))
  const arms = new Set(manifest.arms.map((arm) => arm.id))
  const expectedRows = manifest.cells.reduce(
    (sum, cell) => sum + cell.config.checkpointSeconds.length * manifest.arms.length,
    0,
  )
  if (rows.length !== expectedRows) {
    throw new Error(`Raw result count ${rows.length} does not match manifest expectation ${expectedRows}`)
  }
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.manifestSha256 !== manifestSha256) {
      throw new Error(`${row.scenarioId}: raw row manifest digest mismatch`)
    }
    const cell = cells.get(row.scenarioId)
    if (!cell) throw new Error(`Raw row references unknown scenario cell ${row.scenarioId}`)
    if (!arms.has(row.methodArm)) throw new Error(`${cell.id}: unknown method arm ${row.methodArm}`)
    if (
      row.partition !== cell.partition ||
      row.scenario !== cell.scenarioKind ||
      row.targetStatus !== cell.config.targetStatus ||
      row.orientationBin !== cell.orientationBin ||
      row.replicate !== cell.replicate
    ) {
      throw new Error(`${cell.id}/${row.methodArm}: manifest cell identity mismatch`)
    }
    if (!cell.config.checkpointSeconds.includes(row.checkpointSeconds)) {
      throw new Error(`${cell.id}/${row.methodArm}: unexpected checkpoint ${row.checkpointSeconds}`)
    }
    const source = cell.config.sourcePositionOverride
    const start = cell.config.robotStartPositionOverride
    const effectivePhysicsStep = effectivePhysicsSteps.get(cell.id) ?? null
    if (
      row.seed !== cell.baseSeeds.seed ||
      row.sourceSeed !== cell.baseSeeds.sourceSeed ||
      row.controllerSeed !== cell.baseSeeds.controllerSeed ||
      row.observationModelSeed !== cell.baseSeeds.observationModelSeed ||
      row.observationModelVersion !== manifest.observationModelVersion ||
      !source ||
      !start ||
      !almostEqual(row.sourceX, source.x) ||
      !almostEqual(row.sourceY, source.y) ||
      !almostEqual(row.robotStartX, start.x) ||
      !almostEqual(row.robotStartY, start.y) ||
      !almostEqual(row.robotStartHeadingDegrees, cell.config.robotStartHeadingDegrees ?? 0) ||
      !almostEqual(row.windDirectionDegrees, cell.config.windDirectionDegrees) ||
      row.physicsMode !== cell.config.physicsMode ||
      row.gridResolution !== cell.config.gridResolution ||
      !almostEqual(
        row.physicsStepSeconds,
        cell.config.physicsStepSeconds ?? DEFAULT_PHYSICS_STEP_SECONDS,
      ) ||
      (effectivePhysicsStep === null
        ? row.effectivePhysicsStepSeconds !== null
        : row.effectivePhysicsStepSeconds === null ||
          !almostEqual(row.effectivePhysicsStepSeconds, effectivePhysicsStep)) ||
      !almostEqual(row.quadChannelNoiseCorrelation, cell.config.quadChannelNoiseCorrelation) ||
      !almostEqual(row.quadChannelGainMismatch, cell.config.quadChannelGainMismatch) ||
      !almostEqual(row.quadChannelCrossTalk, cell.config.quadChannelCrossTalk) ||
      !almostEqual(row.quadChannelLagMismatch, cell.config.quadChannelLagMismatch)
    ) {
      throw new Error(`${cell.id}/${row.methodArm}: seed, placement, or physics mismatch`)
    }
    const key = `${cell.id}|${row.methodArm}|${row.checkpointSeconds}`
    if (seen.has(key)) throw new Error(`Duplicate raw result row ${key}`)
    seen.add(key)
  }
  if (seen.size !== expectedRows) throw new Error('Raw result matrix is incomplete')
}

const RUNTIME_SCHEMA_VERSION = 'headless-runtime-v1'

const optionalText = async (path: string) => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const expectedRunContext = async (
  profile: ProfileName,
  outputDirectory: string,
): Promise<PreparedHeadlessBenchmark> => {
  const implementationProvenance = await getImplementationProvenance()
  const implementationSha256 = implementationProvenance.implementationSha256
  const manifest: BenchmarkManifest = {
    ...createManifest(profile),
    implementationSha256,
  }
  const runtime = getRuntimeProvenance()
  return {
    manifest,
    manifestSha256: digest(manifest),
    implementationSha256,
    implementationProvenance,
    runtime,
    runtimeFingerprint: runtimeProvenanceFingerprint(runtime),
    outputDirectory,
    plannedSimulationRuns: manifest.cells.length * manifest.arms.length,
  }
}

const assertRecordedContext = async (context: PreparedHeadlessBenchmark) => {
  const manifestPath = join(context.outputDirectory, 'manifest.json')
  const runtimePath = join(context.outputDirectory, 'runtime.json')
  const implementationPath = join(context.outputDirectory, 'implementation.json')
  const manifestText = await optionalText(manifestPath)
  const runtimeText = await optionalText(runtimePath)
  const implementationText = await optionalText(implementationPath)
  if (!manifestText || !runtimeText || !implementationText) {
    throw new Error(
      'Benchmark output is missing manifest.json, runtime.json, or implementation.json and cannot be resumed',
    )
  }
  const recordedManifest = JSON.parse(manifestText) as BenchmarkManifest & {
    manifestSha256?: string
  }
  const { manifestSha256: recordedManifestSha256, ...manifest } = recordedManifest
  if (
    recordedManifestSha256 !== context.manifestSha256 ||
    digest(manifest) !== context.manifestSha256 ||
    stableJson(manifest) !== stableJson(context.manifest)
  ) {
    throw new Error('Recorded benchmark manifest does not match the current source snapshot')
  }
  const recordedRuntime = JSON.parse(runtimeText) as {
    schemaVersion?: string
    runtime?: RuntimeProvenance
    runtimeFingerprint?: string
  }
  if (
    recordedRuntime.schemaVersion !== RUNTIME_SCHEMA_VERSION ||
    !recordedRuntime.runtime ||
    recordedRuntime.runtimeFingerprint !== context.runtimeFingerprint ||
    runtimeProvenanceFingerprint(recordedRuntime.runtime) !== context.runtimeFingerprint ||
    stableJson(recordedRuntime.runtime) !== stableJson(context.runtime)
  ) {
    throw new Error('Recorded runtime differs from this worker; cross-runtime resume is prohibited')
  }
  const recordedImplementation = JSON.parse(implementationText) as ImplementationProvenance
  if (
    recordedImplementation.implementationSha256 !== context.implementationSha256 ||
    stableJson(recordedImplementation) !== stableJson(context.implementationProvenance)
  ) {
    throw new Error('Recorded implementation inventory differs from the current source snapshot')
  }
}

export const prepareHeadlessBenchmark = async ({
  profile,
  outputDirectory,
  resume = false,
}: RunnerOptions & { resume?: boolean }): Promise<PreparedHeadlessBenchmark> => {
  const context = await expectedRunContext(profile, outputDirectory)
  await mkdir(outputDirectory, { recursive: true })
  const manifestPath = join(outputDirectory, 'manifest.json')
  const runtimePath = join(outputDirectory, 'runtime.json')
  const implementationPath = join(outputDirectory, 'implementation.json')
  const manifestText = await optionalText(manifestPath)
  const runtimeText = await optionalText(runtimePath)
  const implementationText = await optionalText(implementationPath)

  if (manifestText || runtimeText || implementationText) {
    if (!resume) {
      throw new Error('Output already contains a benchmark; pass --resume to reuse verified cells')
    }
    await assertRecordedContext(context)
  } else {
    const unrelatedEntries = (await readdir(outputDirectory))
      .filter((entry) => entry !== '.plumenav-coordinator.lock')
    if (unrelatedEntries.length > 0) {
      throw new Error(`Refusing to initialize a non-empty output directory: ${unrelatedEntries.join(', ')}`)
    }
    await atomicWrite(manifestPath, stableJson({
      ...context.manifest,
      manifestSha256: context.manifestSha256,
    }))
    await atomicWrite(runtimePath, stableJson({
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      runtime: context.runtime,
      runtimeFingerprint: context.runtimeFingerprint,
    }))
    await atomicWrite(implementationPath, stableJson(context.implementationProvenance))
  }
  await mkdir(join(outputDirectory, 'cells'), { recursive: true })
  return context
}

export const loadPreparedHeadlessBenchmark = async (
  profile: ProfileName,
  outputDirectory: string,
) => {
  const context = await expectedRunContext(profile, outputDirectory)
  await assertRecordedContext(context)
  return context
}

const expectedRowKeys = (cell: ManifestCell, arms: readonly BenchmarkArm[]) =>
  arms.flatMap((arm) => cell.config.checkpointSeconds.map(
    (checkpoint) => `${cell.id}|${arm.id}|${checkpoint}`,
  ))

const verifiedCompletedCell = async (
  context: PreparedHeadlessBenchmark,
  cell: ManifestCell,
) => {
  const cellsDirectory = join(context.outputDirectory, 'cells')
  const csvPath = join(cellsDirectory, `${cell.id}.csv`)
  const metadataPath = join(cellsDirectory, `${cell.id}.json`)
  try {
    const csv = await readFile(csvPath, 'utf8')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Partial<CellCompletionMetadata>
    const expectedRows = context.manifest.arms.length * cell.config.checkpointSeconds.length
    if (
      metadata.schemaVersion !== BENCHMARK_SCHEMA_VERSION ||
      metadata.complete !== true ||
      metadata.manifestSha256 !== context.manifestSha256 ||
      metadata.implementationSha256 !== context.implementationSha256 ||
      metadata.runtimeFingerprint !== context.runtimeFingerprint ||
      metadata.cellId !== cell.id ||
      metadata.cellFingerprint !== headlessCellFingerprint(cell, context.manifest.arms) ||
      metadata.rawRows !== expectedRows ||
      stableJson(metadata.methodArms) !== stableJson(context.manifest.arms.map((arm) => arm.id)) ||
      metadata.artifactSha256 !== sha256(csv) ||
      metadata.scientificSha256 !== scientificCsvSha256(csv)
    ) return false

    const lines = csv.trimEnd().split(/\r?\n/)
    if (lines[0] !== csvHeader() || lines.length - 1 !== expectedRows) return false
    const parsedRows = parseHeadlessResultsCsv(csv)
    validateRowsAgainstManifest(
      parsedRows,
      { ...context.manifest, cells: [cell] },
      context.manifestSha256,
    )
    const actualKeys = parsedRows.map(
      (row) => `${row.scenarioId}|${row.methodArm}|${row.checkpointSeconds}`,
    )
    if (stableJson(actualKeys) !== stableJson(expectedRowKeys(cell, context.manifest.arms))) return false

    const header = lines[0].split(',')
    const indexes = new Map(header.map((column, index) => [column, index]))
    const valueAt = (values: string[], column: string) => {
      const index = indexes.get(column)
      return index === undefined ? undefined : values[index]
    }
    for (let rowIndex = 0; rowIndex < parsedRows.length; rowIndex += 1) {
      const parsed = parsedRows[rowIndex]!
      const arm = context.manifest.arms.find((candidate) => candidate.id === parsed.methodArm)
      if (!arm) return false
      const values = lines[rowIndex + 1]!.split(',')
      const runConfig: SimulationConfig = { ...cell.config, ...arm.configOverrides }
      const numericConfig: Array<[string, number]> = [
        ['obstacle_complexity_level', cell.scenarioKind === 'obstructed'
          ? runConfig.obstacleComplexityLevel
          : 0],
        ['terrain_slope_deg', runConfig.terrainSlopeDegrees],
        ['terrain_uphill_direction_deg', runConfig.terrainUphillDirectionDegrees],
        ['terrain_gas_drift_scale', runConfig.terrainGasDriftScale],
        ['robot_reference_grade_deg', runConfig.robotSlopeLimitDegrees],
        ['domain_side_m', runConfig.domainMeters],
        ['duration_s', runConfig.durationSeconds],
        ['stop_on_native_declaration', runConfig.stopOnNativeDeclaration ? 1 : 0],
        ['fixed_dt_s', runConfig.fixedDt],
        ['physics_step_s', runConfig.physicsStepSeconds ?? DEFAULT_PHYSICS_STEP_SECONDS],
        ['robot_speed_normalized_s', runConfig.robotSpeed],
        ['sensor_noise', runConfig.sensorNoise],
        ['sensor_lag_s', runConfig.sensorLag],
        ['sensor_threshold_scale', runConfig.sensorThresholdScale],
        ['sensor_saturation', runConfig.sensorSaturation],
        ['sensor_false_positive_rate', runConfig.sensorFalsePositiveRate],
        ['sensor_false_negative_rate', runConfig.sensorFalseNegativeRate],
        ['quad_channel_noise_correlation', runConfig.quadChannelNoiseCorrelation],
        ['quad_channel_gain_mismatch', runConfig.quadChannelGainMismatch],
        ['quad_channel_crosstalk', runConfig.quadChannelCrossTalk],
        ['quad_channel_lag_mismatch', runConfig.quadChannelLagMismatch],
        ['wind_noise_rad', runConfig.windNoise],
        ['active_sniff_enabled', runConfig.activeSniffEnabled ? 1 : 0],
        ['active_sniff_strength', runConfig.activeSniffStrength],
        ['active_sniff_reach_normalized', runConfig.activeSniffReach],
        ['active_sniff_cycle_s', runConfig.activeSniffCycleSeconds],
        ['grid_resolution', runConfig.gridResolution],
        ['wind_direction_toward_deg', runConfig.windDirectionDegrees],
        ['wind_speed_scale', runConfig.windSpeedScale],
        ['turbulence_scale', runConfig.turbulenceScale],
        ['gust_fraction_of_mean', runConfig.gustStrength],
        ['diffusivity_scale', runConfig.diffusivityScale],
        ['source_emission_rate_scale', runConfig.emissionRateScale],
        ['effective_source_emission_rate_scale', runConfig.targetStatus === 'emitting'
          ? runConfig.emissionRateScale
          : 0],
        ['success_threshold_normalized', runConfig.successThreshold],
      ]
      if (
        valueAt(values, 'algorithm') !== arm.algorithmId ||
        valueAt(values, 'target_status') !== runConfig.targetStatus ||
        valueAt(values, 'physics_mode') !== runConfig.physicsMode ||
        valueAt(values, 'gas_buoyancy_class') !== runConfig.gasBuoyancy ||
        valueAt(values, 'placement_overridden') !== '1' ||
        numericConfig.some(([column, expected]) => {
          const value = valueAt(values, column)
          return value === undefined || value === '' || !almostEqual(Number(value), expected)
        })
      ) return false
    }
    return true
  } catch {
    return false
  }
}

export const executeHeadlessBenchmarkShard = async ({
  profile,
  outputDirectory,
  shardIndex,
  shardCount,
  onProgress,
}: RunnerOptions & {
  shardIndex: number
  shardCount: number
  onProgress?: (event: { cellId: string; status: 'completed' | 'skipped' }) => void
}): Promise<HeadlessShardResult> => {
  const context = await loadPreparedHeadlessBenchmark(profile, outputDirectory)
  const assigned = selectManifestShard(context.manifest.cells, shardIndex, shardCount)
  let completedCells = 0
  let skippedCells = 0
  for (const cell of assigned) {
    if (await verifiedCompletedCell(context, cell)) {
      skippedCells += 1
      onProgress?.({ cellId: cell.id, status: 'skipped' })
      continue
    }
    const results = await runCell(cell, context.manifest.arms)
    const csv = rawCsvForCell(cell, results, context.manifestSha256)
    const parsedRows = parseHeadlessResultsCsv(csv)
    validateRowsAgainstManifest(
      parsedRows,
      { ...context.manifest, cells: [cell] },
      context.manifestSha256,
    )
    const expectedKeys = expectedRowKeys(cell, context.manifest.arms)
    const actualKeys = parsedRows.map(
      (row) => `${row.scenarioId}|${row.methodArm}|${row.checkpointSeconds}`,
    )
    if (stableJson(actualKeys) !== stableJson(expectedKeys)) {
      throw new Error(`${cell.id}: runner produced a non-canonical arm/checkpoint sequence`)
    }
    const cellsDirectory = join(outputDirectory, 'cells')
    await atomicWrite(join(cellsDirectory, `${cell.id}.csv`), csv)
    const metadata: CellCompletionMetadata = {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      manifestSha256: context.manifestSha256,
      implementationSha256: context.implementationSha256,
      runtimeFingerprint: context.runtimeFingerprint,
      cellId: cell.id,
      cellFingerprint: headlessCellFingerprint(cell, context.manifest.arms),
      complete: true,
      methodArms: context.manifest.arms.map((arm) => arm.id),
      rawRows: results.length,
      artifactSha256: sha256(csv),
      scientificSha256: scientificCsvSha256(csv),
    }
    await atomicWrite(join(cellsDirectory, `${cell.id}.json`), stableJson(metadata))
    completedCells += 1
    onProgress?.({ cellId: cell.id, status: 'completed' })
  }
  return {
    shardIndex,
    shardCount,
    assignedCells: assigned.length,
    completedCells,
    skippedCells,
  }
}

export const finalizeHeadlessBenchmark = async (
  profile: ProfileName,
  outputDirectory: string,
  signal?: AbortSignal,
) => {
  const throwIfAborted = () => {
    if (!signal?.aborted) return
    throw signal.reason instanceof Error ? signal.reason : new Error('Finalization aborted')
  }
  throwIfAborted()
  const context = await loadPreparedHeadlessBenchmark(profile, outputDirectory)
  const cellCsv: string[] = []
  for (const cell of context.manifest.cells) {
    throwIfAborted()
    if (!(await verifiedCompletedCell(context, cell))) {
      throw new Error(`${cell.id}: missing or invalid completion artifact; refusing partial finalization`)
    }
    cellCsv.push(await readFile(join(outputDirectory, 'cells', `${cell.id}.csv`), 'utf8'))
  }
  const rawRows = cellCsv.flatMap((csv) => csv.trimEnd().split(/\r?\n/).slice(1))
  const combinedCsv = `${csvHeader()}\n${rawRows.join('\n')}\n`
  const parsedRows = parseHeadlessResultsCsv(combinedCsv)
  validateRowsAgainstManifest(parsedRows, context.manifest, context.manifestSha256)
  const analysisPartitions = analysisPartitionsForProfile(profile)
  const analysis = analyzeHeadlessRows(parsedRows, { includePartitions: analysisPartitions })
  const analysisJson = stableJson(analysis)
  const comparisonsCsv = headlessAnalysisToCsv(analysis)
  const rawResultsSha256 = sha256(combinedCsv)
  const scientificResultsSha256 = scientificCsvSha256(combinedCsv)
  const analysisSha256 = sha256(analysisJson)
  const comparisonsSha256 = sha256(comparisonsCsv)

  throwIfAborted()
  await atomicWrite(join(outputDirectory, 'raw-results.csv'), combinedCsv)
  throwIfAborted()
  await atomicWrite(join(outputDirectory, 'analysis.json'), analysisJson)
  throwIfAborted()
  await atomicWrite(join(outputDirectory, 'comparisons.csv'), comparisonsCsv)
  const metadataJson = stableJson({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    manifestSha256: context.manifestSha256,
    implementationSha256: context.implementationSha256,
    runtimeFingerprint: context.runtimeFingerprint,
    profile,
    complete: true,
    plannedSimulationRuns: context.plannedSimulationRuns,
    rawResultRows: rawRows.length,
    rawResultsSha256,
    scientificProjectionSchemaVersion: SCIENTIFIC_PROJECTION_SCHEMA_VERSION,
    scientificResultsSha256,
    timingBoundary:
      'mean_compute_ms and p95_compute_ms are execution timings excluded from scientific equivalence and must not be pooled across worker counts',
    analysisPartitions,
    inferentialPartition:
      profile === 'commissioning' || profile === 'm5-development' ? null : 'test',
    claimBoundary: profile === 'commissioning'
      ? 'runtime-and-workflow-commissioning-only; no validation or test layouts are present'
      : profile === 'm5-development'
        ? 'development-only controller diagnostic; exploratory estimates only; no validation, test, superiority, or deployment inference'
        : 'development benchmark; nominal test inference is not an operational holdout without an external freeze/unlock gate',
    mergeOrder: 'manifest cell, manifest arm, manifest checkpoint',
    outputFiles: [
      'manifest.json',
      'runtime.json',
      'implementation.json',
      'metadata.json',
      'checksums.json',
      'raw-results.csv',
      'analysis.json',
      'comparisons.csv',
      'cells/',
      'executions/',
    ],
  })
  throwIfAborted()
  await atomicWrite(join(outputDirectory, 'metadata.json'), metadataJson)
  const coreArtifactInventory: Array<{ path: string; bytes: number; sha256: string }> = []
  const addCoreArtifact = (path: string, contents: string) => {
    coreArtifactInventory.push({
      path,
      bytes: Buffer.byteLength(contents),
      sha256: sha256(contents),
    })
  }
  addCoreArtifact('manifest.json', await readFile(join(outputDirectory, 'manifest.json'), 'utf8'))
  addCoreArtifact('runtime.json', await readFile(join(outputDirectory, 'runtime.json'), 'utf8'))
  addCoreArtifact(
    'implementation.json',
    await readFile(join(outputDirectory, 'implementation.json'), 'utf8'),
  )
  addCoreArtifact('metadata.json', metadataJson)
  addCoreArtifact('raw-results.csv', combinedCsv)
  addCoreArtifact('analysis.json', analysisJson)
  addCoreArtifact('comparisons.csv', comparisonsCsv)
  for (let index = 0; index < context.manifest.cells.length; index += 1) {
    throwIfAborted()
    const cell = context.manifest.cells[index]!
    addCoreArtifact(`cells/${cell.id}.csv`, cellCsv[index]!)
    addCoreArtifact(
      `cells/${cell.id}.json`,
      await readFile(join(outputDirectory, 'cells', `${cell.id}.json`), 'utf8'),
    )
  }
  throwIfAborted()
  await atomicWrite(join(outputDirectory, 'checksums.json'), stableJson({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    manifestSha256: context.manifestSha256,
    rawResultsSha256,
    scientificResultsSha256,
    analysisSha256,
    comparisonsSha256,
    metadataSha256: sha256(metadataJson),
    coreArtifactInventory,
    coreArtifactInventorySha256: digest(coreArtifactInventory),
    inventoryBoundary:
      'deterministic scientific core only; append-only executions/ records are inventoried when a campaign is frozen',
  }))
  return {
    ...context,
    rawResultRows: rawRows.length,
    rawResultsSha256,
    scientificResultsSha256,
    analysisSha256,
    comparisonsSha256,
  }
}

/**
 * Backwards-compatible design-only API used by the existing opt-in Vitest
 * command. Cell execution is deliberately centralized in the locking local
 * coordinator so two public entry points cannot write the same directory.
 */
export const runHeadlessBenchmark = async ({
  profile,
  outputDirectory,
  dryRun = false,
}: RunnerOptions) => {
  if (!dryRun) {
    throw new Error(
      'Direct benchmark execution is disabled; use pnpm benchmark:local so coordinator locking and execution provenance are enforced',
    )
  }
  const context = await prepareHeadlessBenchmark({
    profile,
    outputDirectory,
    resume: true,
  })
  return {
    manifest: context.manifest,
    manifestSha256: context.manifestSha256,
    plannedSimulationRuns: context.plannedSimulationRuns,
    completedCells: 0,
    skippedCells: 0,
    dryRun: true,
  }
}
