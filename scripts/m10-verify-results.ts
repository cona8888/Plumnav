/** Independent structural, semantic, and cryptographic verifier for M10 output. */
import { createHash } from 'node:crypto'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { m10ManifestSha256, type M10Manifest } from './m10-geometry-development-manifest'
import { m10ScientificProjection } from './m10-sharded-development'

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
  implementationSha256: string
  runtimeFingerprint: string
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

export const verifyM10Results = async (directory: string) => {
  const checksums = JSON.parse(await readFile(join(directory, 'checksums.json'), 'utf8')) as Checksums
  const metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')) as Metadata
  assert(checksums.schemaVersion === 'm10-sharded-checksums-v1', 'Unexpected M10 checksum schema')
  assert(metadata.complete === true, 'M10 metadata is not complete')
  assert(metadata.plannedCells === 64 && metadata.plannedSimulationRuns === 256 && metadata.rawResultRows === 256,
    'M10 metadata dimensions are invalid')
  assert(checksums.manifestSha256 === '4500ca6f5df872fe31fb11df3e55d74ec0dcf0c1228ea0f7366bf4617bd8d681',
    'M10 manifest identity is not the frozen geometry-conditioned design')
  assert(checksums.coreArtifactInventory.length === 133, 'M10 core inventory must contain 133 artifacts')
  assert(new Set(checksums.coreArtifactInventory.map(({ path }) => path)).size === 133, 'M10 core inventory contains duplicate paths')
  assert(m10ManifestSha256(checksums.coreArtifactInventory) === checksums.coreArtifactInventorySha256,
    'M10 core inventory digest mismatch')

  const { manifestSha256, ...manifest } = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as
    M10Manifest & { manifestSha256: string }
  assert(manifestSha256 === checksums.manifestSha256 && m10ManifestSha256(manifest) === manifestSha256,
    'Stored manifest does not match its frozen semantic identity')
  const expectedPaths = new Set(['manifest.json', 'runtime.json', 'implementation.json', 'metadata.json', 'raw-results.csv',
    ...manifest.cells.flatMap((cell) => [`cells/${cell.id}.csv`, `cells/${cell.id}.json`])])
  assert(checksums.coreArtifactInventory.every((entry) => expectedPaths.has(entry.path)),
    'Core inventory contains a path outside the expected frozen artifact set')
  const implementation = JSON.parse(await readFile(join(directory, 'implementation.json'), 'utf8'))
  assert(implementation.implementationSha256 === '32f91bb29ff00426358c5cceb6bd21475a95524144b602ae8ba12a2fff17b1c4' &&
    metadata.implementationSha256 === implementation.implementationSha256,
  'M10 implementation differs from the outcome-free freeze')
  const runtime = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'))
  assert(runtime.runtimeFingerprint === metadata.runtimeFingerprint &&
    m10ManifestSha256(runtime.runtime) === runtime.runtimeFingerprint,
  'M10 runtime identity mismatch')

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
  const scientificResultsSha256 = sha256(m10ScientificProjection(raw))
  assert(scientificResultsSha256 === checksums.scientificResultsSha256, 'Scientific projection checksum mismatch')
  assert(scientificResultsSha256 === metadata.scientificResultsSha256, 'Scientific projection metadata checksum mismatch')
  assert(checksums.manifestSha256 === metadata.manifestSha256, 'Manifest checksum differs between records')

  const mergedRows: string[] = []
  for (const cell of manifest.cells) {
    const cellCsv = await readFile(join(directory, 'cells', `${cell.id}.csv`), 'utf8')
    const completion = JSON.parse(await readFile(join(directory, 'cells', `${cell.id}.json`), 'utf8'))
    assert(completion.complete === true && completion.rawRows === 4 && completion.cellId === cell.id &&
      completion.manifestSha256 === manifestSha256 &&
      completion.implementationSha256 === metadata.implementationSha256 &&
      completion.runtimeFingerprint === metadata.runtimeFingerprint &&
      completion.artifactSha256 === sha256(cellCsv) &&
      completion.scientificSha256 === sha256(m10ScientificProjection(cellCsv)),
    `${cell.id}: completion identity or artifact mismatch`)
    const cellLines = cellCsv.trimEnd().split(/\r?\n/)
    assert(cellLines[0] === raw.split('\n')[0] && cellLines.length === 5, `${cell.id}: cell CSV shape mismatch`)
    mergedRows.push(...cellLines.slice(1))
  }
  assert(`${raw.split('\n')[0]}\n${mergedRows.join('\n')}\n` === raw,
    'Merged raw results differ from the frozen cell/arm ordering')

  const lines = raw.trimEnd().split(/\r?\n/)
  assert(lines.length === 257, `Expected 256 M10 data rows, found ${lines.length - 1}`)
  const header = lines[0]!.split(',')
  assert(new Set(header).size === header.length, 'M10 raw CSV contains duplicate columns')
  const indexes = new Map(header.map((column, index) => [column, index]))
  const required = [
    'manifest_sha256', 'partition', 'cell_id', 'condition', 'method_arm', 'candidate_policy',
    'algorithm', 'target_status',
    'source_x_normalized', 'source_y_normalized', 'normalized_error',
    'direct_distance_path_overhead', 'terminal_outcome',
    'active_sniff_enabled', 'active_sniff_strength', 'quad_suction_energy_proxy',
    'native_declaration', 'false_declarations', 'spurious_declaration',
    'quad_declaration_evaluations', 'quad_declaration_max_gates_passed',
    'quad_declaration_gate_passes_candidate', 'quad_declaration_gate_passes_surface_count',
    'quad_declaration_gate_passes_passive_core_count', 'quad_declaration_gate_passes_passive_ring_count',
    'quad_candidate_formation_evaluations', 'quad_candidate_provisional_ray_evaluations',
    'quad_candidate_max_gradient_ray_pool_count', 'quad_candidate_max_provisional_ray_count',
    'quad_candidate_max_quality', 'quad_candidate_min_residual',
    'quad_candidate_max_surface_support', 'quad_candidate_best_failed_gates',
    'quad_candidate_gate_passes_provisional_ray', 'quad_candidate_gate_passes_ray_count',
    'quad_candidate_gate_passes_ray_quality', 'quad_candidate_gate_passes_ray_residual',
    'quad_candidate_gate_passes_surface_support', 'quad_candidate_best_trusted',
  ]
  assert(required.every((column) => indexes.has(column)), 'M10 raw CSV is missing required semantic columns')
  const value = (row: string[], column: string) => row[indexes.get(column)!]
  const expectedArms = new Set([
    'geometry-active', 'adaptive-active', 'geometry-passive', 'geometry-zero-strength-sham',
  ])
  const byCell = new Map<string, Set<string>>()
  const conditionCounts = { emitting: 0, absent: 0 }
  const armCounts = new Map<string, number>()
  let quadRows = 0
  let positiveActiveEnergyRows = 0
  let rowsWithFormationTelemetry = 0
  for (const line of lines.slice(1)) {
    const row = line.split(',')
    assert(row.length === header.length, 'Malformed M10 CSV row width')
    const cellId = value(row, 'cell_id')!
    const condition = value(row, 'condition')!
    const arm = value(row, 'method_arm')!
    const cell = manifest.cells.find((candidate) => candidate.id === cellId)
    assert(cell && cell.condition === condition, `${cellId}: cell is outside the frozen design`)
    assert(value(row, 'seed') === String(cell.config.seed) &&
      value(row, 'scenario') === cell.scenarioKind &&
      value(row, 'orientation_bin') === cell.orientationBin &&
      value(row, 'checkpoint_s') === '180' &&
      value(row, 'counterfactual_pairing_key') === cell.counterfactualPairingKey,
    `${cellId}/${arm}: world identity or budget mismatch`)
    assert(value(row, 'manifest_sha256') === checksums.manifestSha256, `${cellId}/${arm}: row manifest mismatch`)
    assert(value(row, 'partition') === 'development-verification', `${cellId}/${arm}: partition mismatch`)
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
      assert(Number(value(row, 'source_x_normalized')) === cell.config.sourcePositionOverride?.x &&
        Number(value(row, 'source_y_normalized')) === cell.config.sourcePositionOverride?.y,
      `${cellId}/${arm}: emitting source differs from the frozen world`)
      assert(finite(value(row, 'normalized_error')) && finite(value(row, 'direct_distance_path_overhead')),
        `${cellId}/${arm}: emitting row lacks localization metrics`)
    }

    quadRows += 1
    assert(finite(value(row, 'quad_declaration_evaluations')) &&
      finite(value(row, 'quad_declaration_max_gates_passed')) &&
      finite(value(row, 'quad_candidate_formation_evaluations')) &&
      finite(value(row, 'quad_candidate_provisional_ray_evaluations')),
    `${cellId}/${arm}: missing Quad declaration or candidate-formation telemetry`)
    const formationEvaluations = Number(value(row, 'quad_candidate_formation_evaluations'))
    assert(formationEvaluations > 0, `${cellId}/${arm}: no candidate-formation evaluations`)
    rowsWithFormationTelemetry += 1

    if (arm === 'geometry-active') {
      assert(value(row, 'algorithm') === 'quad-sniff' && value(row, 'active_sniff_enabled') === '1' &&
        value(row, 'active_sniff_strength') === '0.78' && value(row, 'candidate_policy') === 'geometry-conditioned',
      `${cellId}: geometry-active identity mismatch`)
      if (Number(value(row, 'quad_suction_energy_proxy')) > 0) positiveActiveEnergyRows += 1
    } else if (arm === 'adaptive-active') {
      assert(value(row, 'algorithm') === 'quad-sniff-adaptive' && value(row, 'active_sniff_enabled') === '1' &&
        value(row, 'active_sniff_strength') === '0.78' && value(row, 'candidate_policy') === 'adaptive-viewpoint',
      `${cellId}: adaptive-active identity mismatch`)
      if (Number(value(row, 'quad_suction_energy_proxy')) > 0) positiveActiveEnergyRows += 1
    } else if (arm === 'geometry-passive') {
      assert(value(row, 'algorithm') === 'quad-passive' && value(row, 'active_sniff_enabled') === '0' &&
        value(row, 'active_sniff_strength') === '0' && value(row, 'quad_suction_energy_proxy') === '0' &&
        value(row, 'candidate_policy') === 'geometry-conditioned',
      `${cellId}: passive arm identity/energy mismatch`)
    } else {
      assert(value(row, 'algorithm') === 'quad-sniff' && value(row, 'active_sniff_enabled') === '1' &&
        value(row, 'active_sniff_strength') === '0' && value(row, 'quad_suction_energy_proxy') === '0' &&
        value(row, 'candidate_policy') === 'geometry-conditioned',
      `${cellId}: sham arm identity/energy mismatch`)
    }
  }
  assert(byCell.size === 64 && [...byCell.values()].every((arms) => arms.size === 4), 'M10 cells do not each contain four unique arms')
  assert(conditionCounts.emitting === 128 && conditionCounts.absent === 128, 'M10 condition balance is invalid')
  assert([...expectedArms].every((arm) => armCounts.get(arm) === 64), 'M10 arm balance is invalid')
  assert(quadRows === 256, 'M10 Quad row count is invalid')
  assert(positiveActiveEnergyRows === 128, 'Not every active Quad row recorded positive suction energy')

  return {
    schemaVersion: 'm10-independent-verification-v1',
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
    rowsWithFormationTelemetry,
    manifestSha256: checksums.manifestSha256,
    rawResultsSha256: checksums.rawResultsSha256,
    scientificResultsSha256,
    coreArtifactInventorySha256: checksums.coreArtifactInventorySha256,
    verified: true,
  }
}

const main = async () => {
  const directory = resolve(process.argv[2] ?? '/private/tmp/plumenav-m10-geometry-development-2026-09-05')
  const report = await verifyM10Results(directory)
  const outputPath = join(directory, 'independent-verification.json')
  const temporary = `${outputPath}.${process.pid}.tmp`
  await writeFile(temporary, stableJson(report), 'utf8')
  await rename(temporary, outputPath)
  process.stdout.write(stableJson(report))
}

if (process.env.M10_VERIFY_RUN === '1') {
  main().catch((error) => {
    process.stderr.write(`M10 verification failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
