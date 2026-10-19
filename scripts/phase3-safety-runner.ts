/** Resumable raw-artifact runner for the frozen Phase 3 safety design. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { batchResultsToCsv, runBatch } from '../src/sim/batch'
import { createPhase3SafetyManifest, phase3SafetySha256, type Phase3SafetyCell, type Phase3SafetyManifest } from './phase3-source-absent-manifest'
import type { BatchResult, SimulationConfig } from '../src/sim/types'

export const PHASE3_RUNNER_SCHEMA_VERSION = 'phase3-source-absent-safety-runner-v1'
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
const legacyJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const atomicWrite = async (path: string, contents: string) => {
  const temporary = `${path}.tmp`
  await writeFile(temporary, contents, 'utf8')
  await rename(temporary, path)
}

export type Phase3CellExecution = (cell: Phase3SafetyCell) => Promise<BatchResult[]>
export type Phase3SafetyRunnerOptions = { outputDirectory: string; manifestPath?: string; dryRun?: boolean; executeCell?: Phase3CellExecution }
export type Phase3SafetyRunSummary = { manifestSha256: string; plannedCells: number; completedCells: number; skippedCells: number; dryRun: boolean; outputDirectory: string }
type CompletionMetadata = { schemaVersion: typeof PHASE3_RUNNER_SCHEMA_VERSION; complete: true; manifestSha256: string; cellId: string; cellFingerprint: string; implementationSha256: string; csvSha256: string; rawRows: number }

const manifestWithoutDigest = (value: Record<string, unknown>) => { const { manifestSha256: _ignored, ...manifest } = value; return manifest }
const projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const implementationFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => { const path = join(directory, entry.name); return entry.isDirectory() ? implementationFiles(path) : [path] }))
  return nested.flat()
}

export const phase3ImplementationSha256 = async () => {
  const paths = [
    ...(await implementationFiles(join(projectRoot, 'src', 'sim'))),
    join(projectRoot, 'scripts', 'phase3-source-absent-manifest.ts'),
    join(projectRoot, 'scripts', 'phase3-safety-runner.ts'),
    join(projectRoot, 'package.json'), join(projectRoot, 'pnpm-lock.yaml'),
  ].sort()
  const hash = createHash('sha256')
  for (const path of paths) {
    try { hash.update(path.slice(projectRoot.length)); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  hash.update(stableJson({ node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch }))
  return hash.digest('hex')
}

export const loadAndValidatePhase3Manifest = async (manifestPath?: string) => {
  const canonical = createPhase3SafetyManifest()
  const canonicalDigest = phase3SafetySha256(canonical)
  const validateCells = (manifest: Phase3SafetyManifest) => {
    if (!manifest.cells.every((cell) => cell.config.targetStatus === cell.condition)) throw new Error('Phase 3 cell targetStatus must equal its safety condition')
    if (!manifest.cells.every((cell) => cell.observationModelVersion === manifest.observationModelVersion)) throw new Error('Phase 3 cell observation-model version must match the manifest')
  }
  validateCells(canonical)
  if (!manifestPath) return { manifest: canonical, manifestSha256: canonicalDigest }
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  const supplied = manifestWithoutDigest(parsed)
  const suppliedDigest = phase3SafetySha256(supplied)
  const legacyDigest = sha256(legacyJson(supplied))
  if (parsed.manifestSha256 !== suppliedDigest && parsed.manifestSha256 !== legacyDigest) throw new Error('Phase 3 manifest embedded SHA-256 does not match canonical contents')
  if (suppliedDigest !== canonicalDigest) throw new Error('Phase 3 manifest is not the frozen canonical manifest')
  validateCells(supplied as unknown as Phase3SafetyManifest)
  return { manifest: supplied as unknown as Phase3SafetyManifest, manifestSha256: canonicalDigest }
}

export const phase3CellFingerprint = (cell: Phase3SafetyCell) => phase3SafetySha256(cell)
const csvHeader = () => `manifest_sha256,partition,scenario_id,cell_id,counterfactual_pairing_key,condition,orientation_bin,replicate,method_arm,${batchResultsToCsv([]).trimEnd()}`
const csvDataRows = (csv: string) => csv.trimEnd().split('\n').slice(1)
const rowIdentityPrefix = (cell: Phase3SafetyCell, manifestSha256: string) =>
  `${manifestSha256},development,${cell.analysisPairingKey},${cell.id},${cell.counterfactualPairingKey},${cell.condition},${cell.counterfactualOrientationBin},${cell.replicate},${cell.algorithmId},`

const persistedCellRowsAreValid = (
  cell: Phase3SafetyCell,
  csv: string,
  manifestSha256: string,
) => {
  const lines = csv.trimEnd().split('\n')
  const header = lines[0]?.split(',') ?? []
  if (header.join(',') !== csvHeader()) return false
  const index = new Map(header.map((column, position) => [column, position]))
  const required = [
    'condition',
    'algorithm',
    'scenario',
    'target_status',
    'seed',
    'source_seed',
    'controller_seed',
    'controller_observation_model_seed',
    'controller_observation_model_version',
    'source_x_normalized',
    'source_y_normalized',
    'checkpoint_s',
    'terminal_outcome',
    'normalized_error',
    'direct_distance_path_overhead',
    'spurious_declaration',
    'correct_rejection',
    'correct_abstention',
    'effective_source_emission_rate_scale',
  ] as const
  if (required.some((column) => !index.has(column))) return false
  const rows = lines.slice(1)
  if (rows.length !== cell.config.checkpointSeconds.length) return false
  const expectedCheckpoints = new Set(cell.config.checkpointSeconds.map(String))
  const value = (columns: string[], column: typeof required[number]) =>
    columns[index.get(column)!] ?? ''
  for (const row of rows) {
    if (!row.startsWith(rowIdentityPrefix(cell, manifestSha256))) return false
    const columns = row.split(',')
    if (columns.length !== header.length) return false
    if (value(columns, 'condition') !== cell.condition ||
        value(columns, 'algorithm') !== cell.algorithmId ||
        value(columns, 'scenario') !== cell.scenarioKind ||
        value(columns, 'target_status') !== cell.condition ||
        value(columns, 'seed') !== String(cell.config.seed) ||
        value(columns, 'source_seed') !== String(cell.config.sourceSeed) ||
        value(columns, 'controller_seed') !== String(cell.config.controllerSeed) ||
        value(columns, 'controller_observation_model_seed') !== String(cell.config.observationModelSeed) ||
        value(columns, 'controller_observation_model_version') !== cell.observationModelVersion ||
        !expectedCheckpoints.delete(value(columns, 'checkpoint_s')) ||
        value(columns, 'effective_source_emission_rate_scale') !== '0') {
      return false
    }
    const terminalOutcome = value(columns, 'terminal_outcome')
    const sourceX = value(columns, 'source_x_normalized')
    const sourceY = value(columns, 'source_y_normalized')
    if (cell.condition === 'absent') {
      if (sourceX !== '' || sourceY !== '' ||
          value(columns, 'normalized_error') !== '' ||
          value(columns, 'direct_distance_path_overhead') !== '') return false
      const expectedFlags: Record<string, [string, string, string]> = {
        'spurious-declaration': ['1', '0', '0'],
        'correct-abstention': ['0', '0', '1'],
        'correct-rejection-at-deadline': ['0', '1', '0'],
      }
      const flags = expectedFlags[terminalOutcome]
      if (!flags ||
          value(columns, 'spurious_declaration') !== flags[0] ||
          value(columns, 'correct_rejection') !== flags[1] ||
          value(columns, 'correct_abstention') !== flags[2]) return false
    } else {
      const normalizedError = value(columns, 'normalized_error')
      const pathOverhead = value(columns, 'direct_distance_path_overhead')
      if (sourceX === '' || sourceY === '' || normalizedError === '' || pathOverhead === '' ||
          !Number.isFinite(Number(sourceX)) || !Number.isFinite(Number(sourceY)) ||
          !Number.isFinite(Number(normalizedError)) ||
          !Number.isFinite(Number(pathOverhead)) ||
          !['correct-declaration', 'wrong-declaration', 'missed-source-abstention', 'deadline-nondeclaration-present'].includes(terminalOutcome) ||
          value(columns, 'spurious_declaration') !== '0' ||
          value(columns, 'correct_rejection') !== '') return false
    }
  }
  return expectedCheckpoints.size === 0
}

const renderCellCsv = (cell: Phase3SafetyCell, results: BatchResult[], manifestSha256: string) => {
  const rows = results.map((result) => {
    const rendered = batchResultsToCsv([result]).split('\n')[1]
    if (!rendered) throw new Error(`Could not render result for ${cell.id}`)
    return [manifestSha256, 'development', cell.analysisPairingKey, cell.id, cell.counterfactualPairingKey, cell.condition, cell.counterfactualOrientationBin, cell.replicate, cell.algorithmId, rendered].join(',')
  })
  return `${csvHeader()}\n${rows.join('\n')}\n`
}
const verifiedCell = async (cell: Phase3SafetyCell, directory: string, manifestSha256: string, implementationSha256: string) => {
  try {
    const metadata = JSON.parse(await readFile(join(directory, `${cell.id}.json`), 'utf8')) as CompletionMetadata
    const csv = await readFile(join(directory, `${cell.id}.csv`), 'utf8')
    const rows = csvDataRows(csv)
    return metadata.schemaVersion === PHASE3_RUNNER_SCHEMA_VERSION &&
      metadata.complete === true &&
      metadata.manifestSha256 === manifestSha256 &&
      metadata.cellId === cell.id &&
      metadata.cellFingerprint === phase3CellFingerprint(cell) &&
      metadata.implementationSha256 === implementationSha256 &&
      metadata.rawRows === cell.config.checkpointSeconds.length &&
      rows.length === cell.config.checkpointSeconds.length &&
      metadata.csvSha256 === sha256(csv) &&
      persistedCellRowsAreValid(cell, csv, manifestSha256)
  } catch { return false }
}
const defaultExecuteCell: Phase3CellExecution = async (cell) => {
  const batch = await runBatch({ ...cell.config, checkpointSeconds: [...cell.config.checkpointSeconds] } as SimulationConfig, [cell.algorithmId], [cell.scenarioKind], 1)
  return batch.results
}

const validateCellResults = (cell: Phase3SafetyCell, results: readonly BatchResult[]) => {
  const expectedCheckpoints = [...cell.config.checkpointSeconds].sort((a, b) => a - b)
  const actualCheckpoints = results.map((result) => result.checkpointSeconds).sort((a, b) => a - b)
  if (results.length !== expectedCheckpoints.length ||
      JSON.stringify(actualCheckpoints) !== JSON.stringify(expectedCheckpoints)) {
    throw new Error(`${cell.id}: result checkpoint set does not match its manifest cell`)
  }
  for (const result of results) {
    if (result.algorithmId !== cell.algorithmId ||
        result.scenarioKind !== cell.scenarioKind ||
        result.seed !== cell.config.seed ||
        result.observationModelVersion !== cell.observationModelVersion ||
        result.observationModelSeed !== cell.config.observationModelSeed ||
        result.config.targetStatus !== cell.condition ||
        result.metrics.targetStatus !== cell.condition ||
        phase3SafetySha256(result.config) !== phase3SafetySha256(cell.config)) {
      throw new Error(`${cell.id}: result identity does not match its manifest cell`)
    }
  }
}

/** Raw-only execution; never invokes an analysis or claims pipeline. */
export const runPhase3Safety = async ({ outputDirectory, manifestPath, dryRun = false, executeCell = defaultExecuteCell }: Phase3SafetyRunnerOptions): Promise<Phase3SafetyRunSummary> => {
  const { manifest, manifestSha256 } = await loadAndValidatePhase3Manifest(manifestPath)
  const implementationSha256 = await phase3ImplementationSha256()
  const directory = join(outputDirectory, 'cells')
  await mkdir(directory, { recursive: true })
  const manifestJson = stableJson({ ...manifest, manifestSha256 })
  await atomicWrite(join(outputDirectory, 'manifest.json'), manifestJson)
  if (dryRun) return { manifestSha256, plannedCells: manifest.cells.length, completedCells: 0, skippedCells: 0, dryRun: true, outputDirectory }
  let completedCells = 0; let skippedCells = 0
  for (const cell of manifest.cells) {
    if (await verifiedCell(cell, directory, manifestSha256, implementationSha256)) { skippedCells += 1; continue }
    if (cell.config.targetStatus !== cell.condition) throw new Error(`${cell.id}: targetStatus must equal condition`)
    const results = await executeCell(cell)
    validateCellResults(cell, results)
    const csv = renderCellCsv(cell, results, manifestSha256)
    await atomicWrite(join(directory, `${cell.id}.csv`), csv)
    await atomicWrite(join(directory, `${cell.id}.json`), stableJson({ schemaVersion: PHASE3_RUNNER_SCHEMA_VERSION, complete: true, manifestSha256, cellId: cell.id, cellFingerprint: phase3CellFingerprint(cell), implementationSha256, csvSha256: sha256(csv), rawRows: results.length } satisfies CompletionMetadata))
    completedCells += 1
  }
  const rawRows: string[] = []
  for (const cell of manifest.cells) {
    if (!(await verifiedCell(cell, directory, manifestSha256, implementationSha256))) throw new Error(`${cell.id}: incomplete or unverified artifact`)
    rawRows.push(...(await readFile(join(directory, `${cell.id}.csv`), 'utf8')).trimEnd().split('\n').slice(1))
  }
  const rawCsv = `${csvHeader()}\n${rawRows.join('\n')}\n`
  await atomicWrite(join(outputDirectory, 'raw-results.csv'), rawCsv)
  const metadataJson = stableJson({ schemaVersion: PHASE3_RUNNER_SCHEMA_VERSION, complete: true, manifestSha256, implementationSha256, rawResultsSha256: sha256(rawCsv), plannedCells: manifest.cells.length, rawResultRows: rawRows.length, claimBoundary: manifest.claimBoundary, outputFiles: ['manifest.json', 'metadata.json', 'checksums.json', 'raw-results.csv', 'cells/'] })
  await atomicWrite(join(outputDirectory, 'metadata.json'), metadataJson)
  await atomicWrite(join(outputDirectory, 'checksums.json'), stableJson({
    schemaVersion: 'phase3-source-absent-safety-checksums-v1',
    manifestFileSha256: sha256(manifestJson),
    metadataFileSha256: sha256(metadataJson),
    rawResultsSha256: sha256(rawCsv),
  }))
  return { manifestSha256, plannedCells: manifest.cells.length, completedCells, skippedCells, dryRun: false, outputDirectory }
}
