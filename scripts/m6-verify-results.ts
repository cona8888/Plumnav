/** Independent structural, semantic, and cryptographic verifier for M6 output. */
import { createHash } from 'node:crypto'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { m6CalibrationSha256 } from './m6-calibration-manifest'
import { m6ScientificProjection } from './m6-sharded-calibration'

type InventoryEntry = { path: string; bytes: number; sha256: string }
type Checksums = {
  schemaVersion: string
  manifestSha256: string
  rawResultsSha256: string
  scientificResultsSha256: string
  coreArtifactInventory: InventoryEntry[]
  coreArtifactInventorySha256: string
}
type Metadata = {
  complete: boolean
  manifestSha256: string
  plannedCells: number
  plannedSimulationRuns: number
  rawResultRows: number
  rawResultsSha256: string
  scientificResultsSha256: string
}

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const stableJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message)
}
const finite = (value: string | undefined) => value !== undefined && value !== '' && Number.isFinite(Number(value))

export const verifyM6Results = async (directory: string) => {
  const checksums = JSON.parse(await readFile(join(directory, 'checksums.json'), 'utf8')) as Checksums
  const metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')) as Metadata
  assert(checksums.schemaVersion === 'm6-sharded-checksums-v1', 'Unexpected M6 checksum schema')
  assert(metadata.complete === true, 'M6 metadata is not complete')
  assert(metadata.plannedCells === 256 && metadata.plannedSimulationRuns === 1024 && metadata.rawResultRows === 1024,
    'M6 metadata dimensions are invalid')
  assert(checksums.coreArtifactInventory.length === 517, 'M6 core inventory must contain 517 artifacts')
  assert(new Set(checksums.coreArtifactInventory.map(({ path }) => path)).size === 517, 'M6 core inventory contains duplicate paths')
  assert(m6CalibrationSha256(checksums.coreArtifactInventory) === checksums.coreArtifactInventorySha256,
    'M6 core inventory digest mismatch')

  let verifiedBytes = 0
  for (const entry of checksums.coreArtifactInventory) {
    const path = join(directory, entry.path)
    const bytes = await readFile(path)
    const details = await stat(path)
    assert(details.isFile(), `${entry.path}: inventory target is not a file`)
    assert(bytes.byteLength === entry.bytes, `${entry.path}: byte count mismatch`)
    assert(sha256(bytes) === entry.sha256, `${entry.path}: SHA-256 mismatch`)
    verifiedBytes += bytes.byteLength
  }

  const raw = await readFile(join(directory, 'raw-results.csv'), 'utf8')
  assert(sha256(raw) === checksums.rawResultsSha256, 'Raw results checksum mismatch')
  assert(sha256(raw) === metadata.rawResultsSha256, 'Raw results metadata checksum mismatch')
  const scientificResultsSha256 = sha256(m6ScientificProjection(raw))
  assert(scientificResultsSha256 === checksums.scientificResultsSha256, 'Scientific projection checksum mismatch')
  assert(scientificResultsSha256 === metadata.scientificResultsSha256, 'Scientific projection metadata checksum mismatch')
  assert(checksums.manifestSha256 === metadata.manifestSha256, 'Manifest checksum differs between records')

  const lines = raw.trimEnd().split(/\r?\n/)
  assert(lines.length === 1025, `Expected 1,024 M6 data rows, found ${lines.length - 1}`)
  const header = lines[0]!.split(',')
  assert(new Set(header).size === header.length, 'M6 raw CSV contains duplicate columns')
  const indexes = new Map(header.map((column, index) => [column, index]))
  const required = [
    'cell_id', 'condition', 'method_arm', 'algorithm', 'target_status',
    'source_x_normalized', 'source_y_normalized', 'normalized_error',
    'direct_distance_path_overhead', 'terminal_outcome',
    'active_sniff_enabled', 'active_sniff_strength', 'quad_suction_energy_proxy',
    'quad_declaration_evaluations', 'quad_declaration_max_gates_passed',
  ]
  assert(required.every((column) => indexes.has(column)), 'M6 raw CSV is missing required semantic columns')
  const value = (row: string[], column: string) => row[indexes.get(column)!]
  const expectedArms = new Set(['quad-active', 'quad-passive', 'quad-zero-strength-sham', 'infotaxis'])
  const byCell = new Map<string, Set<string>>()
  const conditionCounts = { emitting: 0, absent: 0 }
  const armCounts = new Map<string, number>()
  let quadRows = 0
  let positiveActiveEnergyRows = 0
  for (const line of lines.slice(1)) {
    const row = line.split(',')
    assert(row.length === header.length, 'Malformed M6 CSV row width')
    const cellId = value(row, 'cell_id')!
    const condition = value(row, 'condition')!
    const arm = value(row, 'method_arm')!
    assert(condition === 'emitting' || condition === 'absent', `${cellId}: unexpected condition`)
    assert(value(row, 'target_status') === condition, `${cellId}/${arm}: target-status mismatch`)
    assert(expectedArms.has(arm), `${cellId}: unexpected method arm ${arm}`)
    conditionCounts[condition] += 1
    armCounts.set(arm, (armCounts.get(arm) ?? 0) + 1)
    const cellArms = byCell.get(cellId) ?? new Set<string>()
    assert(!cellArms.has(arm), `${cellId}: duplicate ${arm} row`)
    cellArms.add(arm)
    byCell.set(cellId, cellArms)

    if (condition === 'absent') {
      assert(value(row, 'source_x_normalized') === '' && value(row, 'source_y_normalized') === '',
        `${cellId}/${arm}: absent row exposes a source coordinate`)
      assert(value(row, 'normalized_error') === '' && value(row, 'direct_distance_path_overhead') === '',
        `${cellId}/${arm}: absent row contains truth-dependent localization metrics`)
      assert(['spurious-declaration', 'correct-abstention', 'correct-rejection-at-deadline'].includes(value(row, 'terminal_outcome')!),
        `${cellId}/${arm}: invalid absent terminal outcome`)
    } else {
      assert(finite(value(row, 'source_x_normalized')) && finite(value(row, 'source_y_normalized')),
        `${cellId}/${arm}: emitting row lacks a source coordinate`)
      assert(finite(value(row, 'normalized_error')) && finite(value(row, 'direct_distance_path_overhead')),
        `${cellId}/${arm}: emitting row lacks localization metrics`)
    }

    if (arm.startsWith('quad-')) {
      quadRows += 1
      assert(finite(value(row, 'quad_declaration_evaluations')) && finite(value(row, 'quad_declaration_max_gates_passed')),
        `${cellId}/${arm}: missing Quad declaration telemetry`)
    }
    if (arm === 'quad-active') {
      assert(value(row, 'algorithm') === 'quad-sniff' && value(row, 'active_sniff_enabled') === '1' &&
        value(row, 'active_sniff_strength') === '0.78', `${cellId}: active arm identity mismatch`)
      if (Number(value(row, 'quad_suction_energy_proxy')) > 0) positiveActiveEnergyRows += 1
    } else if (arm === 'quad-passive') {
      assert(value(row, 'algorithm') === 'quad-passive' && value(row, 'active_sniff_enabled') === '0' &&
        value(row, 'active_sniff_strength') === '0' && value(row, 'quad_suction_energy_proxy') === '0',
      `${cellId}: passive arm identity/energy mismatch`)
    } else if (arm === 'quad-zero-strength-sham') {
      assert(value(row, 'algorithm') === 'quad-sniff' && value(row, 'active_sniff_enabled') === '1' &&
        value(row, 'active_sniff_strength') === '0' && value(row, 'quad_suction_energy_proxy') === '0',
      `${cellId}: sham arm identity/energy mismatch`)
    } else {
      assert(value(row, 'algorithm') === 'infotaxis', `${cellId}: Infotaxis arm identity mismatch`)
    }
  }
  assert(byCell.size === 256 && [...byCell.values()].every((arms) => arms.size === 4), 'M6 cells do not each contain four unique arms')
  assert(conditionCounts.emitting === 512 && conditionCounts.absent === 512, 'M6 condition balance is invalid')
  assert([...expectedArms].every((arm) => armCounts.get(arm) === 256), 'M6 arm balance is invalid')
  assert(quadRows === 768, 'M6 Quad row count is invalid')
  assert(positiveActiveEnergyRows === 256, 'Not every active Quad row recorded positive suction energy')

  return {
    schemaVersion: 'm6-independent-verification-v1',
    verifiedAtUtc: new Date().toISOString(),
    directory: resolve(directory),
    verifiedCoreArtifacts: checksums.coreArtifactInventory.length,
    verifiedCoreBytes: verifiedBytes,
    cells: byCell.size,
    rows: lines.length - 1,
    conditionCounts,
    armCounts: Object.fromEntries([...armCounts].sort(([first], [second]) => first.localeCompare(second))),
    quadRows,
    positiveActiveEnergyRows,
    manifestSha256: checksums.manifestSha256,
    rawResultsSha256: checksums.rawResultsSha256,
    scientificResultsSha256,
    coreArtifactInventorySha256: checksums.coreArtifactInventorySha256,
    verified: true,
  }
}

const main = async () => {
  const directory = resolve(process.argv[2] ?? '/private/tmp/plumenav-m6-calibration-2026-09-02')
  const report = await verifyM6Results(directory)
  const outputPath = join(directory, 'independent-verification.json')
  const temporary = `${outputPath}.${process.pid}.tmp`
  await writeFile(temporary, stableJson(report), 'utf8')
  await rename(temporary, outputPath)
  process.stdout.write(stableJson(report))
}

if (process.env.M6_VERIFY_RUN === '1') {
  main().catch((error) => {
    process.stderr.write(`M6 verification failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
