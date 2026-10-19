/**
 * Resumable runner for the frozen, development-only Phase 2 pilot.
 *
 * This module deliberately performs orchestration only.  It does not analyse
 * outcomes or make claims.  A cell is resumable only when both its completion
 * record and the recorded CSV pass SHA-256 and identity checks.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { batchResultsToCsv, runBatch } from '../src/sim/batch'
import { createPhase2PilotManifest, phase2PilotSha256, type Phase2PilotCell, type Phase2PilotManifest } from './phase2-pilot-manifest'
import type { BatchResult, SimulationConfig } from '../src/sim/types'

export const PHASE2_RUNNER_SCHEMA_VERSION = 'phase2-development-pilot-runner-v3'

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
const sha256Text = (value: string) => createHash('sha256').update(value).digest('hex')
const atomicWrite = async (path: string, contents: string) => {
  const temporary = `${path}.tmp`
  await writeFile(temporary, contents, 'utf8')
  await rename(temporary, path)
}

export type Phase2CellExecution = (cell: Phase2PilotCell) => Promise<BatchResult[]>

export type Phase2PilotRunnerOptions = {
  outputDirectory: string
  manifestPath?: string
  dryRun?: boolean
  executeCell?: Phase2CellExecution
}

export type Phase2PilotRunSummary = {
  manifestSha256: string
  plannedCells: number
  completedCells: number
  skippedCells: number
  dryRun: boolean
  outputDirectory: string
}

type CompletionMetadata = {
  schemaVersion: typeof PHASE2_RUNNER_SCHEMA_VERSION
  complete: true
  manifestSha256: string
  cellId: string
  cellFingerprint: string
  csvSha256: string
  rawRows: number
  implementationSha256: string
}

const projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const implementationFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? implementationFiles(path) : [path]
  }))
  return nested.flat()
}

export const phase2ImplementationSha256 = async () => {
  const root = projectRoot.endsWith('/') ? projectRoot.slice(0, -1) : projectRoot
  const paths = [
    ...(await implementationFiles(join(root, 'src', 'sim'))),
    join(root, 'scripts', 'phase2-pilot-manifest.ts'),
    join(root, 'scripts', 'phase2-pilot-runner.ts'),
    join(root, 'package.json'),
    join(root, 'pnpm-lock.yaml'),
  ].sort()
  const hash = createHash('sha256')
  for (const path of paths) {
    try { hash.update(path.slice(root.length)); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  hash.update(stableJson({ node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch }))
  return hash.digest('hex')
}

const manifestWithoutDigest = (value: Record<string, unknown>) => {
  const { manifestSha256: _ignored, ...manifest } = value
  return manifest
}

/** Load and validate the canonical manifest, including its embedded digest. */
export const loadAndValidatePhase2Manifest = async (manifestPath?: string) => {
  const canonical = createPhase2PilotManifest()
  const canonicalDigest = phase2PilotSha256(canonical)
  if (!canonical.cells.every((cell) => cell.config.targetStatus === 'emitting')) {
    throw new Error('Phase 2 source-present pilot requires every cell to have targetStatus=emitting')
  }
  if (!manifestPath) return { manifest: canonical, manifestSha256: canonicalDigest }
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  const embeddedDigest = parsed.manifestSha256
  const supplied = manifestWithoutDigest(parsed)
  const suppliedDigest = phase2PilotSha256(supplied)
  const legacyDigest = sha256Text(legacyJson(supplied))
  if (embeddedDigest !== suppliedDigest && embeddedDigest !== legacyDigest) {
    throw new Error(`Phase 2 manifest embedded SHA-256 does not match canonical contents (expected ${suppliedDigest}, received ${String(embeddedDigest)})`)
  }
  if (suppliedDigest !== canonicalDigest) throw new Error('Phase 2 manifest is not the frozen canonical manifest')
  if (!Array.isArray((supplied as { cells?: unknown }).cells) || !(supplied as Phase2PilotManifest).cells.every((cell) => cell.config.targetStatus === 'emitting')) {
    throw new Error('Phase 2 source-present pilot requires every cell to have targetStatus=emitting')
  }
  return { manifest: supplied as unknown as Phase2PilotManifest, manifestSha256: canonicalDigest }
}

