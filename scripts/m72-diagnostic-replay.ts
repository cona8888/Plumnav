/** Small retrospective diagnostic selection. No tuning and no population inference. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import type { SimulationEngine } from '../src/sim/engine'
import type { BatchResult } from '../src/sim/types'
import { evaluateArchivedLeakRun } from '../src/sim/researchEvaluation'
import { compareScientificMetrics, recordResearchRun, summarizeResearchTrace } from './lib/research-recorder'

const root = resolve('research/results/m71-v7-output')
const output = resolve(process.argv[2] ?? 'research/evidence/m72_diagnostic_replay_2026-09-13')
const bundle = resolve('aws/bundles/plumenav-m71-locked-20260912-v3.tar.gz')
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const frozen = execFileSync('tar', ['-xOf', bundle, './plumenav-m71.mjs'], { maxBuffer: 8 * 1024 * 1024 }).toString()
const expectedFrozenHash = 'f1e6f6b6712e3c831433b2171d032c0892f55b491a15669f16fa088d442dcbbf'
if (sha(frozen) !== expectedFrozenHash) throw new Error('Frozen bundle hash mismatch')
// Remove ONLY the CLI tail, retain every engine/controller definition byte-for-byte.
const boundary = frozen.lastIndexOf('\n// scripts/m71-locked-campaign.ts\n')
if (boundary < 0 || !frozen.slice(boundary).includes('var valueAfter =')) throw new Error('Frozen CLI boundary not recognized')
const replayModule = frozen.slice(0, boundary) + '\nexport { SimulationEngine };\n'
const { SimulationEngine: FrozenEngine } = await import('data:text/javascript;base64,' + Buffer.from(replayModule).toString('base64')) as {
  SimulationEngine: typeof SimulationEngine
}
type Cell = { index: number; family: string; targetStatus: string }
type Selection = { reason: string; file: string; checksum: string; cell: Cell; run: BatchResult }
const candidate = (r: BatchResult) => r.algorithmId === 'quad-sniff-refine' && r.config.targetStatus === 'emitting'
const rules: Array<{ reason: string; test: (r: BatchResult, c: Cell) => boolean }> = [
  { reason: 'candidate-core-with-legacy-candidate-evaluation', test: (r, c) => c.family === 'core' && candidate(r) && r.metrics.quadDeclarationCandidateEvaluations > 0 },
  { reason: 'candidate-core-near-target-without-correct-declaration', test: (r, c) => c.family === 'core' && candidate(r) && r.metrics.success === true },
  { reason: 'candidate-core-contact-without-legacy-candidate', test: (r, c) => c.family === 'core' && candidate(r) && r.metrics.hitCount > 0 && r.metrics.quadDeclarationCandidateEvaluations === 0 },
  { reason: 'candidate-core-no-passive-contact', test: (r, c) => c.family === 'core' && candidate(r) && r.metrics.hitCount === 0 },
  { reason: 'candidate-obstacle-transfer', test: (r, c) => c.family === 'obstacle-transfer' && candidate(r) },
  { reason: 'candidate-slope-transfer', test: (r, c) => c.family === 'slope-transfer' && candidate(r) },
  { reason: 'infotaxis-inspired-correct-control', test: r => r.algorithmId === 'infotaxis' && r.metrics.terminalOutcome === 'correct-declaration' },
  { reason: 'coverage-zero-emission-declaration', test: r => r.algorithmId === 'coverage' && r.config.targetStatus === 'zero-emission' && r.metrics.nativeDeclaration },
  { reason: 'coverage-absent-declaration', test: r => r.algorithmId === 'coverage' && r.config.targetStatus === 'absent' && r.metrics.nativeDeclaration },
  { reason: 'candidate-zero-emission-abstention', test: r => r.algorithmId === 'quad-sniff-refine' && r.config.targetStatus === 'zero-emission' && r.metrics.nativeAbstention },
  { reason: 'candidate-absent-abstention', test: r => r.algorithmId === 'quad-sniff-refine' && r.config.targetStatus === 'absent' && r.metrics.nativeAbstention },
]
const cells: Array<{ file: string; checksum: string }> = []
for (const part of (await readdir(root)).filter(name => /^part-\d{3}-of-004$/.test(name)).sort()) {
  const completion = JSON.parse(await readFile(resolve(root, part, 'complete.json'), 'utf8'))
  if (!completion.complete || completion.manifestSha256 !== '4d480fb97a74c36ce310890275fdfa8d986462f89eb697b3391efc983946c464') {
    throw new Error('M71 production completion identity mismatch')
  }
  for (const item of completion.inventory) cells.push({ file: resolve(root, part, item.path), checksum: item.sha256 })
}
if (cells.length !== 280) throw new Error('Incomplete cell inventory')
cells.sort((a, b) => a.file.split('/').at(-1)!.localeCompare(b.file.split('/').at(-1)!))
const selected = new Map<string, Selection>()
for (const { file, checksum } of cells) {
  if (selected.size === rules.length) break
  const bytes = await readFile(file)
  if (sha(bytes) !== checksum) throw new Error(`Cell checksum mismatch: ${file}`)
  const { cell, results } = JSON.parse(bytes.toString()) as { cell: Cell; results: BatchResult[] }
  for (const rule of rules) {
    if (selected.has(rule.reason)) continue
    const run = [...results].sort((a, b) => a.seed - b.seed || a.algorithmId.localeCompare(b.algorithmId)).find(r => rule.test(r, cell))
    if (run) selected.set(rule.reason, { reason: rule.reason, file: relative(process.cwd(), file), checksum, cell, run })
  }
}
if (selected.size !== rules.length) throw new Error('A prespecified diagnostic category is empty')
await mkdir(output, { recursive: true })
const writeNew = async (file: string, value: unknown) => writeFile(resolve(output, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
await writeNew('manifest.json', {
  schemaVersion: 'm72-frozen-diagnostic-replay-v1', purpose: 'Retrospective mechanism diagnosis, not effect estimation',
  selectionRule: 'First matching cell index, then seed for each named predicate; overlapping runs allowed',
  rules: rules.map(r => ({ reason: r.reason, predicate: r.test.toString() })),
  frozenBundle: relative(process.cwd(), bundle), frozenEngineBundleSha256: sha(frozen),
  replayModuleSha256: sha(replayModule), transformation: 'Remove CLI tail; append engine export; no simulator edits',
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  archivedRuntime: { node: 'v20.19.6', platform: 'linux', architecture: 'x64' },
  runtimeCaveat: 'Frozen implementation; local runtime differs. Every retained scientific metric checked at relative/absolute tolerance 1e-10; exact equality reported separately.',
  scoring: 'New retrospective active-leak contract, no accepted rejection certificates. Original metrics retained.',
  inputs: [...selected.values()],
})
const summaries = []
for (const selection of selected.values()) {
  const engine = new FrozenEngine(selection.run.config)
  const { trace, frame } = recordResearchRun(engine)
  const metrics = frame.checkpoints[selection.run.checkpointSeconds]
  if (!metrics) throw new Error('Replay omitted checkpoint')
  const comparison = compareScientificMetrics(metrics, selection.run.metrics)
  const summary = { reason: selection.reason, cellIndex: selection.cell.index,
    algorithm: selection.run.algorithmId, seed: selection.run.seed, comparison,
    originalOutcome: selection.run.metrics.terminalOutcome,
    retrospectiveEvaluation: evaluateArchivedLeakRun(selection.run.config, metrics, frame.scenario.source),
    traceSummary: comparison.equivalent ? summarizeResearchTrace(trace) : null }
  await writeNew(`${selection.reason}.json`, { summary, originalMetrics: selection.run.metrics, replayMetrics: metrics, trace })
  summaries.push(summary)
  process.stdout.write(JSON.stringify(summary) + '\n')
  if (!comparison.equivalent) throw new Error('Scientific metric mismatch; diagnostic interpretation stopped')
}
await writeNew('summary.json', { complete: true, selectedDiagnostics: summaries.length,
  allScientificallyEquivalent: summaries.every(s => s.comparison.equivalent), summaries })
