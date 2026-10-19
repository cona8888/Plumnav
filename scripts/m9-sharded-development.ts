/** Resumable sharded executor for the frozen M9 adaptive-viewpoint development. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { batchResultsToCsv, runBatch } from '../src/sim/batch'
import { SIMULATOR_VERSION } from '../src/sim/config'
import {
  createM9Manifest,
  M9_ARMS,
  m9ManifestSha256,
  type M9Arm,
  type M9Cell,
  type M9Manifest,
} from './m9-adaptive-development-manifest'
import type { BatchResult, SimulationConfig } from '../src/sim/types'

export const M9_RUNNER_SCHEMA_VERSION = 'm9-adaptive-development-sharded-v1'
const PROJECTION_VERSION = 'm9-adaptive-development-scientific-projection-v1'
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const frozenManifestPath = join(projectRoot, 'research', 'protocols', 'm9_adaptive_viewpoint_development', 'm9-adaptive-development-manifest.json')

type Runtime = { node: string; v8: string; platform: string; architecture: string; osRelease: string; cpuModel: string }
type Implementation = {
  schemaVersion: 'm9-adaptive-development-implementation-v1'
  files: Array<{ path: string; bytes: number; sha256: string }>
  implementationSha256: string
}
type Completion = {
  schemaVersion: typeof M9_RUNNER_SCHEMA_VERSION
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
export type M9Prepared = {
  manifest: M9Manifest
  manifestSha256: string
  implementation: Implementation
  implementationSha256: string
  runtime: Runtime
  runtimeFingerprint: string
  outputDirectory: string
}
export type M9ShardResult = {
  shardIndex: number
  shardCount: number
  assignedCells: number
  assignedRuns: number
  completedCells: number
  skippedCells: number
}
export type M9ExecuteArm = (cell: M9Cell, arm: M9Arm, config: SimulationConfig) => Promise<BatchResult[]>

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
export const m9ArmConfig = (cell: M9Cell, arm: M9Arm): SimulationConfig => ({
  ...cloneConfig(cell.config),
  ...arm.configOverrides,
  algorithmId: arm.algorithmId,
})
export const selectM9Shard = <T>(cells: readonly T[], index: number, count: number) => {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError('Invalid M9 shard index/count')
  }
  return cells.filter((_, position) => position % count === index)
}

const runtime = (): Runtime => ({
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
const implementation = async (): Promise<Implementation> => {
  const paths = [
    ...await implementationFiles(join(projectRoot, 'src', 'sim')),
    frozenManifestPath,
    join(projectRoot, 'scripts', 'm9-adaptive-development-manifest.ts'),
    join(projectRoot, 'scripts', 'm9-sharded-development.ts'),
    join(projectRoot, 'scripts', 'local-m9-development.ts'),
    join(projectRoot, 'package.json'),
    join(projectRoot, 'pnpm-lock.yaml'),
    join(projectRoot, 'tsconfig.json'),
    join(projectRoot, 'tsconfig.app.json'),
    join(projectRoot, 'tsconfig.node.json'),
    join(projectRoot, 'vite.config.ts'),
  ].sort()
  const digest = createHash('sha256')
  const files: Implementation['files'] = []
  for (const path of paths) {
    try {
      const bytes = await readFile(path)
      const relative = path.slice(projectRoot.length)
      digest.update(relative); digest.update('\0'); digest.update(bytes); digest.update('\0')
      files.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return { schemaVersion: 'm9-adaptive-development-implementation-v1', files, implementationSha256: digest.digest('hex') }
}
const context = async (outputDirectory: string): Promise<M9Prepared> => {
  const manifest = createM9Manifest()
  const impl = await implementation()
  const runtimeRecord = runtime()
  return {
    manifest,
    manifestSha256: m9ManifestSha256(manifest),
    implementation: impl,
    implementationSha256: impl.implementationSha256,
    runtime: runtimeRecord,
    runtimeFingerprint: m9ManifestSha256(runtimeRecord),
    outputDirectory,
  }
}
const assertContext = async (prepared: M9Prepared) => {
  const recorded = JSON.parse(await readFile(join(prepared.outputDirectory, 'manifest.json'), 'utf8')) as Record<string, unknown>
  const supplied = withoutDigest(recorded)
  if (recorded.manifestSha256 !== prepared.manifestSha256 ||
      m9ManifestSha256(supplied) !== prepared.manifestSha256 ||
      stableJson(supplied) !== stableJson(prepared.manifest)) throw new Error('Recorded M9 manifest differs from frozen source')
  const runtimeJson = stableJson({ schemaVersion: 'm9-sharded-runtime-v1', runtime: prepared.runtime, runtimeFingerprint: prepared.runtimeFingerprint })
  if ((await readFile(join(prepared.outputDirectory, 'runtime.json'), 'utf8')) !== runtimeJson) {
    throw new Error('Recorded M9 runtime differs from this process')
  }
  if ((await readFile(join(prepared.outputDirectory, 'implementation.json'), 'utf8')) !== stableJson(prepared.implementation)) {
    throw new Error('Recorded M9 implementation differs from current source')
  }
}
export const prepareM9Verification = async (outputDirectory: string, resume = false) => {
  const prepared = await context(outputDirectory)
  const frozen = JSON.parse(await readFile(frozenManifestPath, 'utf8')) as Record<string, unknown>
  const supplied = withoutDigest(frozen)
  const digest = m9ManifestSha256(supplied)
  if (frozen.manifestSha256 !== digest || digest !== prepared.manifestSha256 ||
      stableJson(supplied) !== stableJson(prepared.manifest)) throw new Error('Frozen M9 manifest identity mismatch')
  if (prepared.manifest.requiredSimulatorVersion !== SIMULATOR_VERSION || SIMULATOR_VERSION !== '0.13.0') {
    throw new Error('M9 simulator version does not match the frozen manifest')
  }
  if (prepared.manifest.cells.length !== 64 || prepared.manifest.design.plannedSimulationRuns !== 256 ||
      prepared.manifest.design.armsPerConditionWorld !== M9_ARMS.length) {
    throw new Error('Invalid frozen M9 dimensions')
  }
  await mkdir(outputDirectory, { recursive: true })
  const existing = await readFile(join(outputDirectory, 'manifest.json'), 'utf8').catch(() => null)
  if (existing) {
    if (!resume) throw new Error('M9 output exists; pass --resume to reuse it')
    await assertContext(prepared)
  } else {
    const entries = (await readdir(outputDirectory)).filter((entry) => entry !== '.plumenav-m9-coordinator.lock')
    if (entries.length) throw new Error(`Refusing non-empty M9 output: ${entries.join(', ')}`)
    await atomicWrite(join(outputDirectory, 'manifest.json'), stableJson({ ...prepared.manifest, manifestSha256: prepared.manifestSha256 }))
    await atomicWrite(join(outputDirectory, 'runtime.json'), stableJson({ schemaVersion: 'm9-sharded-runtime-v1', runtime: prepared.runtime, runtimeFingerprint: prepared.runtimeFingerprint }))
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

const prefix = ['manifest_sha256', 'partition', 'scenario_id', 'cell_id', 'counterfactual_pairing_key', 'condition', 'orientation_bin', 'replicate', 'method_arm', 'candidate_policy']
const header = () => `${prefix.join(',')},${batchResultsToCsv([]).trimEnd()}`
const render = (cell: M9Cell, results: readonly BatchResult[], manifestSha256: string) => {
  const rows = results.map((result, index) => {
    const arm = M9_ARMS[index]
    const row = batchResultsToCsv([result]).split('\n')[1]
    if (!arm || !row) throw new Error(`${cell.id}: cannot render arm ${index}`)
    return [manifestSha256, 'development-verification', cell.pairingKey, cell.id,
      cell.counterfactualPairingKey, cell.condition, cell.orientationBin, cell.replicate, arm.id, arm.policy, row].join(',')
  })
  return `${header()}\n${rows.join('\n')}\n`
}

export const m9ScientificProjection = (csv: string) => {
  const lines = csv.trimEnd().split(/\r?\n/)
  const columns = lines[0]!.split(',')
  if (new Set(columns).size !== columns.length) throw new Error('M9 CSV header contains duplicate columns')
  const excluded = new Set(['mean_compute_ms', 'p95_compute_ms'])
  if ([...excluded].some((column) => !columns.includes(column))) throw new Error('M9 timing columns missing')
  const included = columns.map((column, index) => ({ column, index })).filter(({ column }) => !excluded.has(column))
  return stableJson({
    schemaVersion: PROJECTION_VERSION,
    columns: included.map(({ column }) => column),
    rows: lines.slice(1).filter(Boolean).map((line) => {
      const values = line.split(',')
      if (values.length !== columns.length) throw new Error('Malformed M9 CSV row')
      return included.map(({ index }) => values[index])
    }),
  })
}
const csvMatchesCell = (csv: string, cell: M9Cell, manifestSha256: string) => {
  const lines = csv.trimEnd().split(/\r?\n/)
  if (lines.length !== M9_ARMS.length + 1 || lines[0] !== header()) return false
  const columns = lines[0]!.split(',')
  const indexes = new Map(columns.map((column, index) => [column, index]))
  const required = [
    'algorithm', 'scenario', 'target_status', 'seed', 'source_x_normalized', 'source_y_normalized',
    'checkpoint_s', 'active_sniff_enabled', 'active_sniff_strength', 'candidate_policy',
    'terminal_outcome', 'native_declaration', 'false_declarations', 'spurious_declaration',
    'quad_candidate_formation_evaluations', 'quad_candidate_provisional_ray_evaluations',
    'quad_candidate_max_gradient_ray_pool_count', 'quad_candidate_max_provisional_ray_count',
    'quad_candidate_max_quality', 'quad_candidate_max_surface_support', 'quad_candidate_best_trusted',
    'quad_declaration_evaluations', 'quad_declaration_gate_passes_candidate',
    'quad_declaration_gate_passes_surface_count', 'quad_declaration_gate_passes_passive_core_count',
    'quad_declaration_gate_passes_passive_ring_count',
  ]
  const numericTelemetry = required.slice(11)
  if (required.some((column) => !indexes.has(column)) || new Set(columns).size !== columns.length) return false
  for (let index = 0; index < M9_ARMS.length; index++) {
    const arm = M9_ARMS[index]!
    const values = lines[index + 1]!.split(',')
    if (values.length !== columns.length) return false
    const value = (column: string) => values[indexes.get(column)!]
    const config = m9ArmConfig(cell, arm)
    if (value('manifest_sha256') !== manifestSha256 || value('partition') !== 'development-verification' ||
        value('scenario_id') !== cell.pairingKey || value('cell_id') !== cell.id ||
        value('counterfactual_pairing_key') !== cell.counterfactualPairingKey ||
        value('condition') !== cell.condition || value('orientation_bin') !== cell.orientationBin ||
        value('replicate') !== String(cell.replicate) || value('method_arm') !== arm.id ||
        value('candidate_policy') !== arm.policy ||
        value('algorithm') !== arm.algorithmId || value('scenario') !== cell.scenarioKind ||
        value('target_status') !== cell.condition || value('seed') !== String(config.seed) ||
        value('checkpoint_s') !== '180' ||
        value('active_sniff_enabled') !== (config.activeSniffEnabled ? '1' : '0') ||
        Number(value('active_sniff_strength')) !== config.activeSniffStrength) return false
    if (value('terminal_outcome') === '') return false
    for (const column of numericTelemetry) {
      if (value(column) === '' || !Number.isFinite(Number(value(column)))) return false
    }
    if (cell.condition === 'absent') {
      if (value('source_x_normalized') !== '' || value('source_y_normalized') !== '') return false
    } else if (!cell.config.sourcePositionOverride ||
        Number(value('source_x_normalized')) !== cell.config.sourcePositionOverride.x ||
        Number(value('source_y_normalized')) !== cell.config.sourcePositionOverride.y) return false
  }
  return true
}
const cellFingerprint = (cell: M9Cell) => m9ManifestSha256({ schemaVersion: M9_RUNNER_SCHEMA_VERSION, cell, arms: M9_ARMS })
const validCell = async (prepared: M9Prepared, cell: M9Cell) => {
  try {
    const csv = await readFile(join(prepared.outputDirectory, 'cells', `${cell.id}.csv`), 'utf8')
    const metadata = JSON.parse(await readFile(join(prepared.outputDirectory, 'cells', `${cell.id}.json`), 'utf8')) as Partial<Completion>
    return csvMatchesCell(csv, cell, prepared.manifestSha256) &&
      metadata.schemaVersion === M9_RUNNER_SCHEMA_VERSION && metadata.complete === true &&
      metadata.manifestSha256 === prepared.manifestSha256 &&
      metadata.implementationSha256 === prepared.implementationSha256 &&
      metadata.runtimeFingerprint === prepared.runtimeFingerprint && metadata.cellId === cell.id &&
      metadata.cellFingerprint === cellFingerprint(cell) && metadata.rawRows === 4 &&
      metadata.artifactSha256 === sha256(csv) &&
      metadata.scientificSha256 === sha256(m9ScientificProjection(csv))
  } catch { return false }
}
const defaultExecute: M9ExecuteArm = async (cell, arm, config) =>
  (await runBatch(config, [arm.algorithmId], [cell.scenarioKind], 1)).results
const validateResult = (cell: M9Cell, arm: M9Arm, config: SimulationConfig, result: BatchResult) => {
  if (result.algorithmId !== arm.algorithmId || result.scenarioKind !== cell.scenarioKind ||
      result.seed !== config.seed || result.checkpointSeconds !== 180 ||
      result.observationModelVersion !== cell.observationModelVersion ||
      result.observationModelSeed !== config.observationModelSeed ||
      result.metrics.targetStatus !== cell.condition ||
      result.metrics.quadCandidateFormationEvaluations <= 0 ||
      result.metrics.quadDeclarationEvaluations <= 0 ||
      m9ManifestSha256(result.config) !== m9ManifestSha256(config)) {
    throw new Error(`${cell.id}/${arm.id}: result identity or telemetry mismatch`)
  }
}

export const executeM9Shard = async ({
  outputDirectory, shardIndex, shardCount, onProgress, executeArm = defaultExecute,
}: {
  outputDirectory: string
  shardIndex: number
  shardCount: number
  onProgress?: (event: { cellId: string; status: 'completed' | 'skipped' }) => void
  executeArm?: M9ExecuteArm
}): Promise<M9ShardResult> => {
  const prepared = await load(outputDirectory)
  const assigned = selectM9Shard(prepared.manifest.cells, shardIndex, shardCount)
  let completedCells = 0; let skippedCells = 0
  for (const cell of assigned) {
    if (await validCell(prepared, cell)) {
      skippedCells += 1; onProgress?.({ cellId: cell.id, status: 'skipped' }); continue
    }
    const results: BatchResult[] = []
    for (const arm of M9_ARMS) {
      const config = m9ArmConfig(cell, arm)
      const armResults = await executeArm(cell, arm, config)
      if (armResults.length !== 1) throw new Error(`${cell.id}/${arm.id}: expected one result`)
      validateResult(cell, arm, config, armResults[0]!)
      results.push(armResults[0]!)
    }
    const csv = render(cell, results, prepared.manifestSha256)
    if (!csvMatchesCell(csv, cell, prepared.manifestSha256)) throw new Error(`${cell.id}: rendered CSV contract failure`)
    await atomicWrite(join(outputDirectory, 'cells', `${cell.id}.csv`), csv)
    await atomicWrite(join(outputDirectory, 'cells', `${cell.id}.json`), stableJson({
      schemaVersion: M9_RUNNER_SCHEMA_VERSION,
      complete: true,
      manifestSha256: prepared.manifestSha256,
      implementationSha256: prepared.implementationSha256,
      runtimeFingerprint: prepared.runtimeFingerprint,
      cellId: cell.id,
      cellFingerprint: cellFingerprint(cell),
      artifactSha256: sha256(csv),
      scientificSha256: sha256(m9ScientificProjection(csv)),
      rawRows: 4,
    } satisfies Completion))
    completedCells += 1
    onProgress?.({ cellId: cell.id, status: 'completed' })
  }
  return { shardIndex, shardCount, assignedCells: assigned.length, assignedRuns: assigned.length * M9_ARMS.length, completedCells, skippedCells }
}

export const finalizeM9Verification = async (outputDirectory: string, signal?: AbortSignal) => {
  const prepared = await load(outputDirectory)
  const rows: string[] = []; const cellCsv: string[] = []
  for (const cell of prepared.manifest.cells) {
    if (signal?.aborted) throw signal.reason ?? new Error('M9 finalization aborted')
    if (!(await validCell(prepared, cell))) throw new Error(`${cell.id}: invalid or missing completion; refusing partial M9 finalization`)
    const csv = await readFile(join(outputDirectory, 'cells', `${cell.id}.csv`), 'utf8')
    cellCsv.push(csv); rows.push(...csv.trimEnd().split('\n').slice(1))
  }
  const raw = `${header()}\n${rows.join('\n')}\n`
  const rawResultsSha256 = sha256(raw)
  const scientificResultsSha256 = sha256(m9ScientificProjection(raw))
  await atomicWrite(join(outputDirectory, 'raw-results.csv'), raw)
  const metadata = stableJson({
    schemaVersion: M9_RUNNER_SCHEMA_VERSION,
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
  })
  await atomicWrite(join(outputDirectory, 'metadata.json'), metadata)
  const inventory: Array<{ path: string; bytes: number; sha256: string }> = []
  const add = (path: string, contents: string) => inventory.push({ path, bytes: Buffer.byteLength(contents), sha256: sha256(contents) })
  for (const path of ['manifest.json', 'runtime.json', 'implementation.json']) add(path, await readFile(join(outputDirectory, path), 'utf8'))
  add('metadata.json', metadata); add('raw-results.csv', raw)
  for (let index = 0; index < prepared.manifest.cells.length; index++) {
    const cell = prepared.manifest.cells[index]!
    add(`cells/${cell.id}.csv`, cellCsv[index]!)
    add(`cells/${cell.id}.json`, await readFile(join(outputDirectory, 'cells', `${cell.id}.json`), 'utf8'))
  }
  await atomicWrite(join(outputDirectory, 'checksums.json'), stableJson({
    schemaVersion: 'm9-sharded-checksums-v1',
    manifestSha256: prepared.manifestSha256,
    rawResultsSha256,
    scientificResultsSha256,
    coreArtifactInventory: inventory,
    coreArtifactInventorySha256: m9ManifestSha256(inventory),
  }))
  return { manifestSha256: prepared.manifestSha256, rawResultsSha256, scientificResultsSha256, rawResultRows: rows.length }
}
