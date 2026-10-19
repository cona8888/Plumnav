import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runBatch } from '../src/sim/batch'
import { createDefaultConfig, SIMULATOR_VERSION } from '../src/sim/config'
import type { BatchResult } from '../src/sim/types'
import {
  buildM71Manifest, M71_ALGORITHMS, M71_REPLICATES, M71_SCHEMA_VERSION,
  M71_SEED_BASE, m71Sha256, m71StableJson, type M71SoilCase,
} from './lib/m71-campaign-design'

const valueAfter = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}
const output = resolve(valueAfter('--output', '/opt/ml/processing/output'))
const shardIndex = Number(valueAfter('--shard-index', '0'))
const shardCount = Number(valueAfter('--shard-count', '1'))
const mode = process.argv.includes('--smoke') ? 'smoke' : process.argv.includes('--dry-run') ? 'dry-run' : 'production'
if (!Number.isInteger(shardIndex) || !Number.isInteger(shardCount) || shardCount < 1 || shardIndex < 0 || shardIndex >= shardCount) {
  throw new RangeError('shard index/count are invalid')
}

const contractPath = resolve(valueAfter('--soil-contract', 'research/protocols/m60_soil_regimes/soil-regime-contract.json'))
const contractText = await readFile(contractPath, 'utf8')
const contract = JSON.parse(contractText) as { schema_version: string; cases: M71SoilCase[] }
if (contract.schema_version !== 'm60-homogeneous-soil-regimes-v1' || contract.cases.length !== 6) {
  throw new Error('M60 soil contract identity is invalid')
}
const manifest = buildM71Manifest(contract.cases, SIMULATOR_VERSION)
if (manifest.schemaVersion !== M71_SCHEMA_VERSION || manifest.design.cells !== 280 || manifest.design.plannedRuns !== 67_200) {
  throw new Error('M71 frozen design count changed')
}
const smokeIndices = [0, 143, 167, 231, 255, 279]
const selected = mode === 'smoke'
  ? manifest.cells.filter((cell) => {
    const smokePosition = smokeIndices.indexOf(cell.index)
    return smokePosition >= 0 && smokePosition % shardCount === shardIndex
  })
  : manifest.cells.filter((cell) => cell.index % shardCount === shardIndex)
const replicates = mode === 'smoke' ? 1 : M71_REPLICATES
const shardRoot = resolve(output, `part-${String(shardIndex).padStart(3, '0')}-of-${String(shardCount).padStart(3, '0')}`)
const cellsRoot = resolve(shardRoot, 'cells')
await mkdir(cellsRoot, { recursive: true })
await writeFile(resolve(shardRoot, 'manifest.json'), m71StableJson({
  ...manifest, soilContractSha256: m71Sha256(contractText), mode, shardIndex, shardCount,
  selectedCellIndices: selected.map((cell) => cell.index), replicates,
}), { flag: 'wx' })
if (mode === 'dry-run') process.exit(0)

const startedAt = new Date().toISOString()
const started = performance.now()
const inventory: Array<{ path: string; bytes: number; sha256: string; runs: number }> = []
let completedRuns = 0
for (const cell of selected) {
  const config = createDefaultConfig('coverage', cell.scenario)
  config.seed = M71_SEED_BASE + cell.index * 1_000_003
  config.sourceSeed = M71_SEED_BASE + 17 + cell.index * 1_000_033
  config.controllerSeed = M71_SEED_BASE + 29 + cell.index * 1_000_037
  config.observationModelSeed = M71_SEED_BASE + 43 + cell.index * 1_000_081
  config.targetStatus = cell.targetStatus
  config.windDirectionDegrees = cell.windDirectionDegrees
  config.sensorProfileId = 'custom'
  config.sensorNoise = cell.sensor.sensorNoise
  config.sensorLag = cell.sensor.sensorLagSeconds
  config.emissionRateScale = cell.emissionRateScale
  config.obstacleComplexityLevel = cell.obstacleComplexityLevel
  config.terrainSlopeDegrees = cell.terrainSlopeDegrees
  config.terrainUphillDirectionDegrees = cell.terrainUphillDirectionDegrees
  config.checkpointSeconds = [180]
  config.stopOnNativeDeclaration = false
  const batch = await runBatch(config, M71_ALGORITHMS, [cell.scenario], replicates)
  const payload: { cell: typeof cell; results: BatchResult[] } = { cell, results: batch.results }
  const bytes = Buffer.from(m71StableJson(payload))
  const filename = `${String(cell.index).padStart(3, '0')}__${cell.id}.json`
  const temporary = resolve(cellsRoot, `${filename}.partial`)
  const final = resolve(cellsRoot, filename)
  await writeFile(temporary, bytes, { flag: 'wx' })
  await rename(temporary, final)
  inventory.push({ path: `cells/${filename}`, bytes: bytes.length, sha256: m71Sha256(bytes), runs: batch.results.length })
  completedRuns += batch.results.length
  await writeFile(resolve(shardRoot, 'progress.json.partial'), m71StableJson({
    complete: false, completedCells: inventory.length, selectedCells: selected.length,
    completedRuns, lastCellIndex: cell.index, updatedAt: new Date().toISOString(),
  }))
  await rename(resolve(shardRoot, 'progress.json.partial'), resolve(shardRoot, 'progress.json'))
  process.stdout.write(`${shardIndex}/${shardCount}: ${inventory.length}/${selected.length} ${cell.id}\n`)
}
const completion = {
  complete: true, schemaVersion: M71_SCHEMA_VERSION, manifestSha256: manifest.manifestSha256,
  mode, shardIndex, shardCount, selectedCells: selected.length, completedCells: inventory.length,
  expectedRuns: selected.length * M71_ALGORITHMS.length * replicates, completedRuns,
  startedAt, completedAt: new Date().toISOString(), elapsedSeconds: (performance.now() - started) / 1_000,
  runtime: { node: process.version, platform: process.platform, architecture: process.arch }, inventory,
}
if (completion.completedRuns !== completion.expectedRuns) throw new Error('M71 shard run count mismatch')
await writeFile(resolve(shardRoot, 'complete.json'), m71StableJson(completion), { flag: 'wx' })