export const phase2CellFingerprint = (cell: Phase2PilotCell) => phase2PilotSha256(cell)

const csvHeader = () => `manifest_sha256,partition,scenario_id,cell_id,orientation_bin,replicate,method_arm,${batchResultsToCsv([]).trimEnd()}`

const csvDataRows = (csv: string) => csv.trimEnd().split('\n').slice(1)

const rowIdentityPrefix = (cell: Phase2PilotCell, manifestSha256: string) =>
  `${manifestSha256},${cell.partition},${cell.pairingKey},${cell.id},${cell.orientationBin},${cell.replicate},${cell.armId},`

const renderCellCsv = (cell: Phase2PilotCell, results: BatchResult[], manifestSha256: string) => {
  const rows = results.map((result) => {
    const rendered = batchResultsToCsv([result]).split('\n')[1]
    if (!rendered) throw new Error(`Could not render result for ${cell.id}`)
    return [manifestSha256, cell.partition, cell.pairingKey, cell.id, cell.orientationBin, cell.replicate, cell.armId, rendered].join(',')
  })
  return `${csvHeader()}\n${rows.join('\n')}\n`
}

const verifiedCell = async (cell: Phase2PilotCell, cellsDirectory: string, manifestSha256: string, implementationSha256: string) => {
  const csvPath = join(cellsDirectory, `${cell.id}.csv`)
  const metadataPath = join(cellsDirectory, `${cell.id}.json`)
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as CompletionMetadata
    const csv = await readFile(csvPath, 'utf8')
    const rows = csvDataRows(csv)
    const expectedRows = cell.config.checkpointSeconds.length
    const identityPrefix = rowIdentityPrefix(cell, manifestSha256)
    return metadata.schemaVersion === PHASE2_RUNNER_SCHEMA_VERSION &&
      metadata.complete === true &&
      metadata.manifestSha256 === manifestSha256 &&
      metadata.cellId === cell.id &&
      metadata.cellFingerprint === phase2CellFingerprint(cell) &&
      metadata.csvSha256 === sha256Text(csv) &&
      metadata.implementationSha256 === implementationSha256 &&
      metadata.rawRows === expectedRows &&
      rows.length === expectedRows &&
      csv.split('\n')[0] === csvHeader() &&
      rows.every((row) => row.startsWith(identityPrefix))
  } catch {
    return false
  }
}

const defaultExecuteCell: Phase2CellExecution = async (cell) => {
  if (cell.config.targetStatus !== 'emitting') {
    throw new Error(`Phase 2 cell ${cell.id} is not source-present (targetStatus must be emitting)`)
  }
  const config: SimulationConfig = {
    ...cell.config,
    algorithmId: cell.config.algorithmId,
    checkpointSeconds: [...cell.config.checkpointSeconds],
    sourcePositionOverride: cell.config.sourcePositionOverride ? { ...cell.config.sourcePositionOverride } : undefined,
    robotStartPositionOverride: cell.config.robotStartPositionOverride ? { ...cell.config.robotStartPositionOverride } : undefined,
  }
  const batch = await runBatch(config, [cell.config.algorithmId], [cell.scenarioKind], 1)
  return batch.results
}

const validateCellResults = (cell: Phase2PilotCell, results: readonly BatchResult[]) => {
  const expectedCheckpoints = [...cell.config.checkpointSeconds].sort((a, b) => a - b)
  const actualCheckpoints = results.map((result) => result.checkpointSeconds).sort((a, b) => a - b)
  if (results.length !== expectedCheckpoints.length ||
      JSON.stringify(actualCheckpoints) !== JSON.stringify(expectedCheckpoints)) {
    throw new Error(`Phase 2 cell ${cell.id} did not emit the exact checkpoint set`)
  }
  for (const result of results) {
    if (result.algorithmId !== cell.config.algorithmId ||
        result.scenarioKind !== cell.scenarioKind ||
        result.seed !== cell.config.seed ||
        result.observationModelVersion !== cell.observationModelVersion ||
        result.observationModelSeed !== cell.config.observationModelSeed ||
        result.config.targetStatus !== 'emitting' ||
        result.metrics.targetStatus !== 'emitting' ||
        phase2PilotSha256(result.config) !== phase2PilotSha256(cell.config)) {
      throw new Error(`Phase 2 cell ${cell.id} result identity does not match its manifest cell`)
    }
  }
}

