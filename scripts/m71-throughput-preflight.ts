import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runBatch } from '../src/sim/batch'
import { createDefaultConfig, SIMULATOR_VERSION } from '../src/sim/config'
import type { AlgorithmId, ScenarioKind } from '../src/sim/types'

const algorithms: AlgorithmId[] = [
  'coverage',
  'surge-cast',
  'infotaxis',
  'smc-kl',
  'pmfs',
  'quad-passive',
  'quad-sniff-wind',
  'quad-sniff-refine',
]
const scenarios: ScenarioKind[] = ['open', 'obstructed']
const output = resolve('/private/tmp/plumenav-m71-throughput-preflight')
const rows: Array<{ algorithm: AlgorithmId; scenario: ScenarioKind; wallSeconds: number }> = []

for (const algorithm of algorithms) {
  for (const scenario of scenarios) {
    const config = createDefaultConfig(algorithm, scenario)
    config.seed = 71_000_000
    config.sourceSeed = 71_000_017
    config.controllerSeed = 71_000_029
    config.observationModelSeed = 71_000_043
    config.checkpointSeconds = [180]
    config.stopOnNativeDeclaration = false
    const started = performance.now()
    const result = await runBatch(config, [algorithm], [scenario], 1)
    const wallSeconds = (performance.now() - started) / 1_000
    if (result.results.length !== 1) throw new Error(`Unexpected result count for ${algorithm}/${scenario}`)
    rows.push({ algorithm, scenario, wallSeconds })
    process.stdout.write(`${algorithm}/${scenario}: ${wallSeconds.toFixed(3)} s\n`)
  }
}

const totalWallSeconds = rows.reduce((sum, row) => sum + row.wallSeconds, 0)
const report = {
  schemaVersion: 'm71-throughput-preflight-v1',
  simulatorVersion: SIMULATOR_VERSION,
  purpose: 'Local sizing witness only; not scientific evidence',
  machine: { platform: process.platform, architecture: process.arch, node: process.version },
  runs: rows.length,
  totalWallSeconds,
  meanWallSecondsPerRun: totalWallSeconds / rows.length,
  rows,
}
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'timing.json'), `${JSON.stringify(report, null, 2)}\n`)
