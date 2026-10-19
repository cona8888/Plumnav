/**
 * Isolated six-worker-capable executor for the frozen Phase 2 development
 * pilot.  This module has no analysis and never rewrites the source manifest.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { batchResultsToCsv, runBatch } from '../src/sim/batch'
import { createPhase2PilotManifest, phase2PilotSha256, type Phase2PilotCell, type Phase2PilotManifest } from './phase2-pilot-manifest'
import type { BatchResult, SimulationConfig } from '../src/sim/types'

export const PHASE2_SHARDED_SCHEMA_VERSION = 'phase2-development-pilot-sharded-v1'
const PROJECTION_VERSION = 'phase2-development-pilot-scientific-projection-v1'
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const frozenManifestPath = join(projectRoot, 'research', 'protocols', 'phase2_development_pilot', 'phase2-pilot-manifest.json')

export type Phase2ShardResult = { shardIndex: number; shardCount: number; assignedCells: number; completedCells: number; skippedCells: number }
export type Phase2PreparedPilot = { manifest: Phase2PilotManifest; manifestSha256: string; implementationSha256: string; implementation: ImplementationProvenance; runtime: RuntimeProvenance; runtimeFingerprint: string; outputDirectory: string }
export type Phase2Progress = { cellId: string; status: 'completed' | 'skipped' }
type RuntimeProvenance = { node: string; v8: string; platform: string; architecture: string; osRelease: string; cpuModel: string }
type ImplementationProvenance = { schemaVersion: 'phase2-sharded-implementation-v1'; files: Array<{ path: string; bytes: number; sha256: string }>; implementationSha256: string }
type Completion = { schemaVersion: typeof PHASE2_SHARDED_SCHEMA_VERSION; complete: true; manifestSha256: string; implementationSha256: string; runtimeFingerprint: string; cellId: string; cellFingerprint: string; artifactSha256: string; scientificSha256: string; rawRows: number }

const canonicalize = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalize(v)])) : value
const stableJson = (value: unknown) => `${JSON.stringify(canonicalize(value), null, 2)}\n`
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const atomicWrite = async (path: string, contents: string) => { const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`; try { await writeFile(tmp, contents, 'utf8'); await rename(tmp, path) } catch (error) { await unlink(tmp).catch(() => undefined); throw error } }
const cloneConfig = (config: SimulationConfig): SimulationConfig => ({ ...config, checkpointSeconds: [...config.checkpointSeconds], sourcePositionOverride: config.sourcePositionOverride && { ...config.sourcePositionOverride }, robotStartPositionOverride: config.robotStartPositionOverride && { ...config.robotStartPositionOverride } })
const withoutDigest = (value: Record<string, unknown>) => { const { manifestSha256: _ignored, ...manifest } = value; return manifest }

export const selectPhase2Shard = <T>(cells: readonly T[], index: number, count: number) => {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) throw new RangeError('Invalid Phase 2 shard index/count')
  return cells.filter((_, position) => position % count === index)
}
const cellFingerprint = (cell: Phase2PilotCell) => phase2PilotSha256({ schemaVersion: PHASE2_SHARDED_SCHEMA_VERSION, cell })
const runtime = (): RuntimeProvenance => ({ node: process.versions.node, v8: process.versions.v8, platform: platform(), architecture: arch(), osRelease: release(), cpuModel: cpus()[0]?.model ?? 'unknown' })
const implementationFiles = async (directory: string): Promise<string[]> => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry => { const path = join(directory, entry.name); return entry.isDirectory() ? implementationFiles(path) : [path] }))).flat()
const implementation = async (): Promise<ImplementationProvenance> => {
  const paths = [...await implementationFiles(join(projectRoot, 'src', 'sim')), frozenManifestPath, join(projectRoot, 'scripts', 'phase2-pilot-manifest.ts'), join(projectRoot, 'scripts', 'phase2-sharded-pilot.ts'), join(projectRoot, 'scripts', 'local-phase2-pilot.ts'), join(projectRoot, 'package.json'), join(projectRoot, 'pnpm-lock.yaml'), join(projectRoot, 'pnpm-workspace.yaml'), join(projectRoot, 'tsconfig.json'), join(projectRoot, 'tsconfig.app.json'), join(projectRoot, 'tsconfig.node.json'), join(projectRoot, 'vite.config.ts')].sort()
  const digest = createHash('sha256'); const files: ImplementationProvenance['files'] = []
  for (const path of paths) { try { const bytes = await readFile(path); const relative = path.slice(projectRoot.length); digest.update(relative); digest.update('\0'); digest.update(bytes); digest.update('\0'); files.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
  return { schemaVersion: 'phase2-sharded-implementation-v1', files, implementationSha256: digest.digest('hex') }
}
const context = async (outputDirectory: string): Promise<Phase2PreparedPilot> => { const manifest = createPhase2PilotManifest(); const impl = await implementation(); const rt = runtime(); return { manifest, manifestSha256: phase2PilotSha256(manifest), implementationSha256: impl.implementationSha256, implementation: impl, runtime: rt, runtimeFingerprint: phase2PilotSha256(rt), outputDirectory } }
const validateFrozenManifest = async (manifest: Phase2PilotManifest, digest: string) => { if (manifest.schemaVersion !== createPhase2PilotManifest().schemaVersion || digest !== phase2PilotSha256(manifest) || manifest.cells.length !== 80 || !manifest.cells.every(cell => cell.partition === 'development' && cell.config.targetStatus === 'emitting')) throw new Error('Invalid frozen Phase 2 manifest') }
const assertContext = async (ctx: Phase2PreparedPilot) => { const recorded = JSON.parse(await readFile(join(ctx.outputDirectory, 'manifest.json'), 'utf8')) as Record<string, unknown>; const digest = recorded.manifestSha256; const supplied = withoutDigest(recorded); if (digest !== ctx.manifestSha256 || phase2PilotSha256(supplied) !== ctx.manifestSha256 || stableJson(supplied) !== stableJson(ctx.manifest)) throw new Error('Recorded Phase 2 manifest differs from frozen source'); if ((await readFile(join(ctx.outputDirectory, 'runtime.json'), 'utf8')) !== stableJson({ schemaVersion: 'phase2-sharded-runtime-v1', runtime: ctx.runtime, runtimeFingerprint: ctx.runtimeFingerprint })) throw new Error('Recorded Phase 2 runtime differs from this process'); if ((await readFile(join(ctx.outputDirectory, 'implementation.json'), 'utf8')) !== stableJson(ctx.implementation)) throw new Error('Recorded Phase 2 implementation inventory differs from current source') }

export const preparePhase2ShardedPilot = async (outputDirectory: string, resume = false) => {
  const ctx = await context(outputDirectory); const source = JSON.parse(await readFile(frozenManifestPath, 'utf8')) as Record<string, unknown>; const supplied = withoutDigest(source); const suppliedDigest = phase2PilotSha256(supplied); await validateFrozenManifest(ctx.manifest, suppliedDigest); if (source.manifestSha256 !== suppliedDigest) throw new Error('Frozen Phase 2 manifest embedded SHA-256 does not match canonical contents'); if (stableJson(supplied) !== stableJson(ctx.manifest)) throw new Error('Frozen Phase 2 manifest differs from the canonical generated design')
  await mkdir(outputDirectory, { recursive: true }); const existing = await readFile(join(outputDirectory, 'manifest.json'), 'utf8').catch(() => null)
  if (existing) { if (!resume) throw new Error('Phase 2 sharded output exists; pass resume to reuse it'); await assertContext(ctx) } else { const entries = (await readdir(outputDirectory)).filter(entry => entry !== '.plumenav-phase2-coordinator.lock'); if (entries.length) throw new Error(`Refusing non-empty Phase 2 output: ${entries.join(', ')}`); await atomicWrite(join(outputDirectory, 'manifest.json'), stableJson({ ...ctx.manifest, manifestSha256: ctx.manifestSha256 })); await atomicWrite(join(outputDirectory, 'runtime.json'), stableJson({ schemaVersion: 'phase2-sharded-runtime-v1', runtime: ctx.runtime, runtimeFingerprint: ctx.runtimeFingerprint })); await atomicWrite(join(outputDirectory, 'implementation.json'), stableJson(ctx.implementation)) }
  await mkdir(join(outputDirectory, 'cells'), { recursive: true }); return ctx
}
const load = async (outputDirectory: string) => { const ctx = await context(outputDirectory); await assertContext(ctx); return ctx }
const header = () => `manifest_sha256,partition,scenario_id,cell_id,orientation_bin,replicate,method_arm,${batchResultsToCsv([]).trimEnd()}`
const render = (cell: Phase2PilotCell, result: BatchResult, digest: string) => { const row = batchResultsToCsv([result]).split('\n')[1]; if (!row) throw new Error(`Could not render ${cell.id}`); return `${header()}\n${digest},${cell.partition},${cell.pairingKey},${cell.id},${cell.orientationBin},${cell.replicate},${cell.armId},${row}\n` }
export const phase2ScientificProjection = (csv: string) => { const lines = csv.trimEnd().split(/\r?\n/); const columns = lines[0]!.split(','); if (new Set(columns).size !== columns.length) throw new Error('Phase 2 CSV header contains duplicate columns'); const excluded = new Set(['mean_compute_ms', 'p95_compute_ms']); if ([...excluded].some(column => !columns.includes(column))) throw new Error('Missing scientific timing column'); const included = columns.map((column, index) => ({ column, index })).filter(item => !excluded.has(item.column)); return stableJson({ schemaVersion: PROJECTION_VERSION, columns: included.map(item => item.column), rows: lines.slice(1).filter(Boolean).map(line => { const values = line.split(','); if (values.length !== columns.length) throw new Error('Malformed Phase 2 CSV row'); return included.map(item => values[item.index]) }) }) }
const almostEqual = (first: number, second: number) => Math.abs(first - second) <= 1e-12
const csvMatchesCell = (csv: string, cell: Phase2PilotCell, manifestSha256: string) => {
  const lines = csv.trimEnd().split(/\r?\n/)
  if (lines.length !== 2 || lines[0] !== header()) return false
  const columns = lines[0]!.split(',')
  const values = lines[1]!.split(',')
  if (values.length !== columns.length || new Set(columns).size !== columns.length) return false
  const indexes = new Map(columns.map((column, index) => [column, index]))
  const value = (column: string) => { const index = indexes.get(column); return index === undefined ? undefined : values[index] }
  const config = cell.config
  if (!config.sourcePositionOverride || !config.robotStartPositionOverride) return false
  const numeric: Array<[string, number]> = [
    ['seed', config.seed], ['source_seed', config.sourceSeed], ['controller_seed', config.controllerSeed],
    ['controller_observation_model_seed', config.observationModelSeed],
    ['source_x_normalized', config.sourcePositionOverride.x], ['source_y_normalized', config.sourcePositionOverride.y],
    ['robot_start_x_normalized', config.robotStartPositionOverride.x], ['robot_start_y_normalized', config.robotStartPositionOverride.y],
    ['robot_start_heading_deg', config.robotStartHeadingDegrees ?? 0],
    ['obstacle_complexity_level', cell.scenarioKind === 'obstructed' ? config.obstacleComplexityLevel : 0],
    ['terrain_slope_deg', config.terrainSlopeDegrees], ['terrain_uphill_direction_deg', config.terrainUphillDirectionDegrees],
    ['terrain_gas_drift_scale', config.terrainGasDriftScale], ['robot_reference_grade_deg', config.robotSlopeLimitDegrees],
    ['checkpoint_s', 180], ['domain_side_m', config.domainMeters], ['duration_s', config.durationSeconds],
    ['stop_on_native_declaration', config.stopOnNativeDeclaration ? 1 : 0], ['fixed_dt_s', config.fixedDt],
    ['physics_step_s', cell.physics.requestedStepSeconds], ['effective_physics_step_s', cell.physics.effectiveStepSeconds],
    ['robot_speed_normalized_s', config.robotSpeed], ['sensor_noise', config.sensorNoise], ['sensor_lag_s', config.sensorLag],
    ['sensor_threshold_scale', config.sensorThresholdScale], ['sensor_saturation', config.sensorSaturation],
    ['sensor_false_positive_rate', config.sensorFalsePositiveRate], ['sensor_false_negative_rate', config.sensorFalseNegativeRate],
    ['quad_channel_noise_correlation', config.quadChannelNoiseCorrelation], ['quad_channel_gain_mismatch', config.quadChannelGainMismatch],
    ['quad_channel_crosstalk', config.quadChannelCrossTalk], ['quad_channel_lag_mismatch', config.quadChannelLagMismatch],
    ['wind_noise_rad', config.windNoise], ['active_sniff_enabled', config.activeSniffEnabled ? 1 : 0],
    ['active_sniff_strength', config.activeSniffStrength], ['active_sniff_reach_normalized', config.activeSniffReach],
    ['active_sniff_cycle_s', config.activeSniffCycleSeconds], ['grid_resolution', config.gridResolution],
    ['wind_direction_toward_deg', config.windDirectionDegrees], ['wind_speed_scale', config.windSpeedScale],
    ['turbulence_scale', config.turbulenceScale], ['gust_fraction_of_mean', config.gustStrength],
    ['diffusivity_scale', config.diffusivityScale], ['source_emission_rate_scale', config.emissionRateScale],
    ['effective_source_emission_rate_scale', config.emissionRateScale], ['success_threshold_normalized', config.successThreshold],
  ]
  return value('manifest_sha256') === manifestSha256 && value('partition') === cell.partition &&
    value('scenario_id') === cell.pairingKey && value('cell_id') === cell.id &&
    value('orientation_bin') === cell.orientationBin && value('replicate') === String(cell.replicate) &&
    value('method_arm') === cell.armId && value('algorithm') === config.algorithmId &&
    value('scenario') === cell.scenarioKind && value('target_status') === 'emitting' &&
    value('controller_observation_model_version') === cell.observationModelVersion &&
    value('placement_overridden') === '1' && value('gas_buoyancy_class') === config.gasBuoyancy &&
    value('physics_mode') === 'grid' && numeric.every(([column, expected]) => {
      const actual = value(column); return actual !== undefined && actual !== '' && almostEqual(Number(actual), expected)
    })
}
const validCell = async (ctx: Phase2PreparedPilot, cell: Phase2PilotCell) => { try { const csv = await readFile(join(ctx.outputDirectory, 'cells', `${cell.id}.csv`), 'utf8'); const meta = JSON.parse(await readFile(join(ctx.outputDirectory, 'cells', `${cell.id}.json`), 'utf8')) as Partial<Completion>; return csvMatchesCell(csv, cell, ctx.manifestSha256) && meta.schemaVersion === PHASE2_SHARDED_SCHEMA_VERSION && meta.complete === true && meta.manifestSha256 === ctx.manifestSha256 && meta.implementationSha256 === ctx.implementationSha256 && meta.runtimeFingerprint === ctx.runtimeFingerprint && meta.cellId === cell.id && meta.cellFingerprint === cellFingerprint(cell) && meta.rawRows === 1 && meta.artifactSha256 === sha256(csv) && meta.scientificSha256 === sha256(phase2ScientificProjection(csv)) } catch { return false } }
const validateResult = (cell: Phase2PilotCell, result: BatchResult) => { const config = cell.config; if (result.algorithmId !== config.algorithmId || result.scenarioKind !== cell.scenarioKind || result.seed !== config.seed || result.checkpointSeconds !== 180 || result.observationModelVersion !== cell.observationModelVersion || result.observationModelSeed !== config.observationModelSeed || result.metrics.targetStatus !== 'emitting' || result.effectivePhysicsStepSeconds !== cell.physics.effectiveStepSeconds || phase2PilotSha256(result.config) !== phase2PilotSha256(config)) throw new Error(`${cell.id}: result identity mismatch`) }
const defaultExecute = async (cell: Phase2PilotCell) => { const config = cloneConfig(cell.config); const batch = await runBatch(config, [config.algorithmId], [cell.scenarioKind], 1); return batch.results }

export const executePhase2ShardedPilotShard = async ({ outputDirectory, shardIndex, shardCount, onProgress, executeCell = defaultExecute }: { outputDirectory: string; shardIndex: number; shardCount: number; onProgress?: (event: Phase2Progress) => void; executeCell?: (cell: Phase2PilotCell) => Promise<BatchResult[]>; resume?: boolean }): Promise<Phase2ShardResult> => { const ctx = await load(outputDirectory); const assigned = selectPhase2Shard(ctx.manifest.cells, shardIndex, shardCount); let completedCells = 0; let skippedCells = 0; for (const cell of assigned) { if (await validCell(ctx, cell)) { skippedCells++; onProgress?.({ cellId: cell.id, status: 'skipped' }); continue } const results = await executeCell(cell); if (results.length !== 1) throw new Error(`${cell.id}: expected exactly one checkpoint result`); const result = results[0]!; validateResult(cell, result); const csv = render(cell, result, ctx.manifestSha256); if (!csvMatchesCell(csv, cell, ctx.manifestSha256)) throw new Error(`${cell.id}: rendered CSV does not match frozen cell`); await atomicWrite(join(outputDirectory, 'cells', `${cell.id}.csv`), csv); await atomicWrite(join(outputDirectory, 'cells', `${cell.id}.json`), stableJson({ schemaVersion: PHASE2_SHARDED_SCHEMA_VERSION, complete: true, manifestSha256: ctx.manifestSha256, implementationSha256: ctx.implementationSha256, runtimeFingerprint: ctx.runtimeFingerprint, cellId: cell.id, cellFingerprint: cellFingerprint(cell), artifactSha256: sha256(csv), scientificSha256: sha256(phase2ScientificProjection(csv)), rawRows: 1 } satisfies Completion)); completedCells++; onProgress?.({ cellId: cell.id, status: 'completed' }) } return { shardIndex, shardCount, assignedCells: assigned.length, completedCells, skippedCells } }

export const finalizePhase2ShardedPilot = async (outputDirectory: string, signal?: AbortSignal) => { const ctx = await load(outputDirectory); const rows: string[] = []; const cellCsv: string[] = []; for (const cell of ctx.manifest.cells) { if (signal?.aborted) throw signal.reason ?? new Error('Finalization aborted'); if (!(await validCell(ctx, cell))) throw new Error(`${cell.id}: invalid or missing completion; refusing partial finalization`); const csv = await readFile(join(outputDirectory, 'cells', `${cell.id}.csv`), 'utf8'); cellCsv.push(csv); rows.push(csv.trimEnd().split('\n')[1]!) } const raw = `${header()}\n${rows.join('\n')}\n`; const rawResultsSha256 = sha256(raw); const scientificResultsSha256 = sha256(phase2ScientificProjection(raw)); await atomicWrite(join(outputDirectory, 'raw-results.csv'), raw); const metadata = stableJson({ schemaVersion: PHASE2_SHARDED_SCHEMA_VERSION, complete: true, manifestSha256: ctx.manifestSha256, implementationSha256: ctx.implementationSha256, runtimeFingerprint: ctx.runtimeFingerprint, plannedCells: ctx.manifest.cells.length, rawResultRows: rows.length, rawResultsSha256, scientificProjectionVersion: PROJECTION_VERSION, scientificResultsSha256, mergeOrder: 'manifest cell order', claimBoundary: ctx.manifest.claimBoundary, timingBoundary: 'mean_compute_ms and p95_compute_ms are excluded only from scientific equivalence' }); await atomicWrite(join(outputDirectory, 'metadata.json'), metadata); const inventory: Array<{ path: string; bytes: number; sha256: string }> = []; const add = (path: string, contents: string) => inventory.push({ path, bytes: Buffer.byteLength(contents), sha256: sha256(contents) }); for (const path of ['manifest.json', 'runtime.json', 'implementation.json']) add(path, await readFile(join(outputDirectory, path), 'utf8')); add('metadata.json', metadata); add('raw-results.csv', raw); for (let index = 0; index < ctx.manifest.cells.length; index++) { const cell = ctx.manifest.cells[index]!; add(`cells/${cell.id}.csv`, cellCsv[index]!); add(`cells/${cell.id}.json`, await readFile(join(outputDirectory, 'cells', `${cell.id}.json`), 'utf8')) } await atomicWrite(join(outputDirectory, 'checksums.json'), stableJson({ schemaVersion: 'phase2-sharded-checksums-v1', manifestSha256: ctx.manifestSha256, rawResultsSha256, scientificResultsSha256, coreArtifactInventory: inventory, coreArtifactInventorySha256: phase2PilotSha256(inventory) })); return { manifestSha256: ctx.manifestSha256, rawResultsSha256, scientificResultsSha256, completedCells: ctx.manifest.cells.length, rawResultRows: rows.length } }
