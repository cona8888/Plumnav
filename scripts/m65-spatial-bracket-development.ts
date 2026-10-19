/** Frozen M65 new-seed emitting and no-emission development screen. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runBatch, batchResultsToCsv } from '../src/sim/batch'
import { createDefaultConfig, SIMULATOR_VERSION } from '../src/sim/config'
import { QUAD_BRACKET_POLICY } from '../src/sim/algorithms/quadSoilSniff'
import type { AlgorithmId, BatchResult, ScenarioKind, TargetStatus } from '../src/sim/types'

const algorithms: AlgorithmId[] = ['quad-sniff-wind', 'quad-sniff-bracket']
const scenarios: ScenarioKind[] = ['open', 'obstructed']
const replicates = 30
const output = resolve('research/evidence/m65_spatial_bracket_development_2026-09-12')
const contract = JSON.parse(await readFile(
  'research/protocols/m60_soil_regimes/soil-regime-contract.json', 'utf8',
)) as { cases: Array<{ case_id: string; emission_scale_relative_to_sand_sw_0p2: number }> }
const soils = contract.cases.filter(row =>
  row.case_id === 'sand-sw-0p2' || row.case_id === 'sand-sw-0p5')
const cells: Array<{ label: string; targetStatus: TargetStatus; emissionScale: number; scenario: ScenarioKind }> = []
for (const soil of soils) for (const scenario of scenarios) cells.push({
  label: soil.case_id, targetStatus: 'emitting',
  emissionScale: soil.emission_scale_relative_to_sand_sw_0p2, scenario,
})
for (const targetStatus of ['zero-emission', 'absent'] as const) for (const scenario of scenarios) {
  cells.push({ label: targetStatus, targetStatus, emissionScale: 1, scenario })
}
const records: Array<{ cellLabel: string; result: BatchResult }> = []
for (let block = 0; block < cells.length; block += 1) {
  const cell = cells[block]!
  const config = createDefaultConfig('quad-sniff-wind', cell.scenario)
  config.seed = 65_000_000 + block * 1_000_003
  config.sourceSeed = 65_000_017 + block * 1_000_033
  config.controllerSeed = 65_000_029 + block * 1_000_037
  config.observationModelSeed = 65_000_043 + block * 1_000_081
  config.targetStatus = cell.targetStatus
  config.emissionRateScale = cell.emissionScale
  config.checkpointSeconds = [180]
  config.stopOnNativeDeclaration = false
  const batch = await runBatch(config, algorithms, [cell.scenario], replicates)
  records.push(...batch.results.map(result => ({ cellLabel: cell.label, result })))
  process.stdout.write(`completed ${block + 1}/${cells.length}: ${cell.label}/${cell.scenario}\n`)
}
const groups = new Map<string, typeof records>()
for (const row of records) {
  const key = `${row.cellLabel}|${row.result.scenarioKind}|${row.result.algorithmId}`
  groups.set(key, [...(groups.get(key) ?? []), row])
}
const summary = [...groups.entries()].map(([key, rows]) => {
  const errors = rows.map(row => row.result.metrics.normalizedError)
    .filter((value): value is number => value !== null).sort((a, b) => a - b)
  return {
    key, targetStatus: rows[0]!.result.metrics.targetStatus, runs: rows.length,
    correctDeclarations: rows.filter(row => row.result.metrics.terminalOutcome === 'correct-declaration').length,
    wrongDeclarations: rows.filter(row => row.result.metrics.terminalOutcome === 'wrong-declaration').length,
    spuriousDeclarations: rows.filter(row => row.result.metrics.terminalOutcome === 'spurious-declaration').length,
    proximitySuccesses: rows.filter(row => row.result.metrics.success).length,
    medianError: errors.length ? errors[Math.floor(errors.length / 2)] : null,
    p90Error: errors.length ? errors[Math.floor((errors.length - 1) * 0.9)] : null,
    nativeAbstentions: rows.filter(row => row.result.metrics.nativeAbstention).length,
  }
})
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 'm65-spatial-bracket-development-v1', simulatorVersion: SIMULATOR_VERSION,
  protocol: 'research/protocols/m65_spatial_bracket_development_protocol.md',
  partition: 'development only; independent of M61-M64 seeds', algorithms,
  cells: cells.map(cell => ({ ...cell })), replicates, plannedRuns: records.length,
  seedBase: 65_000_000, bracketPolicy: QUAD_BRACKET_POLICY,
}, null, 2)}\n`)
await writeFile(resolve(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
const engineCsv = batchResultsToCsv(records.map(row => row.result))
const [header, ...lines] = engineCsv.split('\n')
await writeFile(resolve(output, 'results.csv'), `m65_cell,${header}\n${records.map((row, i) => `${row.cellLabel},${lines[i]}`).join('\n')}\n`)
process.stdout.write(`${JSON.stringify({ output, completedRuns: records.length })}\n`)