/** Execute or dry-run the frozen pilot. No analysis is performed here. */
export const runPhase2Pilot = async ({ outputDirectory, manifestPath, dryRun = false, executeCell = defaultExecuteCell }: Phase2PilotRunnerOptions): Promise<Phase2PilotRunSummary> => {
  const { manifest, manifestSha256 } = await loadAndValidatePhase2Manifest(manifestPath)
  const implementationSha256 = await phase2ImplementationSha256()
  const cellsDirectory = join(outputDirectory, 'cells')
  await mkdir(cellsDirectory, { recursive: true })
  const manifestJson = stableJson({ ...manifest, manifestSha256 })
  await atomicWrite(join(outputDirectory, 'manifest.json'), manifestJson)
  if (dryRun) return { manifestSha256, plannedCells: manifest.cells.length, completedCells: 0, skippedCells: 0, dryRun: true, outputDirectory }

  let completedCells = 0
  let skippedCells = 0
  for (const cell of manifest.cells) {
    if (await verifiedCell(cell, cellsDirectory, manifestSha256, implementationSha256)) {
      skippedCells += 1
      continue
    }
    if (cell.config.targetStatus !== 'emitting') {
      throw new Error(`Phase 2 cell ${cell.id} is not source-present (targetStatus must be emitting)`)
    }
    const results = await executeCell(cell)
    validateCellResults(cell, results)
    const csv = renderCellCsv(cell, results, manifestSha256)
    const csvPath = join(cellsDirectory, `${cell.id}.csv`)
    await atomicWrite(csvPath, csv)
    const metadata: CompletionMetadata = {
      schemaVersion: PHASE2_RUNNER_SCHEMA_VERSION,
      complete: true,
      manifestSha256,
      cellId: cell.id,
      cellFingerprint: phase2CellFingerprint(cell),
      csvSha256: sha256Text(csv),
      rawRows: results.length,
      implementationSha256,
    }
    await atomicWrite(join(cellsDirectory, `${cell.id}.json`), stableJson(metadata))
    completedCells += 1
  }

  // Combine only verified cell artifacts. This is a raw export, not analysis.
  const rawRows: string[] = []
  for (const cell of manifest.cells) {
    if (!(await verifiedCell(cell, cellsDirectory, manifestSha256, implementationSha256))) throw new Error(`Cell ${cell.id} is not a verified completion artifact`)
    const csv = await readFile(join(cellsDirectory, `${cell.id}.csv`), 'utf8')
    rawRows.push(...csv.trimEnd().split('\n').slice(1))
  }
  const rawResultsCsv = `${csvHeader()}\n${rawRows.join('\n')}\n`
  await atomicWrite(join(outputDirectory, 'raw-results.csv'), rawResultsCsv)
  const metadataJson = stableJson({
    schemaVersion: PHASE2_RUNNER_SCHEMA_VERSION,
    manifestSha256,
    implementationSha256,
    rawResultsSha256: sha256Text(rawResultsCsv),
    complete: true,
    plannedCells: manifest.cells.length,
    rawResultRows: rawRows.length,
    claimBoundary: manifest.claimBoundary,
    outputFiles: ['manifest.json', 'metadata.json', 'raw-results.csv', 'checksums.json', 'cells/'],
  })
  await atomicWrite(join(outputDirectory, 'metadata.json'), metadataJson)
  await atomicWrite(join(outputDirectory, 'checksums.json'), stableJson({
    schemaVersion: 'phase2-development-pilot-checksums-v1',
    manifestFileSha256: sha256Text(manifestJson),
    metadataFileSha256: sha256Text(metadataJson),
    rawResultsSha256: sha256Text(rawResultsCsv),
  }))
  return { manifestSha256, plannedCells: manifest.cells.length, completedCells, skippedCells, dryRun: false, outputDirectory }
}
