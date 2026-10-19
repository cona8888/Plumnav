/**
 * Resumable, sharded raw-artifact executor for the frozen M6 development
 * calibration. Each manifest cell is an atomic four-arm matched block.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { batchResultsToCsv, runBatch } from '../src/sim/batch'
import {
  createM6CalibrationManifest,
  M6_ARMS,
  m6CalibrationSha256,
  type M6Arm,
  type M6CalibrationCell,
  type M6CalibrationManifest,
} from './m6-calibration-manifest'
import type { BatchResult, SimulationConfig } from '../src/sim/types'

export const M6_SHARDED_SCHEMA_VERSION = 'm6-quad-calibration-sharded-v1'
const PROJECTION_VERSION = 'm6-quad-calibration-scientific-projection-v1'
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const frozenManifestPath = join(projectRoot, 'research', 'protocols', 'm6_quad_calibration', 'm6-calibration-manifest.json')

type RuntimeProvenance = {
  node: string
  v8: string
  platform: string
  architecture: string
  osRelease: string
  cpuModel: string
}
type ImplementationProvenance = {
  schemaVersion: 'm6-sharded-implementation-v1'
  files: Array<{ path: string; bytes: number; sha256: string }>
  implementationSha256: string
}
type Completion = {
  schemaVersion: typeof M6_SHARDED_SCHEMA_VERSION
  complete: true
  manifestSha256: string
  implementationSha256: string
  runtimeFingerprint: string
  cellId: string
  cellFingerprint: string
  artifactSha256: string
  scientificSha256: string
  rawRows: 4
}

export type M6PreparedCalibration = {
  manifest: M6CalibrationManifest
  manifestSha256: string
  implementationSha256: string
  implementation: ImplementationProvenance
  runtime: RuntimeProvenance
  runtimeFingerprint: string
  outputDirectory: string
}
export type M6ShardResult = {
  shardIndex: number
  shardCount: number
  assignedCells: number
  assignedRuns: number
  completedCells: number
  skippedCells: number
}
export type M6Progress = { cellId: string; status: 'completed' | 'skipped' }
export type M6CellExecution = (
  cell: M6CalibrationCell,
  arm: M6Arm,
  config: SimulationConfig,
) => Promise<BatchResult[]>

const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, item]) => [key, canonicalize(item)]))
    : value
const stableJson = (value: unknown) => `${JSON.stringify(canonicalize(value), null, 2)}\n`
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
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
const withoutDigest = (value: Record<string, unknown>) => {
  const { manifestSha256: _ignored, ...manifest } = value
  return manifest
}
const cloneConfig = (config: SimulationConfig): SimulationConfig => ({
  ...config,
  checkpointSeconds: [...config.checkpointSeconds],
  sourcePositionOverride: config.sourcePositionOverride && { ...config.sourcePositionOverride },
  robotStartPositionOverride: config.robotStartPositionOverride && { ...config.robotStartPositionOverride },
})

export const m6ArmConfig = (cell: M6CalibrationCell, arm: M6Arm): SimulationConfig => ({
  ...cloneConfig(cell.config),
  ...arm.configOverrides,
  algorithmId: arm.algorithmId,
})

export const selectM6Shard = <T>(cells: readonly T[], shardIndex: number, shardCount: number) => {
  if (!Number.isInteger(shardCount) || shardCount < 1 ||
      !Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new RangeError('Invalid M6 shard index/count')
  }
  return cells.filter((_, index) => index % shardCount === shardIndex)
}

const runtime = (): RuntimeProvenance => ({
  node: process.versions.node,
  v8: process.versions.v8,
  platform: platform(),
  architecture: arch(),
  osRelease: release(),
  cpuModel: cpus()[0]?.model ?? 'unknown',
})
const implementationFiles = async (directory: string): Promise<string[]> =>
  (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? implementationFiles(path) : [path]
  }))).flat()
const implementation = async (): Promise<ImplementationProvenance> => {
  const paths = [
    ...await implementationFiles(join(projectRoot, 'src', 'sim')),
    frozenManifestPath,
    join(projectRoot, 'scripts', 'm6-calibration-manifest.ts'),
    join(projectRoot, 'scripts', 'm6-sharded-calibration.ts'),
    join(projectRoot, 'scripts', 'local-m6-calibration.ts'),
    join(projectRoot, 'package.json'),
    join(projectRoot, 'pnpm-lock.yaml'),
    join(projectRoot, 'pnpm-workspace.yaml'),
    join(projectRoot, 'tsconfig.json'),
    join(projectRoot, 'tsconfig.app.json'),
    join(projectRoot, 'tsconfig.node.json'),
    join(projectRoot, 'vite.config.ts'),
  ].sort()
  const digest = createHash('sha256')
  const files: ImplementationProvenance['files'] = []
  for (const path of paths) {
    try {
      const bytes = await readFile(path)
      const relative = path.slice(projectRoot.length)
      digest.update(relative)
      digest.update('\0')
      digest.update(bytes)
      digest.update('\0')
      files.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return {
    schemaVersion: 'm6-sharded-implementation-v1',
    files,
    implementationSha256: digest.digest('hex'),
  }
}
const context = async (outputDirectory: string): Promise<M6PreparedCalibration> => {
  const manifest = createM6CalibrationManifest()
  const impl = await implementation()
  const runtimeRecord = runtime()
  return {
    manifest,
    manifestSha256: m6CalibrationSha256(manifest),
    implementationSha256: impl.implementationSha256,
    implementation: impl,
    runtime: runtimeRecord,
    runtimeFingerprint: m6CalibrationSha256(runtimeRecord),
    outputDirectory,
  }
}
const assertContext = async (prepared: M6PreparedCalibration) => {
  const recorded = JSON.parse(await readFile(join(prepared.outputDirectory, 'manifest.json'), 'utf8')) as Record<string, unknown>
  const supplied = withoutDigest(recorded)
  if (recorded.manifestSha256 !== prepared.manifestSha256 ||
      m6CalibrationSha256(supplied) !== prepared.manifestSha256 ||
      stableJson(supplied) !== stableJson(prepared.manifest)) {
    throw new Error('Recorded M6 manifest differs from frozen source')
  }
  const runtimeJson = stableJson({
    schemaVersion: 'm6-sharded-runtime-v1',
    runtime: prepared.runtime,
    runtimeFingerprint: prepared.runtimeFingerprint,
  })
  if ((await readFile(join(prepared.outputDirectory, 'runtime.json'), 'utf8')) !== runtimeJson) {
    throw new Error('Recorded M6 runtime differs from this process')
  }
  if ((await readFile(join(prepared.outputDirectory, 'implementation.json'), 'utf8')) !== stableJson(prepared.implementation)) {
    throw new Error('Recorded M6 implementation inventory differs from current source')
  }
}

export const prepareM6ShardedCalibration = async (outputDirectory: string, resume = false) => {
  const prepared = await context(outputDirectory)
  const frozen = JSON.parse(await readFile(frozenManifestPath, 'utf8')) as Record<string, unknown>
  const supplied = withoutDigest(frozen)
  const suppliedDigest = m6CalibrationSha256(supplied)
  if (frozen.manifestSha256 !== suppliedDigest) throw new Error('Frozen M6 manifest embedded SHA-256 does not match canonical contents')
  if (suppliedDigest !== prepared.manifestSha256 || stableJson(supplied) !== stableJson(prepared.manifest)) {
    throw new Error('Frozen M6 manifest differs from the canonical generated design')
  }
  if (prepared.manifest.cells.length !== 256 || prepared.manifest.design.plannedSimulationRuns !== 1024) {
    throw new Error('Invalid frozen M6 design dimensions')
  }
  await mkdir(outputDirectory, { recursive: true })
  const existing = await readFile(join(outputDirectory, 'manifest.json'), 'utf8').catch(() => null)
  if (existing) {
    if (!resume) throw new Error('M6 output exists; pass --resume to reuse it')
    await assertContext(prepared)
  } else {
    const entries = (await readdir(outputDirectory)).filter((entry) => entry !== '.plumenav-m6-coordinator.lock')
    if (entries.length) throw new Error(`Refusing non-empty M6 output: ${entries.join(', ')}`)
    await atomicWrite(join(outputDirectory, 'manifest.json'), stableJson({ ...prepared.manifest, manifestSha256: prepared.manifestSha256 }))
    await atomicWrite(join(outputDirectory, 'runtime.json'), stableJson({
      schemaVersion: 'm6-sharded-runtime-v1',
      runtime: prepared.runtime,
      runtimeFingerprint: prepared.runtimeFingerprint,
    }))
    await atomicWrite(join(outputDirectory, 'implementation.json'), stableJson(prepared.implementation))
  }
  await mkdir(join(outputDirectory, 'cells'), { recursive: true })
  return prepared
}
const load = async (outputDirectory: string) => {
  const prepared = await context(outputDirectory)
  await assertContext(prepared)
  return prepared
}

const prefixHeader = [
  'manifest_sha256', 'partition', 'scenario_id', 'cell_id',
  'counterfactual_pairing_key', 'condition', 'orientation_bin', 'replicate', 'method_arm',
]
const header = () => `${prefixHeader.join(',')},${batchResultsToCsv([]).trimEnd()}`
const render = (cell: M6CalibrationCell, results: readonly BatchResult[], manifestSha256: string) => {
  const rows = results.map((result, index) => {
    const arm = M6_ARMS[index]
    if (!arm) throw new Error(`${cell.id}: result has no matching arm`)
    const rendered = batchResultsToCsv([result]).split('\n')[1]
    if (!rendered) throw new Error(`Could not render ${cell.id}/${arm.id}`)
    return [
      manifestSha256, 'development', cell.pairingKey, cell.id,
      cell.counterfactualPairingKey, cell.condition, cell.counterfactualOrientationBin,
      cell.replicate, arm.id, rendered,
    ].join(',')
  })
  return `${header()}\n${rows.join('\n')}\n`
}

export const m6ScientificProjection = (csv: string) => {
  const lines = csv.trimEnd().split(/\r?\n/)
  const columns = lines[0]!.split(',')
  if (new Set(columns).size !== columns.length) throw new Error('M6 CSV header contains duplicate columns')
  const excluded = new Set(['mean_compute_ms', 'p95_compute_ms'])
  if ([...excluded].some((column) => !columns.includes(column))) throw new Error('Missing M6 scientific timing column')
  const included = columns.map((column, index) => ({ column, index })).filter(({ column }) => !excluded.has(column))
  return stableJson({
    schemaVersion: PROJECTION_VERSION,
    columns: included.map(({ column }) => column),
    rows: lines.slice(1).filter(Boolean).map((line) => {
      const values = line.split(',')
      if (values.length !== columns.length) throw new Error('Malformed M6 CSV row')
      return included.map(({ index }) => values[index])
    }),
  })
}

const almostEqual = (first: number, second: number) => Math.abs(first - second) <= 1e-12
const csvMatchesCell = (csv: string, cell: M6CalibrationCell, manifestSha256: string) => {
  const lines = csv.trimEnd().split(/\r?\n/)
  if (lines.length !== M6_ARMS.length + 1 || lines[0] !== header()) return false
  const columns = lines[0]!.split(',')
  if (new Set(columns).size !== columns.length) return false
  const indexes = new Map(columns.map((column, index) => [column, index]))
  const required = [
    'algorithm', 'scenario', 'target_status', 'seed', 'source_seed', 'controller_seed',
    'controller_observation_model_seed', 'controller_observation_model_version',
    'source_x_normalized', 'source_y_normalized', 'checkpoint_s',
    'active_sniff_enabled', 'active_sniff_strength', 'effective_source_emission_rate_scale',
    'quad_declaration_evaluations', 'quad_declaration_max_gates_passed',
  ]
  if (required.some((column) => !indexes.has(column))) return false
  for (let armIndex = 0; armIndex < M6_ARMS.length; armIndex++) {
    const arm = M6_ARMS[armIndex]!
    const values = lines[armIndex + 1]!.split(',')
    if (values.length !== columns.length) return false
    const value = (column: string) => values[indexes.get(column)!]
    const config = m6ArmConfig(cell, arm)
    if (value('manifest_sha256') !== manifestSha256 || value('partition') !== 'development' ||
        value('scenario_id') !== cell.pairingKey || value('cell_id') !== cell.id ||
        value('counterfactual_pairing_key') !== cell.counterfactualPairingKey ||
        value('condition') !== cell.condition || value('orientation_bin') !== cell.counterfactualOrientationBin ||
        value('replicate') !== String(cell.replicate) || value('method_arm') !== arm.id ||
        value('algorithm') !== arm.algorithmId || value('scenario') !== cell.scenarioKind ||
        value('target_status') !== cell.condition || value('controller_observation_model_version') !== cell.observationModelVersion) {
      return false
    }
    const numeric: Array<[string, number]> = [
      ['seed', config.seed], ['source_seed', config.sourceSeed], ['controller_seed', config.controllerSeed],
      ['controller_observation_model_seed', config.observationModelSeed],
      ['checkpoint_s', 180], ['active_sniff_enabled', config.activeSniffEnabled ? 1 : 0],
      ['active_sniff_strength', config.activeSniffStrength],
    ]
    if (!numeric.every(([column, expected]) => {
      const actual = value(column)
      return actual !== '' && Number.isFinite(Number(actual)) && almostEqual(Number(actual), expected)
    })) return false
    if (!Number.isFinite(Number(value('quad_declaration_evaluations'))) ||
        !Number.isFinite(Number(value('quad_declaration_max_gates_passed')))) return false
    if (cell.condition === 'absent') {
      if (value('source_x_normalized') !== '' || value('source_y_normalized') !== '' ||
          value('effective_source_emission_rate_scale') !== '0') return false
    } else if (!cell.config.sourcePositionOverride ||
        !almostEqual(Number(value('source_x_normalized')), cell.config.sourcePositionOverride.x) ||
        !almostEqual(Number(value('source_y_normalized')), cell.config.sourcePositionOverride.y) ||
        !almostEqual(Number(value('effective_source_emission_rate_scale')), config.emissionRateScale)) {
      return false
    }
  }
  return true
}

const cellFingerprint = (cell: M6CalibrationCell) =>
  m6CalibrationSha256({ schemaVersion: M6_SHARDED_SCHEMA_VERSION, cell, arms: M6_ARMS })
const validCell = async (prepared: M6PreparedCalibration, cell: M6CalibrationCell) => {
  try {
    const csv = await readFile(join(prepared.outputDirectory, 'cells', `${cell.id}.csv`), 'utf8')
    const metadata = JSON.parse(await readFile(join(prepared.outputDirectory, 'cells', `${cell.id}.json`), 'utf8')) as Partial<Completion>
    return csvMatchesCell(csv, cell, prepared.manifestSha256) &&
      metadata.schemaVersion === M6_SHARDED_SCHEMA_VERSION && metadata.complete === true &&
      metadata.manifestSha256 === prepared.manifestSha256 &&
      metadata.implementationSha256 === prepared.implementationSha256 &&
      metadata.runtimeFingerprint === prepared.runtimeFingerprint && metadata.cellId === cell.id &&
      metadata.cellFingerprint === cellFingerprint(cell) && metadata.rawRows === 4 &&
      metadata.artifactSha256 === sha256(csv) &&
      metadata.scientificSha256 === sha256(m6ScientificProjection(csv))
  } catch {
    return false
  }
}

const defaultExecute: M6CellExecution = async (cell, arm, config) => {
  const batch = await runBatch(config, [arm.algorithmId], [cell.scenarioKind], 1)
  return batch.results
}
const validateResult = (cell: M6CalibrationCell, arm: M6Arm, config: SimulationConfig, result: BatchResult) => {
  if (result.algorithmId !== arm.algorithmId || result.scenarioKind !== cell.scenarioKind ||
      result.seed !== config.seed || result.checkpointSeconds !== 180 ||
      result.observationModelVersion !== cell.observationModelVersion ||
      result.observationModelSeed !== config.observationModelSeed ||
      result.metrics.targetStatus !== cell.condition ||
      m6CalibrationSha256(result.config) !== m6CalibrationSha256(config)) {
    throw new Error(`${cell.id}/${arm.id}: result identity mismatch`)
  }
}

export const executeM6CalibrationShard = async ({
  outputDirectory,
  shardIndex,
  shardCount,
  onProgress,
  executeArm = defaultExecute,
}: {
  outputDirectory: string
  shardIndex: number
  shardCount: number
  onProgress?: (event: M6Progress) => void
  executeArm?: M6CellExecution
}): Promise<M6ShardResult> => {
  const prepared = await load(outputDirectory)
  const assigned = selectM6Shard(prepared.manifest.cells, shardIndex, shardCount)
  let completedCells = 0
  let skippedCells = 0
  for (const cell of assigned) {
    if (await validCell(prepared, cell)) {
      skippedCells += 1
      onProgress?.({ cellId: cell.id, status: 'skipped' })
      continue
    }
    const results: BatchResult[] = []
    for (const arm of M6_ARMS) {
      const config = m6ArmConfig(cell, arm)
      const armResults = await executeArm(cell, arm, config)
      if (armResults.length !== 1) throw new Error(`${cell.id}/${arm.id}: expected exactly one checkpoint result`)
      validateResult(cell, arm, config, armResults[0]!)
      results.push(armResults[0]!)
    }
    const csv = render(cell, results, prepared.manifestSha256)
    if (!csvMatchesCell(csv, cell, prepared.manifestSha256)) throw new Error(`${cell.id}: rendered CSV violates frozen M6 contract`)
    await atomicWrite(join(outputDirectory, 'cells', `${cell.id}.csv`), csv)
    await atomicWrite(join(outputDirectory, 'cells', `${cell.id}.json`), stableJson({
      schemaVersion: M6_SHARDED_SCHEMA_VERSION,
      complete: true,
      manifestSha256: prepared.manifestSha256,
      implementationSha256: prepared.implementationSha256,
      runtimeFingerprint: prepared.runtimeFingerprint,
      cellId: cell.id,
      cellFingerprint: cellFingerprint(cell),
      artifactSha256: sha256(csv),
      scientificSha256: sha256(m6ScientificProjection(csv)),
      rawRows: 4,
    } satisfies Completion))
    completedCells += 1
    onProgress?.({ cellId: cell.id, status: 'completed' })
  }
  return {
    shardIndex,
    shardCount,
    assignedCells: assigned.length,
    assignedRuns: assigned.length * M6_ARMS.length,
    completedCells,
    skippedCells,
  }
}

export const finalizeM6Calibration = async (outputDirectory: string, signal?: AbortSignal) => {
  const prepared = await load(outputDirectory)
  const rows: string[] = []
  const cellCsv: string[] = []
  for (const cell of prepared.manifest.cells) {
    if (signal?.aborted) throw signal.reason ?? new Error('M6 finalization aborted')
    if (!(await validCell(prepared, cell))) throw new Error(`${cell.id}: invalid or missing completion; refusing partial M6 finalization`)
    const csv = await readFile(join(outputDirectory, 'cells', `${cell.id}.csv`), 'utf8')
    cellCsv.push(csv)
    rows.push(...csv.trimEnd().split('\n').slice(1))
  }
  const raw = `${header()}\n${rows.join('\n')}\n`
  const rawResultsSha256 = sha256(raw)
  const scientificResultsSha256 = sha256(m6ScientificProjection(raw))
  await atomicWrite(join(outputDirectory, 'raw-results.csv'), raw)
  const metadata = stableJson({
    schemaVersion: M6_SHARDED_SCHEMA_VERSION,
    complete: true,
    manifestSha256: prepared.manifestSha256,
    implementationSha256: prepared.implementationSha256,
    runtimeFingerprint: prepared.runtimeFingerprint,
    plannedCells: prepared.manifest.cells.length,
    plannedSimulationRuns: prepared.manifest.design.plannedSimulationRuns,
    rawResultRows: rows.length,
    rawResultsSha256,
    scientificProjectionVersion: PROJECTION_VERSION,
    scientificResultsSha256,
    mergeOrder: 'manifest cell order, then frozen arm order',
    claimBoundary: prepared.manifest.claimBoundary,
    timingBoundary: 'mean_compute_ms and p95_compute_ms are excluded only from scientific equivalence',
  })
  await atomicWrite(join(outputDirectory, 'metadata.json'), metadata)
  const inventory: Array<{ path: string; bytes: number; sha256: string }> = []
  const add = (path: string, contents: string) => inventory.push({ path, bytes: Buffer.byteLength(contents), sha256: sha256(contents) })
  for (const path of ['manifest.json', 'runtime.json', 'implementation.json']) {
    add(path, await readFile(join(outputDirectory, path), 'utf8'))
  }
  add('metadata.json', metadata)
  add('raw-results.csv', raw)
  for (let index = 0; index < prepared.manifest.cells.length; index++) {
    const cell = prepared.manifest.cells[index]!
    add(`cells/${cell.id}.csv`, cellCsv[index]!)
    add(`cells/${cell.id}.json`, await readFile(join(outputDirectory, 'cells', `${cell.id}.json`), 'utf8'))
  }
  await atomicWrite(join(outputDirectory, 'checksums.json'), stableJson({
    schemaVersion: 'm6-sharded-checksums-v1',
    manifestSha256: prepared.manifestSha256,
    rawResultsSha256,
    scientificResultsSha256,
    coreArtifactInventory: inventory,
    coreArtifactInventorySha256: m6CalibrationSha256(inventory),
  }))
  return {
    manifestSha256: prepared.manifestSha256,
    rawResultsSha256,
    scientificResultsSha256,
    completedCells: prepared.manifest.cells.length,
    rawResultRows: rows.length,
  }
}
