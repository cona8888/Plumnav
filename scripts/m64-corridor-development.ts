/** Pre-specified new-seed development comparison for the 2-D corridor belief. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runBatch, batchResultsToCsv } from '../src/sim/batch'
import { createDefaultConfig, SIMULATOR_VERSION } from '../src/sim/config'
import { QUAD_CORRIDOR_POLICY } from '../src/sim/algorithms/quadSoilSniff'
import type { AlgorithmId, BatchResult, ScenarioKind } from '../src/sim/types'

const algorithms: AlgorithmId[] = ['quad-sniff-wind', 'quad-sniff-corridor']
const scenarios: ScenarioKind[] = ['open', 'obstructed']
const replicates = 30
const output = resolve('research/evidence/m64_corridor_development_2026-09-12')
const contract = JSON.parse(await readFile(
  'research/protocols/m60_soil_regimes/soil-regime-contract.json', 'utf8',
)) as { cases: Array<{ case_id: string; emission_scale_relative_to_sand_sw_0p2: number }> }
const cases = contract.cases.filter(row =>
  row.case_id === 'sand-sw-0p2' || row.case_id === 'sand-sw-0p5')
const records: Array<{ soilCaseId: string; result: BatchResult }> = []
let block = 0
for (const soil of cases) for (const scenario of scenarios) {
  const config = createDefaultConfig('quad-sniff-wind', scenario)
  config.seed = 64_000_000 + block * 1_000_003
  config.sourceSeed = 64_000_017 + block * 1_000_033
  config.controllerSeed = 64_000_029 + block * 1_000_037
  config.observationModelSeed = 64_000_043 + block * 1_000_081
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
const summary = [...groups.entries()].map(([key, rows]) => {
  const errors = rows.map(row => row.result.metrics.normalizedError ?? Math.SQRT2).sort((a, b) => a - b)
  return {
    key, runs: rows.length,
    correctDeclarations: rows.filter(row => row.result.metrics.terminalOutcome === 'correct-declaration').length,
    wrongDeclarations: rows.filter(row => row.result.metrics.terminalOutcome === 'wrong-declaration').length,
    proximitySuccesses: rows.filter(row => row.result.metrics.success).length,
    medianError: errors[Math.floor(errors.length / 2)],
    p90Error: errors[Math.floor((errors.length - 1) * 0.9)],
    medianContacts: rows.map(row => row.result.metrics.contactEpisodes).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  }
})
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 'm64-corridor-development-v1', simulatorVersion: SIMULATOR_VERSION,
  protocol: 'research/protocols/m64_corridor_development_protocol.md',
  partition: 'development only; independent of M61-M63 seeds',
  hypothesis: 'a confidence-gated 2-D corridor posterior improves the bearing-only estimate',
  algorithms, cases: cases.map(row => row.case_id), scenarios, replicates,
  plannedRuns: records.length, seedBase: 64_000_000, corridorPolicy: QUAD_CORRIDOR_POLICY,
}, null, 2)}\n`)
await writeFile(resolve(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
const engineCsv = batchResultsToCsv(records.map(row => row.result))
const [header, ...lines] = engineCsv.split('\n')
await writeFile(resolve(output, 'results.csv'), `soil_case_id,${header}\n${records.map((row, i) => `${row.soilCaseId},${lines[i]}`).join('\n')}\n`)
process.stdout.write(`${JSON.stringify({ output, completedRuns: records.length })}\n`)
