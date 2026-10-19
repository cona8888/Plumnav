import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildM71Manifest, M71_ALGORITHMS, M71_REPLICATES, m71Sha256, type M71SoilCase } from './lib/m71-campaign-design'
import { SIMULATOR_VERSION } from '../src/sim/config'
import type { BatchResult } from '../src/sim/types'

const output = resolve(process.argv[2] ?? '/opt/ml/processing/output')
const contractPath = resolve(process.argv[3] ?? 'research/protocols/m60_soil_regimes/soil-regime-contract.json')
const contract = JSON.parse(await readFile(contractPath, 'utf8')) as { cases: M71SoilCase[] }
const expected = buildM71Manifest(contract.cases, SIMULATOR_VERSION)
const names = (await readdir(output)).filter((name) => /^part-\d{3}-of-\d{3}$/.test(name)).sort()
if (!names.length) throw new Error('No M71 shard directories found')
const seenCells = new Set<number>()
const seenRuns = new Set<string>()
let totalRuns = 0
let mode: string | null = null
for (const name of names) {
  const root = resolve(output, name)
  const completion = JSON.parse(await readFile(resolve(root, 'complete.json'), 'utf8')) as {
    complete: boolean; manifestSha256: string; mode: string; completedRuns: number
    inventory: Array<{ path: string; bytes: number; sha256: string; runs: number }>
  }
  if (!completion.complete || completion.manifestSha256 !== expected.manifestSha256) throw new Error(`Invalid completion marker: ${name}`)
  mode ??= completion.mode
  if (mode !== completion.mode) throw new Error('Mixed smoke/production outputs')
  let shardRuns = 0
  for (const item of completion.inventory) {
    const bytes = await readFile(resolve(root, item.path))
    if (bytes.length !== item.bytes || m71Sha256(bytes) !== item.sha256) throw new Error(`Checksum mismatch: ${name}/${item.path}`)
    const payload = JSON.parse(bytes.toString()) as { cell: { index: number; id: string }; results: BatchResult[] }
    if (seenCells.has(payload.cell.index)) throw new Error(`Duplicate cell index ${payload.cell.index}`)
    seenCells.add(payload.cell.index)
    if (expected.cells[payload.cell.index]?.id !== payload.cell.id) throw new Error(`Cell identity mismatch ${payload.cell.index}`)
    if (payload.results.length !== item.runs) throw new Error(`Run count mismatch ${payload.cell.index}`)
    for (const result of payload.results) {
      const key = `${payload.cell.index}|${result.algorithmId}|${result.seed}`
      if (seenRuns.has(key)) throw new Error(`Duplicate paired-run key ${key}`)
      seenRuns.add(key)
      if (!M71_ALGORITHMS.includes(result.algorithmId)) throw new Error(`Unexpected algorithm ${result.algorithmId}`)
    }
    shardRuns += payload.results.length
  }
  if (shardRuns !== completion.completedRuns) throw new Error(`Shard total mismatch: ${name}`)
  totalRuns += shardRuns
}
const expectedCells = mode === 'production' ? expected.cells.length : 6
const expectedRuns = expectedCells * M71_ALGORITHMS.length * (mode === 'production' ? M71_REPLICATES : 1)
if (seenCells.size !== expectedCells || totalRuns !== expectedRuns) throw new Error('Global cell/run count mismatch')
process.stdout.write(`${JSON.stringify({ complete: true, mode, shards: names.length, cells: seenCells.size, runs: totalRuns, manifestSha256: expected.manifestSha256 }, null, 2)}\n`)
