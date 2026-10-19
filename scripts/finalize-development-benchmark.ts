/**
 * Recovery finalizer for a completed, development-only headless campaign.
 *
 * This file is intentionally outside the frozen simulator implementation
 * inventory. It does not execute simulations. It verifies every recorded cell,
 * combines rows in manifest order, performs explicitly exploratory analysis on
 * the development partition, and records its own source hash in the output.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BENCHMARK_SCHEMA_VERSION,
  benchmarkManifestSha256,
  headlessCellFingerprint,
  runtimeProvenanceFingerprint,
  scientificCsvSha256,
  validateRowsAgainstManifest,
  type BenchmarkManifest,
  type ImplementationProvenance,
  type RuntimeProvenance,
} from './headless-benchmark'
import {
  analyzeHeadlessRows,
  headlessAnalysisToCsv,
  parseHeadlessResultsCsv,
} from './analyze-headless-results'

type CellCompletionMetadata = {
  schemaVersion: string
  manifestSha256: string
  implementationSha256: string
  runtimeFingerprint: string
  cellId: string
  cellFingerprint: string
  complete: boolean
  methodArms: string[]
  rawRows: number
  artifactSha256: string
  scientificSha256: string
}

const stableJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex')
const digest = (value: unknown) => sha256(stableJson(value))

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

const sameStrings = (first: readonly string[], second: readonly string[]) =>
  first.length === second.length && first.every((value, index) => value === second[index])

export const finalizeDevelopmentBenchmark = async (outputDirectory: string) => {
  const manifestText = await readFile(join(outputDirectory, 'manifest.json'), 'utf8')
  const recordedManifest = JSON.parse(manifestText) as BenchmarkManifest & {
    manifestSha256?: string
  }
  const { manifestSha256: recordedManifestSha256, ...manifest } = recordedManifest
  const manifestSha256 = benchmarkManifestSha256(manifest)
  if (!recordedManifestSha256 || recordedManifestSha256 !== manifestSha256) {
    throw new Error('Recorded manifest digest is missing or invalid')
  }
  if (
    manifest.profile !== 'm5-development' ||
    manifest.partitions.length !== 1 ||
    manifest.partitions[0] !== 'development' ||
    manifest.cells.some((cell) => cell.partition !== 'development')
  ) {
    throw new Error('Recovery finalizer accepts only the frozen M5 development-only profile')
  }

  const implementationText = await readFile(join(outputDirectory, 'implementation.json'), 'utf8')
  const implementation = JSON.parse(implementationText) as ImplementationProvenance
  if (
    !manifest.implementationSha256 ||
    implementation.implementationSha256 !== manifest.implementationSha256
  ) {
    throw new Error('Manifest and implementation digests do not agree')
  }

  const runtimeText = await readFile(join(outputDirectory, 'runtime.json'), 'utf8')
  const runtimeRecord = JSON.parse(runtimeText) as {
    schemaVersion?: string
    runtime?: RuntimeProvenance
    runtimeFingerprint?: string
  }
  if (
    runtimeRecord.schemaVersion !== 'headless-runtime-v1' ||
    !runtimeRecord.runtime ||
    !runtimeRecord.runtimeFingerprint ||
    runtimeProvenanceFingerprint(runtimeRecord.runtime) !== runtimeRecord.runtimeFingerprint
  ) {
    throw new Error('Runtime record is missing or has an invalid fingerprint')
  }

  const cellCsv: string[] = []
  const expectedArms = manifest.arms.map((arm) => arm.id)
  for (const cell of manifest.cells) {
    const csvPath = join(outputDirectory, 'cells', `${cell.id}.csv`)
    const metadataPath = join(outputDirectory, 'cells', `${cell.id}.json`)
    const [csv, metadataText] = await Promise.all([
      readFile(csvPath, 'utf8'),
      readFile(metadataPath, 'utf8'),
    ])
    const metadata = JSON.parse(metadataText) as CellCompletionMetadata
    const rawRows = csv.trimEnd().split(/\r?\n/).slice(1).length
    if (
      metadata.schemaVersion !== BENCHMARK_SCHEMA_VERSION ||
      metadata.manifestSha256 !== manifestSha256 ||
      metadata.implementationSha256 !== implementation.implementationSha256 ||
      metadata.runtimeFingerprint !== runtimeRecord.runtimeFingerprint ||
      metadata.cellId !== cell.id ||
      metadata.cellFingerprint !== headlessCellFingerprint(cell, manifest.arms) ||
      metadata.complete !== true ||
      !sameStrings(metadata.methodArms, expectedArms) ||
      metadata.rawRows !== rawRows ||
      metadata.artifactSha256 !== sha256(csv) ||
      metadata.scientificSha256 !== scientificCsvSha256(csv)
    ) {
      throw new Error(`${cell.id}: missing, altered, or incompatible completion artifact`)
    }
    cellCsv.push(csv)
  }

  const rawRows = cellCsv.flatMap((csv) => csv.trimEnd().split(/\r?\n/).slice(1))
  const header = cellCsv[0]?.trimEnd().split(/\r?\n/)[0]
  if (!header) throw new Error('No cell rows are available for finalization')
  const combinedCsv = `${header}\n${rawRows.join('\n')}\n`
  const parsedRows = parseHeadlessResultsCsv(combinedCsv)
  validateRowsAgainstManifest(parsedRows, manifest, manifestSha256)

  const analysis = analyzeHeadlessRows(parsedRows, { includePartitions: ['development'] })
  const analysisJson = stableJson(analysis)
  const comparisonsCsv = headlessAnalysisToCsv(analysis)
  const rawResultsSha256 = sha256(combinedCsv)
  const scientificResultsSha256 = scientificCsvSha256(combinedCsv)
  const analysisSha256 = sha256(analysisJson)
  const comparisonsSha256 = sha256(comparisonsCsv)
  const finalizerPath = fileURLToPath(import.meta.url)
  const finalizerSource = await readFile(finalizerPath, 'utf8')
  const finalizerSha256 = sha256(finalizerSource)
  const finalizerSnapshotName = 'finalizer-source.ts'

  await atomicWrite(join(outputDirectory, 'raw-results.csv'), combinedCsv)
  await atomicWrite(join(outputDirectory, 'analysis.json'), analysisJson)
  await atomicWrite(join(outputDirectory, 'comparisons.csv'), comparisonsCsv)
  await atomicWrite(join(outputDirectory, finalizerSnapshotName), finalizerSource)

  const metadataJson = stableJson({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    manifestSha256,
    implementationSha256: implementation.implementationSha256,
    runtimeFingerprint: runtimeRecord.runtimeFingerprint,
    profile: manifest.profile,
    complete: true,
    plannedSimulationRuns: manifest.cells.length * manifest.arms.length,
    rawResultRows: rawRows.length,
    rawResultsSha256,
    scientificProjectionSchemaVersion: 'headless-scientific-projection-v1',
    scientificResultsSha256,
    analysisSha256,
    comparisonsSha256,
    analysisPartitions: ['development'],
    inferentialPartition: null,
    claimBoundary:
      'development-only controller diagnostic; exploratory estimates only; no validation, test, superiority, or deployment inference',
    finalizationMode: 'development-only-recovery-v1',
    finalizerSource: finalizerSnapshotName,
    finalizerSha256,
    mergeOrder: 'manifest cell, manifest arm, manifest checkpoint',
  })
  await atomicWrite(join(outputDirectory, 'metadata.json'), metadataJson)

  const inventory: Array<{ path: string; bytes: number; sha256: string }> = []
  const add = (path: string, contents: string) => inventory.push({
    path,
    bytes: Buffer.byteLength(contents),
    sha256: sha256(contents),
  })
  add('manifest.json', manifestText)
  add('runtime.json', runtimeText)
  add('implementation.json', implementationText)
  add('metadata.json', metadataJson)
  add('raw-results.csv', combinedCsv)
  add('analysis.json', analysisJson)
  add('comparisons.csv', comparisonsCsv)
  add(finalizerSnapshotName, finalizerSource)
  for (let index = 0; index < manifest.cells.length; index += 1) {
    const cell = manifest.cells[index]!
    add(`cells/${cell.id}.csv`, cellCsv[index]!)
    add(
      `cells/${cell.id}.json`,
      await readFile(join(outputDirectory, 'cells', `${cell.id}.json`), 'utf8'),
    )
  }
  const checksumsJson = stableJson({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    manifestSha256,
    rawResultsSha256,
    scientificResultsSha256,
    analysisSha256,
    comparisonsSha256,
    metadataSha256: sha256(metadataJson),
    finalizerSha256,
    coreArtifactInventory: inventory,
    coreArtifactInventorySha256: digest(inventory),
    inventoryBoundary:
      'deterministic scientific core plus recovery-finalizer source; append-only execution records excluded',
  })
  await atomicWrite(join(outputDirectory, 'checksums.json'), checksumsJson)

  const finalizationRecord = stableJson({
    schemaVersion: 'headless-development-finalization-v1',
    status: 'complete',
    completedAtUtc: new Date().toISOString(),
    outputDirectory,
    manifestSha256,
    implementationSha256: implementation.implementationSha256,
    runtimeFingerprint: runtimeRecord.runtimeFingerprint,
    completedCells: manifest.cells.length,
    rawResultRows: rawRows.length,
    rawResultsSha256,
    scientificResultsSha256,
    analysisSha256,
    comparisonsSha256,
    finalizerSha256,
  })
  await atomicWrite(
    join(outputDirectory, 'executions', 'development-finalization.json'),
    finalizationRecord,
  )

  return {
    status: 'complete',
    outputDirectory,
    profile: manifest.profile,
    completedCells: manifest.cells.length,
    rawResultRows: rawRows.length,
    manifestSha256,
    implementationSha256: implementation.implementationSha256,
    scientificResultsSha256,
    rawResultsSha256,
    analysisSha256,
    comparisonsSha256,
    finalizerSha256,
  }
}

export const verifyDevelopmentBenchmark = async (outputDirectory: string) => {
  const root = resolve(outputDirectory)
  const checksumsText = await readFile(join(root, 'checksums.json'), 'utf8')
  const checksums = JSON.parse(checksumsText) as {
    schemaVersion?: string
    manifestSha256?: string
    rawResultsSha256?: string
    scientificResultsSha256?: string
    analysisSha256?: string
    comparisonsSha256?: string
    metadataSha256?: string
    finalizerSha256?: string
    coreArtifactInventory?: Array<{ path: string; bytes: number; sha256: string }>
    coreArtifactInventorySha256?: string
  }
  if (
    checksums.schemaVersion !== BENCHMARK_SCHEMA_VERSION ||
    !checksums.coreArtifactInventory ||
    digest(checksums.coreArtifactInventory) !== checksums.coreArtifactInventorySha256
  ) {
    throw new Error('Checksum inventory structure or digest is invalid')
  }
  const paths = new Set<string>()
  for (const entry of checksums.coreArtifactInventory) {
    if (isAbsolute(entry.path) || paths.has(entry.path)) {
      throw new Error(`Unsafe or duplicate inventory path: ${entry.path}`)
    }
    paths.add(entry.path)
    const target = resolve(root, entry.path)
    if (target !== root && !target.startsWith(`${root}/`)) {
      throw new Error(`Inventory path escapes output directory: ${entry.path}`)
    }
    const contents = await readFile(target)
    if (contents.byteLength !== entry.bytes || sha256(contents) !== entry.sha256) {
      throw new Error(`Artifact checksum mismatch: ${entry.path}`)
    }
  }
  const required = [
    'manifest.json',
    'runtime.json',
    'implementation.json',
    'metadata.json',
    'raw-results.csv',
    'analysis.json',
    'comparisons.csv',
    'finalizer-source.ts',
  ]
  for (const path of required) {
    if (!paths.has(path)) throw new Error(`Required artifact missing from inventory: ${path}`)
  }
  const metadataText = await readFile(join(root, 'metadata.json'), 'utf8')
  const metadata = JSON.parse(metadataText) as Record<string, unknown>
  if (
    sha256(metadataText) !== checksums.metadataSha256 ||
    metadata.manifestSha256 !== checksums.manifestSha256 ||
    metadata.rawResultsSha256 !== checksums.rawResultsSha256 ||
    metadata.scientificResultsSha256 !== checksums.scientificResultsSha256 ||
    metadata.analysisSha256 !== checksums.analysisSha256 ||
    metadata.comparisonsSha256 !== checksums.comparisonsSha256 ||
    metadata.finalizerSha256 !== checksums.finalizerSha256 ||
    metadata.complete !== true ||
    metadata.inferentialPartition !== null
  ) {
    throw new Error('Metadata and checksum summary do not agree')
  }
  return {
    status: 'verified',
    outputDirectory: root,
    inventoryEntries: checksums.coreArtifactInventory.length,
    coreArtifactInventorySha256: checksums.coreArtifactInventorySha256,
    manifestSha256: checksums.manifestSha256,
    scientificResultsSha256: checksums.scientificResultsSha256,
    rawResultsSha256: checksums.rawResultsSha256,
    analysisSha256: checksums.analysisSha256,
    comparisonsSha256: checksums.comparisonsSha256,
    finalizerSha256: checksums.finalizerSha256,
  }
}

const sourcePath = fileURLToPath(import.meta.url)
const scriptArgumentIndex = process.argv.findIndex((argument) => resolve(argument) === sourcePath)
if (scriptArgumentIndex >= 0) {
  const command = process.argv[scriptArgumentIndex + 1]
  const verifyOnly = command === '--verify'
  const outputDirectory = process.argv[scriptArgumentIndex + (verifyOnly ? 2 : 1)]
  if (!outputDirectory) {
    throw new Error(
      `Usage: ${basename(sourcePath)} [--verify] <completed-development-output-directory>`,
    )
  }
  const action = verifyOnly ? verifyDevelopmentBenchmark : finalizeDevelopmentBenchmark
  action(resolve(outputDirectory))
    .then((summary) => process.stdout.write(stableJson(summary)))
    .catch((error) => {
      process.stderr.write(
        `Development finalization failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 1
    })
}
