/** Paired diagnostic intervention on the exact eight M73 configurations. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { SimulationEngine } from '../src/sim/engine'
import { withBoundedPoseScans } from '../src/sim/localInletSampling'
import { evaluateArchivedLeakRun } from '../src/sim/researchEvaluation'
import { compareScientificMetrics, recordResearchRun, summarizeResearchTrace } from './lib/research-recorder'
import type { BatchResult, MetricSnapshot, SimulationConfig } from '../src/sim/types'

const sourceRoot = 'research/evidence/m73_local_inlet_commissioning_2026-09-13'
const output = resolve(process.argv[2] ?? 'research/evidence/m74_bounded_scan_diagnostic_2026-09-13')
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const originalManifest = JSON.parse(await readFile(`${sourceRoot}/manifest.json`, 'utf8')) as { configs: SimulationConfig[] }
const originalComplete = JSON.parse(await readFile(`${sourceRoot}/complete.json`, 'utf8')) as {
  inventory: Array<{ file: string; sha256: string }>
}
const legacy = JSON.parse(await readFile('research/evidence/m72_diagnostic_replay_2026-09-13/manifest.json', 'utf8')) as {
  inputs: Array<{ reason: string; file: string; checksum: string; run: BatchResult }>
}
const sources = []
for (const f of originalComplete.inventory) {
  const bytes = await readFile(`${sourceRoot}/${f.file}`)
  if (sha(bytes) !== f.sha256) throw new Error('M73 source checksum mismatch')
  sources.push(JSON.parse(bytes.toString()) as { config: SimulationConfig; metrics: MetricSnapshot })
}
if (sources.length !== 8) throw new Error('M73 diagnostic count mismatch')
const treatments = originalManifest.configs.map(withBoundedPoseScans)
await mkdir(output, { recursive: true })
const writeNew = (name: string, value: unknown) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const files = ['scripts/m74-bounded-scan-check.ts', 'scripts/lib/research-recorder.ts']
async function collect(dir: string) {
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${dir}/${item.name}`
    if (item.isDirectory()) await collect(file)
    else if (file.endsWith('.ts')) files.push(file)
  }
}
await collect('src/sim')
const sourceInventory = []
for (const file of files) {
  const bytes = await readFile(file), destination = resolve(output, 'source-snapshot', file)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes, { flag: 'wx' })
  sourceInventory.push({ file, sha256: sha(bytes), bytes: bytes.length })
}
await writeNew('manifest.json', { schemaVersion: 'm74-bounded-scan-diagnostic-v1', sourceRoot,
  selection: 'All eight pre-existing M73 runs; no screening for improved outcomes',
  intervention: 'Only opt-in bounded-pose-scans-v1. Unchanged sensing, noise, wind, source, random seeds, time budget and declaration thresholds.',
  scope: 'Implementation causality on these diagnostic worlds, not a population performance comparison',
  treatments, sourceInventory, sourceResultInventory: originalComplete.inventory,
  runtime: { node: process.version, platform: process.platform, architecture: process.arch } })
const compatibility = []
for (const selection of legacy.inputs) {
  if (sha(await readFile(selection.file)) !== selection.checksum) throw new Error('M71 checksum mismatch')
  const engine = new SimulationEngine(selection.run.config)
  while (!engine.isCompleted()) engine.step()
  const comparison = compareScientificMetrics(engine.getFrame().checkpoints[selection.run.checkpointSeconds]!, selection.run.metrics)
  compatibility.push({ stage: 'M71', reason: selection.reason, ...comparison })
  if (!comparison.exact) throw new Error('Legacy M71 metrics changed')
}
const pairs = [], inventory = []
for (const [index, source] of sources.entries()) {
  const control = new SimulationEngine(source.config)
  while (!control.isCompleted()) control.step()
  const comparison = compareScientificMetrics(control.getFrame().checkpoints[120]!, source.metrics)
  compatibility.push({ stage: 'M73', reason: `run-${index}`, ...comparison })
  if (!comparison.exact) throw new Error('Unbounded physical M73 metrics changed')
  const { trace, frame } = recordResearchRun(new SimulationEngine(treatments[index]!))
  const metrics = frame.checkpoints[120]!
  const evaluation = evaluateArchivedLeakRun(treatments[index]!, metrics, frame.scenario.source)
  const summary = summarizeResearchTrace(trace)
  const pair = { index, algorithm: source.config.algorithmId, targetStatus: source.config.targetStatus,
    control: { pathMetres: source.metrics.pathLengthMeters, quadReturns: source.metrics.quadChannelReturns / 4,
      nativeDeclaration: source.metrics.nativeDeclaration, airLitres: source.metrics.localSamplingAirLitres },
    bounded: { pathMetres: metrics.pathLengthMeters, quadReturns: metrics.quadChannelReturns / 4,
      airLitres: metrics.localSamplingAirLitres, evaluation, traceSummary: summary,
      candidateBearingEvaluations: metrics.quadDeclarationCandidateEvaluations,
      maximumGradientRayPool: metrics.quadCandidateMaxGradientRayPoolCount } }
  const file = `pair-${index}.json`
  await writeNew(file, { pair, controlConfig: source.config, treatmentConfig: treatments[index],
    controlMetrics: source.metrics, treatmentMetrics: metrics, trace })
  const bytes = await readFile(resolve(output, file))
  inventory.push({ file, sha256: sha(bytes), bytes: bytes.length })
  pairs.push(pair)
  process.stdout.write(JSON.stringify({ index, algorithm: pair.algorithm, target: pair.targetStatus,
    oldPath: pair.control.pathMetres, newPath: pair.bounded.pathMetres,
    result: evaluation.outcome, relocationTicks: summary.phaseTicks['BOUNDED PHYSICAL RELOCATION'] ?? 0,
    failedRelocationTicks: (summary.phaseTicks['PHYSICAL RELOCATION TIMEOUT'] ?? 0) + (summary.phaseTicks['PHYSICAL RELOCATION BLOCKED'] ?? 0),
    maxRays: pair.bounded.maximumGradientRayPool }) + '\n')
}
await writeNew('compatibility.json', compatibility)
await writeNew('complete.json', { complete: true, exactCompatibilityReplays: compatibility.length,
  pairedDiagnostics: pairs.length, pairs, inventory })
