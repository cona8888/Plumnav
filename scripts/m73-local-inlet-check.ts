/** Local commissioning only: legacy compatibility plus physical-mode execution.
 * No efficacy gate, tuning, field validation or AWS submission.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { SimulationEngine } from '../src/sim/engine'
import { createDefaultConfig } from '../src/sim/config'
import { withLocalInletDesign } from '../src/sim/localInletSampling'
import { GSL_REFERENCE_DESIGN } from '../src/sim/physicalDesign'
import { evaluateArchivedLeakRun } from '../src/sim/researchEvaluation'
import { compareScientificMetrics, recordResearchRun, summarizeResearchTrace } from './lib/research-recorder'
import type { BatchResult, SimulationConfig } from '../src/sim/types'

const output = resolve(process.argv[2] ?? 'research/evidence/m73_local_inlet_commissioning_2026-09-13')
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const previous = JSON.parse(await readFile('research/evidence/m72_diagnostic_replay_2026-09-13/manifest.json', 'utf8')) as {
  inputs: Array<{ reason: string; file: string; checksum: string; run: BatchResult }>
}
const configs: SimulationConfig[] = []
for (const algorithm of ['quad-sniff-refine', 'quad-passive'] as const) {
  for (const targetStatus of ['emitting', 'zero-emission'] as const) for (let replicate = 0; replicate < 2; replicate++) {
    configs.push(withLocalInletDesign({ ...createDefaultConfig(algorithm, 'open'),
      seed: 730000 + replicate, sourceSeed: 730010 + replicate,
      controllerSeed: 730020 + replicate, observationModelSeed: 730030 + replicate,
      targetStatus, durationSeconds: 120, checkpointSeconds: [120], stopOnNativeDeclaration: false,
      sourcePositionOverride: { x: 0.52, y: 0.5 }, robotStartPositionOverride: { x: 0.48, y: 0.5 },
    }, GSL_REFERENCE_DESIGN, { recoveryTimeConstantSeconds: 2, maximumTurnRateRadiansPerSecond: Math.PI / 4 }))
  }
}
await mkdir(output, { recursive: true })
const writeNew = async (name: string, data: unknown) => writeFile(resolve(output, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' })
const sourceFiles: string[] = ['scripts/m73-local-inlet-check.ts', 'scripts/lib/research-recorder.ts']
async function collect(dir: string) {
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${dir}/${item.name}`
    if (item.isDirectory()) await collect(file)
    else if (item.name.endsWith('.ts')) sourceFiles.push(file)
  }
}
await collect('src/sim')
const sourceInventory = []
for (const file of sourceFiles) {
  const bytes = await readFile(file)
  const destination = resolve(output, 'source-snapshot', file)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes, { flag: 'wx' })
  sourceInventory.push({ file, sha256: sha(bytes), bytes: bytes.length })
}
await writeNew('manifest.json', { schemaVersion: 'm73-local-inlet-commissioning-v1',
  scope: 'Numerical commissioning; 8 short paired runs are not a performance comparison',
  reference: 'Proposed physical design plus explicit 2 s recovery constant and pi/4 rad/s turn bound; not calibrated hardware',
  field: 'Existing unvalidated filament model, interpreted as a prescribed flat sensing slice; concentration scale remains normalized',
  resources: 'Same continuously extracted four-inlet head; no pump-induced SNR gain or active/passive hardware efficacy claim',
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  configs, legacySelection: previous.inputs.map(s => ({ reason: s.reason, file: s.file, checksum: s.checksum,
    algorithm: s.run.algorithmId, seed: s.run.seed })), sourceInventory })
const compatibility = []
for (const selection of previous.inputs) {
  if (sha(await readFile(selection.file)) !== selection.checksum) throw new Error('Archived M71 input checksum mismatch')
  const engine = new SimulationEngine(selection.run.config)
  while (!engine.isCompleted()) engine.step()
  const metrics = engine.getFrame().checkpoints[selection.run.checkpointSeconds]!
  const comparison = compareScientificMetrics(metrics, selection.run.metrics)
  compatibility.push({ reason: selection.reason, ...comparison })
  if (!comparison.exact) throw new Error(`Legacy scientific output changed: ${selection.reason}`)
}
await writeNew('legacy-compatibility.json', compatibility)
const runs = []
const inventory = []
for (const [index, config] of configs.entries()) {
  const engine = new SimulationEngine(config)
  const { trace, frame } = recordResearchRun(engine)
  const metrics = frame.checkpoints[120]!
  const evaluation = evaluateArchivedLeakRun(config, metrics, frame.scenario.source)
  if (!Number.isFinite(metrics.localSamplingAirLitres) || trace.some(r => r.measurement.valid &&
      Math.abs(r.measurement.time - Math.round(r.measurement.time)) > 1e-9)) throw new Error('Physical clock/resource check failed')
  const result = { index, algorithm: config.algorithmId, target: config.targetStatus, seed: config.seed,
    evaluation, localSamplingAirLitres: metrics.localSamplingAirLitres,
    passiveHits: metrics.hitCount, quadReturns: metrics.quadChannelReturns / 4,
    pathMetres: metrics.pathLengthMeters, traceSummary: summarizeResearchTrace(trace) }
  const filename = `run-${index}.json`
  await writeNew(filename, { config, metrics, result, trace })
  const bytes = await readFile(resolve(output, filename))
  inventory.push({ file: filename, bytes: bytes.length, sha256: sha(bytes) })
  runs.push(result)
  process.stdout.write(JSON.stringify({ index, algorithm: result.algorithm, target: result.target,
    outcome: evaluation.outcome, hits: result.passiveHits, quadReturns: result.quadReturns }) + '\n')
}
await writeNew('complete.json', { complete: true, exactLegacyReplays: compatibility.length,
  physicalCommissioningRuns: runs.length, runs, inventory,
  interpretation: 'Execution and contracts checked; no inference of superior performance or deployable capture' })
process.stdout.write(`Verified ${compatibility.length} exact legacy replays and ${runs.length} local-inlet commissioning runs.\n`)
