/** Development-only comparison of the wind-constrained ray hypothesis. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runBatch, batchResultsToCsv } from '../src/sim/batch'
import { createDefaultConfig, SIMULATOR_VERSION } from '../src/sim/config'
import type { AlgorithmId, BatchResult, ScenarioKind } from '../src/sim/types'

const algorithms: AlgorithmId[] = ['quad-passive', 'quad-sniff', 'quad-sniff-wind']
const scenarios: ScenarioKind[] = ['open', 'obstructed']
const replicates = 30
const output = resolve('research/evidence/m62_wind_constrained_development_2026-09-12')
const contract = JSON.parse(await readFile(
  'research/protocols/m60_soil_regimes/soil-regime-contract.json', 'utf8',
)) as { cases: Array<{ case_id: string; emission_scale_relative_to_sand_sw_0p2: number }> }
const cases = contract.cases.filter(row =>
  row.case_id === 'sand-sw-0p2' || row.case_id === 'sand-sw-0p5')
const records: Array<{ soilCaseId: string; result: BatchResult }> = []
let block = 0
for (const soil of cases) for (const scenario of scenarios) {
  const config = createDefaultConfig('quad-sniff', scenario)
  config.seed = 6_200_000 + block * 1_000_003
  config.sourceSeed = 6_200_017 + block * 1_000_033
  config.controllerSeed = 6_200_029 + block * 1_000_037
  config.observationModelSeed = 6_200_043 + block * 1_000_081
  config.emissionRateScale = soil.emission_scale_relative_to_sand_sw_0p2
  config.checkpointSeconds = [180]
  config.stopOnNativeDeclaration = false
  const batch = await runBatch(config, algorithms, [scenario], replicates)
  records.push(...batch.results.map(result => ({ soilCaseId: soil.case_id, result })))
  block += 1
  process.stdout.write(`completed ${block}/4: ${soil.case_id}/${scenario}\n`)
}

const groups = new Map<string, typeof records>()
for (const row of records) {
  const key = `${row.soilCaseId}|${row.result.scenarioKind}|${row.result.algorithmId}`
  groups.set(key, [...(groups.get(key) ?? []), row])
}
const summary = [...groups.entries()].map(([key, rows]) => ({
  key,
  runs: rows.length,
  correctDeclarations: rows.filter(row => row.result.metrics.terminalOutcome === 'correct-declaration').length,
  wrongDeclarations: rows.filter(row => row.result.metrics.terminalOutcome === 'wrong-declaration').length,
  proximitySuccesses: rows.filter(row => row.result.metrics.success).length,
  medianError: [...rows].map(row => row.result.metrics.normalizedError ?? Math.SQRT2)
    .sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  medianContacts: [...rows].map(row => row.result.metrics.contactEpisodes)
    .sort((a, b) => a - b)[Math.floor(rows.length / 2)],
}))
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 'm62-wind-constrained-development-v1', simulatorVersion: SIMULATOR_VERSION,
  partition: 'development only; must not be combined with M61 locked inference',
  hypothesis: 'upwind plus crosswind-gradient source bearings outperform full-gradient rays',
  algorithms, cases: cases.map(row => row.case_id), scenarios, replicates, plannedRuns: records.length,
  seedBase: 6_200_000,
}, null, 2)}\n`)
await writeFile(resolve(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
const engineCsv = batchResultsToCsv(records.map(row => row.result))
const [header, ...lines] = engineCsv.split('\n')
await writeFile(resolve(output, 'results.csv'), `soil_case_id,${header}\n${records.map((row, i) => `${row.soilCaseId},${lines[i]}`).join('\n')}\n`)
process.stdout.write(`${JSON.stringify({ output, completedRuns: records.length })}\n`)
