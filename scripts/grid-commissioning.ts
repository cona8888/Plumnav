/**
 * Isolated 96² runtime-only commissioning design and resumable cell runner.
 * It has no validation/test layouts and is not the frozen Phase 2 campaign.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { batchResultsToCsv, runBatch } from '../src/sim/batch'
import { DEFAULT_PHYSICS_STEP_SECONDS, validateSimulationConfig } from '../src/sim/config'
import { CONTROLLER_OBSERVATION_MODEL_VERSION } from '../src/sim/controllerObservationModel'
import { GridPlume } from '../src/sim/gridPlume'
import {
  createBalancedResearchScenarios,
  validateResearchScenario,
  type OrientationBin,
} from '../src/sim/research/scenarioAblations'
import { createScenario } from '../src/sim/scenarios'
import type { AlgorithmId, BatchResult, ScenarioKind, SimulationConfig } from '../src/sim/types'

export const GRID_COMMISSIONING_SCHEMA_VERSION = 'local-grid-commissioning-v1'
export const GRID_COMMISSIONING_PROJECTION_VERSION = 'local-grid-scientific-projection-v1'
export const GRID_COMMISSIONING_DURATION_SECONDS = 30
export const GRID_COMMISSIONING_RESOLUTION = 96
export const GRID_COMMISSIONING_REQUESTED_STEP_SECONDS = 0.0125
export const GRID_COMMISSIONING_EXPERIMENT_SEED = 960_125

export type GridCommissioningArm = {
  id: 'coverage' | 'infotaxis' | 'quad-active'
  algorithmId: AlgorithmId
  configOverrides: Partial<SimulationConfig>
}

export const GRID_COMMISSIONING_ARMS: readonly GridCommissioningArm[] = [
  { id: 'coverage', algorithmId: 'coverage', configOverrides: {} },
  { id: 'infotaxis', algorithmId: 'infotaxis', configOverrides: {} },
  {
    id: 'quad-active',
    algorithmId: 'quad-sniff',
    configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0.78 },
  },
]

export type GridCommissioningCell = {
  id: string
  armId: GridCommissioningArm['id']
  pairingKey: string
  partition: 'development'
  scenarioKind: ScenarioKind
  orientationBin: OrientationBin
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
    resolution: 96
    requestedStepSeconds: 0.0125
    effectiveStepSeconds: number
  }
}

export type GridCommissioningManifest = {
  schemaVersion: typeof GRID_COMMISSIONING_SCHEMA_VERSION
  partition: 'development'
  purpose: 'local CPU throughput, memory, resume, and deterministic-equivalence commissioning only'
  claimBoundary: 'runtime/workflow evidence only; no algorithm ranking, validation, test, or Phase 2 outcome'
  experimentSeed: typeof GRID_COMMISSIONING_EXPERIMENT_SEED
  design: {
    cells: 12
    layouts: 4
    arms: 3
    durationSeconds: 30
    resolution: 96
    requestedPhysicsStepSeconds: 0.0125
  }
  arms: readonly GridCommissioningArm[]
  observationModelVersion: typeof CONTROLLER_OBSERVATION_MODEL_VERSION
  cells: GridCommissioningCell[]
  implementationSha256?: string
}

export type GridRuntimeProvenance = {
  node: string
  v8: string
  platform: string
  architecture: string
  osRelease: string
  cpuModel: string
}

export type GridImplementationProvenance = {
  schemaVersion: 'local-grid-implementation-v1'
  files: Array<{ path: string; bytes: number; sha256: string }>
  implementationSha256: string
}

export type PreparedGridCommissioning = {
  manifest: GridCommissioningManifest
  manifestSha256: string
  implementationSha256: string
  implementationProvenance: GridImplementationProvenance
  runtime: GridRuntimeProvenance
  runtimeFingerprint: string
  outputDirectory: string
}

export type GridShardResult = {
  shardIndex: number
  shardCount: number
  assignedCells: number
  completedCells: number
  skippedCells: number
}

type CellCompletion = {
  schemaVersion: typeof GRID_COMMISSIONING_SCHEMA_VERSION
  complete: true
  manifestSha256: string
  implementationSha256: string
  runtimeFingerprint: string
  cellId: string
  cellFingerprint: string
  artifactSha256: string
  scientificSha256: string
  rawRows: 1
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
const sha256Text = (value: string) => createHash('sha256').update(value).digest('hex')
export const gridCommissioningSha256 = (value: unknown) => sha256Text(stableJson(value))

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

const copyConfig = (config: SimulationConfig): SimulationConfig => ({
  ...config,
  checkpointSeconds: [...config.checkpointSeconds],
  sourcePositionOverride: config.sourcePositionOverride && { ...config.sourcePositionOverride },
  robotStartPositionOverride: config.robotStartPositionOverride && { ...config.robotStartPositionOverride },
})

export const createGridCommissioningManifest = (): GridCommissioningManifest => {
  const candidates = createBalancedResearchScenarios({
    experimentSeed: GRID_COMMISSIONING_EXPERIMENT_SEED,
    replicatesPerOrientation: 1,
    scenarioKinds: ['open', 'obstructed'],
  })
  const requested = new Set([
    'open|downwind',
    'open|upwind',
    'obstructed|crosswind-left',
    'obstructed|crosswind-right',
  ])
  const layouts = candidates.filter(
    (layout) => requested.has(`${layout.scenarioKind}|${layout.orientationBin}`),
  )
  if (layouts.length !== 4) throw new Error(`Expected four grid commissioning layouts, found ${layouts.length}`)

  const generatedCells: GridCommissioningCell[] = []
  for (const arm of GRID_COMMISSIONING_ARMS) {
    for (const layout of layouts) {
      const validation = validateResearchScenario(layout)
      if (!validation.valid) throw new Error(`${layout.id}: ${validation.errors.join('; ')}`)
      const config = {
        ...copyConfig(layout.config),
        ...arm.configOverrides,
        algorithmId: arm.algorithmId,
        durationSeconds: GRID_COMMISSIONING_DURATION_SECONDS,
        checkpointSeconds: [GRID_COMMISSIONING_DURATION_SECONDS],
        physicsMode: 'grid',
        gridResolution: GRID_COMMISSIONING_RESOLUTION,
        physicsStepSeconds: GRID_COMMISSIONING_REQUESTED_STEP_SECONDS,
        stopOnNativeDeclaration: false,
      } satisfies SimulationConfig
      validateSimulationConfig(config)
      const scenario = createScenario(layout.scenarioKind, config.seed, config)
      const plume = new GridPlume(scenario, config.seed, {
        resolution: config.gridResolution,
        stepSeconds: config.physicsStepSeconds,
      })
      if (plume.stepSeconds !== GRID_COMMISSIONING_REQUESTED_STEP_SECONDS) {
        throw new Error(`${layout.id}: effective grid step ${plume.stepSeconds} is not 0.0125 s`)
      }
      generatedCells.push({
        id: `${arm.id}-${layout.id}`,
        armId: arm.id,
        pairingKey: layout.id,
        partition: 'development',
        scenarioKind: layout.scenarioKind,
        orientationBin: layout.orientationBin,
        seedPartition: { ...layout.seedPartition },
        observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
        config,
        physics: {
          mode: 'grid',
          resolution: GRID_COMMISSIONING_RESOLUTION,
          requestedStepSeconds: GRID_COMMISSIONING_REQUESTED_STEP_SECONDS,
          effectiveStepSeconds: plume.stepSeconds,
        },
      })
    }
  }
  // Freeze an order that balances open/obstructed work for modulo 1/2/4/6
  // assignment while retaining a single canonical merge order.
  const byDesignKey = new Map(generatedCells.map((cell) => [
    `${cell.armId}|${cell.scenarioKind}|${cell.orientationBin}`,
    cell,
  ]))
  const order = [
    'coverage|open|downwind',
    'coverage|obstructed|crosswind-left',
    'infotaxis|open|upwind',
    'infotaxis|obstructed|crosswind-right',
    'quad-active|open|downwind',
    'quad-active|obstructed|crosswind-left',
    'infotaxis|obstructed|crosswind-left',
    'infotaxis|open|downwind',
    'coverage|obstructed|crosswind-right',
    'coverage|open|upwind',
    'quad-active|obstructed|crosswind-right',
    'quad-active|open|upwind',
  ]
  const cells = order.map((key) => {
    const cell = byDesignKey.get(key)
    if (!cell) throw new Error(`Missing grid commissioning design cell ${key}`)
    return cell
  })
  return {
    schemaVersion: GRID_COMMISSIONING_SCHEMA_VERSION,
    partition: 'development',
    purpose: 'local CPU throughput, memory, resume, and deterministic-equivalence commissioning only',
    claimBoundary: 'runtime/workflow evidence only; no algorithm ranking, validation, test, or Phase 2 outcome',
    experimentSeed: GRID_COMMISSIONING_EXPERIMENT_SEED,
    design: {
      cells: 12,
      layouts: 4,
      arms: 3,
      durationSeconds: GRID_COMMISSIONING_DURATION_SECONDS,
      resolution: GRID_COMMISSIONING_RESOLUTION,
      requestedPhysicsStepSeconds: GRID_COMMISSIONING_REQUESTED_STEP_SECONDS,
    },
    arms: GRID_COMMISSIONING_ARMS.map((arm) => ({
      ...arm,
      configOverrides: { ...arm.configOverrides },
    })),
    observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
    cells,
  }
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const implementationFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? implementationFiles(path) : [path]
  }))
  return nested.flat()
}

export const getGridImplementationProvenance = async (): Promise<GridImplementationProvenance> => {
  const paths = [
    ...(await implementationFiles(join(projectRoot, 'src', 'sim'))),
    join(projectRoot, 'scripts', 'grid-commissioning.ts'),
    join(projectRoot, 'scripts', 'local-grid-commissioning.ts'),
    join(projectRoot, 'package.json'),
    join(projectRoot, 'pnpm-lock.yaml'),
    join(projectRoot, 'pnpm-workspace.yaml'),
    join(projectRoot, 'tsconfig.json'),
    join(projectRoot, 'tsconfig.app.json'),
    join(projectRoot, 'tsconfig.node.json'),
    join(projectRoot, 'vite.config.ts'),
  ].sort()
  const combined = createHash('sha256')
  const files: GridImplementationProvenance['files'] = []
  for (const path of paths) {
    const contents = await readFile(path)
    const relativePath = path.slice(projectRoot.length)
    combined.update(relativePath)
    combined.update('\0')
    combined.update(contents)
    combined.update('\0')
    files.push({
      path: relativePath,
      bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    })
  }
  return {
    schemaVersion: 'local-grid-implementation-v1',
    files,
    implementationSha256: combined.digest('hex'),
  }
}

export const getGridRuntimeProvenance = (): GridRuntimeProvenance => ({
  node: process.versions.node,
  v8: process.versions.v8,
  platform: platform(),
  architecture: arch(),
  osRelease: release(),
  cpuModel: cpus()[0]?.model ?? 'unknown',
})

const runtimeFingerprint = (runtime: GridRuntimeProvenance) => gridCommissioningSha256(runtime)

export const gridScientificProjection = (csv: string) => {
  const lines = csv.trimEnd().split(/\r?\n/)
  const header = lines[0]?.split(',') ?? []
  if (new Set(header).size !== header.length) throw new Error('CSV header contains duplicate columns')
  const excluded = new Set(['mean_compute_ms', 'p95_compute_ms'])
  for (const column of excluded) {
    if (!header.includes(column)) throw new Error(`Missing execution-timing column ${column}`)
  }
  const included = header
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !excluded.has(column))
  const rows = lines.slice(1).filter(Boolean).map((line, rowIndex) => {
    const values = line.split(',')
    if (values.length !== header.length) {
      throw new Error(`CSV row ${rowIndex + 2} has ${values.length} fields; expected ${header.length}`)
    }
    return included.map(({ index }) => values[index] ?? '')
  })
  return stableJson({
    schemaVersion: GRID_COMMISSIONING_PROJECTION_VERSION,
    columns: included.map(({ column }) => column),
    rows,
  })
}

export const gridScientificSha256 = (csv: string) => sha256Text(gridScientificProjection(csv))

export const selectGridShard = <T>(cells: readonly T[], shardIndex: number, shardCount: number) => {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new RangeError('shardCount must be positive')
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new RangeError(`shardIndex ${shardIndex} is outside [0, ${shardCount})`)
  }
  return cells.filter((_, index) => index % shardCount === shardIndex)
}

export const gridCellFingerprint = (cell: GridCommissioningCell) =>
  gridCommissioningSha256({ schemaVersion: GRID_COMMISSIONING_SCHEMA_VERSION, cell })

const optionalText = async (path: string) => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const expectedContext = async (
  outputDirectory: string,
): Promise<PreparedGridCommissioning> => {
  const implementationProvenance = await getGridImplementationProvenance()
  const manifest: GridCommissioningManifest = {
    ...createGridCommissioningManifest(),
    implementationSha256: implementationProvenance.implementationSha256,
  }
  const runtime = getGridRuntimeProvenance()
  return {
    manifest,
    manifestSha256: gridCommissioningSha256(manifest),
    implementationSha256: implementationProvenance.implementationSha256,
    implementationProvenance,
    runtime,
    runtimeFingerprint: runtimeFingerprint(runtime),
    outputDirectory,
  }
}

const assertRecordedContext = async (context: PreparedGridCommissioning) => {
  const manifestText = await optionalText(join(context.outputDirectory, 'manifest.json'))
  const runtimeText = await optionalText(join(context.outputDirectory, 'runtime.json'))
  const implementationText = await optionalText(join(context.outputDirectory, 'implementation.json'))
  if (!manifestText || !runtimeText || !implementationText) {
    throw new Error('Grid output is missing manifest/runtime/implementation provenance')
  }
  const recordedManifest = JSON.parse(manifestText) as GridCommissioningManifest & {
    manifestSha256?: string
  }
  const { manifestSha256, ...manifest } = recordedManifest
  if (
    manifestSha256 !== context.manifestSha256 ||
    gridCommissioningSha256(manifest) !== context.manifestSha256 ||
    stableJson(manifest) !== stableJson(context.manifest)
  ) throw new Error('Recorded grid manifest differs from the current source snapshot')
  const recordedRuntime = JSON.parse(runtimeText) as {
    runtime?: GridRuntimeProvenance
    runtimeFingerprint?: string
  }
  if (
    !recordedRuntime.runtime ||
    recordedRuntime.runtimeFingerprint !== context.runtimeFingerprint ||
    stableJson(recordedRuntime.runtime) !== stableJson(context.runtime)
  ) throw new Error('Recorded grid runtime differs from this process')
  if (implementationText !== stableJson(context.implementationProvenance)) {
    throw new Error('Recorded grid implementation inventory differs from current source')
  }
}

export const prepareGridCommissioning = async (
  outputDirectory: string,
  resume = false,
) => {
  const context = await expectedContext(outputDirectory)
  await mkdir(outputDirectory, { recursive: true })
  const existing = await optionalText(join(outputDirectory, 'manifest.json'))
  if (existing) {
    if (!resume) throw new Error('Grid output already exists; pass --resume to reuse verified cells')
    await assertRecordedContext(context)
  } else {
    const unrelated = (await readdir(outputDirectory))
      .filter((entry) => entry !== '.plumenav-grid-coordinator.lock')
    if (unrelated.length > 0) throw new Error(`Refusing non-empty grid output: ${unrelated.join(', ')}`)
    await atomicWrite(join(outputDirectory, 'manifest.json'), stableJson({
      ...context.manifest,
      manifestSha256: context.manifestSha256,
    }))
    await atomicWrite(join(outputDirectory, 'runtime.json'), stableJson({
      schemaVersion: 'local-grid-runtime-v1',
      runtime: context.runtime,
      runtimeFingerprint: context.runtimeFingerprint,
    }))
    await atomicWrite(
      join(outputDirectory, 'implementation.json'),
      stableJson(context.implementationProvenance),
    )
  }
  await mkdir(join(outputDirectory, 'cells'), { recursive: true })
  return context
}

export const loadPreparedGridCommissioning = async (outputDirectory: string) => {
  const context = await expectedContext(outputDirectory)
  await assertRecordedContext(context)
  return context
}

const csvHeader = () =>
  `manifest_sha256,layout_id,cell_id,method_arm,${batchResultsToCsv([]).trimEnd()}`

const renderCellCsv = (
  cell: GridCommissioningCell,
  result: BatchResult,
  manifestSha256: string,
) => {
  const rendered = batchResultsToCsv([result]).split('\n')[1]
  if (!rendered) throw new Error(`${cell.id}: could not render result`)
  return `${csvHeader()}\n${manifestSha256},${cell.pairingKey},${cell.id},${cell.armId},${rendered}\n`
}

const almostEqual = (first: number, second: number) => Math.abs(first - second) <= 1e-12

const csvMatchesCell = (
  csv: string,
  cell: GridCommissioningCell,
  manifestSha256: string,
) => {
  const lines = csv.trimEnd().split(/\r?\n/)
  if (lines.length !== 2 || lines[0] !== csvHeader()) return false
  const header = lines[0]!.split(',')
  const values = lines[1]!.split(',')
  if (values.length !== header.length) return false
  const indexes = new Map(header.map((column, index) => [column, index]))
  const value = (column: string) => {
    const index = indexes.get(column)
    return index === undefined ? undefined : values[index]
  }
  const config = cell.config
  const numeric: Array<[string, number]> = [
    ['seed', config.seed],
    ['source_seed', config.sourceSeed],
    ['controller_seed', config.controllerSeed],
    ['controller_observation_model_seed', config.observationModelSeed],
    ['source_x_normalized', config.sourcePositionOverride!.x],
    ['source_y_normalized', config.sourcePositionOverride!.y],
    ['robot_start_x_normalized', config.robotStartPositionOverride!.x],
    ['robot_start_y_normalized', config.robotStartPositionOverride!.y],
    ['robot_start_heading_deg', config.robotStartHeadingDegrees ?? 0],
    ['obstacle_complexity_level', cell.scenarioKind === 'obstructed'
      ? config.obstacleComplexityLevel
      : 0],
    ['terrain_slope_deg', config.terrainSlopeDegrees],
    ['terrain_uphill_direction_deg', config.terrainUphillDirectionDegrees],
    ['terrain_gas_drift_scale', config.terrainGasDriftScale],
    ['robot_reference_grade_deg', config.robotSlopeLimitDegrees],
    ['checkpoint_s', GRID_COMMISSIONING_DURATION_SECONDS],
    ['domain_side_m', config.domainMeters],
    ['duration_s', config.durationSeconds],
    ['stop_on_native_declaration', config.stopOnNativeDeclaration ? 1 : 0],
    ['fixed_dt_s', config.fixedDt],
    ['physics_step_s', config.physicsStepSeconds ?? DEFAULT_PHYSICS_STEP_SECONDS],
    ['effective_physics_step_s', cell.physics.effectiveStepSeconds],
    ['robot_speed_normalized_s', config.robotSpeed],
    ['sensor_noise', config.sensorNoise],
    ['sensor_lag_s', config.sensorLag],
    ['sensor_threshold_scale', config.sensorThresholdScale],
    ['sensor_saturation', config.sensorSaturation],
    ['sensor_false_positive_rate', config.sensorFalsePositiveRate],
    ['sensor_false_negative_rate', config.sensorFalseNegativeRate],
    ['quad_channel_noise_correlation', config.quadChannelNoiseCorrelation],
    ['quad_channel_gain_mismatch', config.quadChannelGainMismatch],
    ['quad_channel_crosstalk', config.quadChannelCrossTalk],
    ['quad_channel_lag_mismatch', config.quadChannelLagMismatch],
    ['wind_noise_rad', config.windNoise],
    ['active_sniff_enabled', config.activeSniffEnabled ? 1 : 0],
    ['active_sniff_strength', config.activeSniffStrength],
    ['active_sniff_reach_normalized', config.activeSniffReach],
    ['active_sniff_cycle_s', config.activeSniffCycleSeconds],
    ['grid_resolution', config.gridResolution],
    ['wind_direction_toward_deg', config.windDirectionDegrees],
    ['wind_speed_scale', config.windSpeedScale],
    ['turbulence_scale', config.turbulenceScale],
    ['gust_fraction_of_mean', config.gustStrength],
    ['diffusivity_scale', config.diffusivityScale],
    ['source_emission_rate_scale', config.emissionRateScale],
    ['effective_source_emission_rate_scale', config.emissionRateScale],
    ['success_threshold_normalized', config.successThreshold],
  ]
  return value('manifest_sha256') === manifestSha256 &&
    value('layout_id') === cell.pairingKey &&
    value('cell_id') === cell.id &&
    value('method_arm') === cell.armId &&
    value('algorithm') === config.algorithmId &&
    value('scenario') === cell.scenarioKind &&
    value('target_status') === 'emitting' &&
    value('controller_observation_model_version') === cell.observationModelVersion &&
    value('placement_overridden') === '1' &&
    value('gas_buoyancy_class') === config.gasBuoyancy &&
    value('physics_mode') === 'grid' &&
    numeric.every(([column, expected]) => {
      const actual = value(column)
      return actual !== undefined && actual !== '' && almostEqual(Number(actual), expected)
    })
}

const verifiedCell = async (
  context: PreparedGridCommissioning,
  cell: GridCommissioningCell,
) => {
  try {
    const csv = await readFile(join(context.outputDirectory, 'cells', `${cell.id}.csv`), 'utf8')
    const metadata = JSON.parse(
      await readFile(join(context.outputDirectory, 'cells', `${cell.id}.json`), 'utf8'),
    ) as Partial<CellCompletion>
    return metadata.schemaVersion === GRID_COMMISSIONING_SCHEMA_VERSION &&
      metadata.complete === true &&
      metadata.manifestSha256 === context.manifestSha256 &&
      metadata.implementationSha256 === context.implementationSha256 &&
      metadata.runtimeFingerprint === context.runtimeFingerprint &&
      metadata.cellId === cell.id &&
      metadata.cellFingerprint === gridCellFingerprint(cell) &&
      metadata.rawRows === 1 &&
      metadata.artifactSha256 === sha256Text(csv) &&
      metadata.scientificSha256 === gridScientificSha256(csv) &&
      csvMatchesCell(csv, cell, context.manifestSha256)
  } catch {
    return false
  }
}

const executeCell = async (cell: GridCommissioningCell) => {
  const config = copyConfig(cell.config)
  const batch = await runBatch(config, [config.algorithmId], [cell.scenarioKind], 1)
  if (batch.results.length !== 1) throw new Error(`${cell.id}: expected exactly one checkpoint result`)
  const result = batch.results[0]!
  if (
    result.algorithmId !== config.algorithmId ||
    result.scenarioKind !== cell.scenarioKind ||
    result.seed !== config.seed ||
    result.checkpointSeconds !== GRID_COMMISSIONING_DURATION_SECONDS ||
    result.observationModelVersion !== cell.observationModelVersion ||
    result.effectivePhysicsStepSeconds !== cell.physics.effectiveStepSeconds ||
    gridCommissioningSha256(result.config) !== gridCommissioningSha256(config)
  ) throw new Error(`${cell.id}: result does not match its frozen commissioning cell`)
  return result
}

export const executeGridCommissioningShard = async ({
  outputDirectory,
  shardIndex,
  shardCount,
  onProgress,
}: {
  outputDirectory: string
  shardIndex: number
  shardCount: number
  onProgress?: (event: { cellId: string; status: 'completed' | 'skipped' }) => void
}): Promise<GridShardResult> => {
  const context = await loadPreparedGridCommissioning(outputDirectory)
  const assigned = selectGridShard(context.manifest.cells, shardIndex, shardCount)
  let completedCells = 0
  let skippedCells = 0
  for (const cell of assigned) {
    if (await verifiedCell(context, cell)) {
      skippedCells += 1
      onProgress?.({ cellId: cell.id, status: 'skipped' })
      continue
    }
    const result = await executeCell(cell)
    const csv = renderCellCsv(cell, result, context.manifestSha256)
    if (!csvMatchesCell(csv, cell, context.manifestSha256)) {
      throw new Error(`${cell.id}: rendered CSV does not match the frozen cell`)
    }
    await atomicWrite(join(outputDirectory, 'cells', `${cell.id}.csv`), csv)
    const metadata: CellCompletion = {
      schemaVersion: GRID_COMMISSIONING_SCHEMA_VERSION,
      complete: true,
      manifestSha256: context.manifestSha256,
      implementationSha256: context.implementationSha256,
      runtimeFingerprint: context.runtimeFingerprint,
      cellId: cell.id,
      cellFingerprint: gridCellFingerprint(cell),
      artifactSha256: sha256Text(csv),
      scientificSha256: gridScientificSha256(csv),
      rawRows: 1,
    }
    await atomicWrite(join(outputDirectory, 'cells', `${cell.id}.json`), stableJson(metadata))
    completedCells += 1
    onProgress?.({ cellId: cell.id, status: 'completed' })
  }
  return { shardIndex, shardCount, assignedCells: assigned.length, completedCells, skippedCells }
}

export const finalizeGridCommissioning = async (
  outputDirectory: string,
  signal?: AbortSignal,
) => {
  const throwIfAborted = () => {
    if (signal?.aborted) throw signal.reason instanceof Error
      ? signal.reason
      : new Error('Grid finalization aborted')
  }
  const context = await loadPreparedGridCommissioning(outputDirectory)
  const cellCsv: string[] = []
  for (const cell of context.manifest.cells) {
    throwIfAborted()
    if (!(await verifiedCell(context, cell))) {
      throw new Error(`${cell.id}: invalid or missing grid completion; refusing partial finalization`)
    }
    cellCsv.push(await readFile(join(outputDirectory, 'cells', `${cell.id}.csv`), 'utf8'))
  }
  const rawRows = cellCsv.flatMap((csv) => csv.trimEnd().split(/\r?\n/).slice(1))
  const rawCsv = `${csvHeader()}\n${rawRows.join('\n')}\n`
  const rawResultsSha256 = sha256Text(rawCsv)
  const scientificResultsSha256 = gridScientificSha256(rawCsv)
  throwIfAborted()
  await atomicWrite(join(outputDirectory, 'raw-results.csv'), rawCsv)
  const metadataJson = stableJson({
    schemaVersion: GRID_COMMISSIONING_SCHEMA_VERSION,
    complete: true,
    manifestSha256: context.manifestSha256,
    implementationSha256: context.implementationSha256,
    runtimeFingerprint: context.runtimeFingerprint,
    plannedCells: context.manifest.cells.length,
    rawResultRows: rawRows.length,
    rawResultsSha256,
    scientificProjectionVersion: GRID_COMMISSIONING_PROJECTION_VERSION,
    scientificResultsSha256,
    mergeOrder: 'manifest cell order',
    claimBoundary: context.manifest.claimBoundary,
    timingBoundary: 'mean_compute_ms and p95_compute_ms are excluded only from scientific equivalence',
  })
  throwIfAborted()
  await atomicWrite(join(outputDirectory, 'metadata.json'), metadataJson)
  const inventory: Array<{ path: string; bytes: number; sha256: string }> = []
  const add = (path: string, contents: string) => inventory.push({
    path,
    bytes: Buffer.byteLength(contents),
    sha256: sha256Text(contents),
  })
  for (const path of ['manifest.json', 'runtime.json', 'implementation.json']) {
    add(path, await readFile(join(outputDirectory, path), 'utf8'))
  }
  add('metadata.json', metadataJson)
  add('raw-results.csv', rawCsv)
  for (let index = 0; index < context.manifest.cells.length; index += 1) {
    const cell = context.manifest.cells[index]!
    add(`cells/${cell.id}.csv`, cellCsv[index]!)
    add(`cells/${cell.id}.json`, await readFile(join(outputDirectory, 'cells', `${cell.id}.json`), 'utf8'))
  }
  throwIfAborted()
  await atomicWrite(join(outputDirectory, 'checksums.json'), stableJson({
    schemaVersion: GRID_COMMISSIONING_SCHEMA_VERSION,
    manifestSha256: context.manifestSha256,
    rawResultsSha256,
    scientificResultsSha256,
    coreArtifactInventory: inventory,
    coreArtifactInventorySha256: gridCommissioningSha256(inventory),
  }))
  return { ...context, rawResultsSha256, scientificResultsSha256, rawResultRows: rawRows.length }
}
