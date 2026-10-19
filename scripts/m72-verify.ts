/** Read-only verification of the diagnostic archive, including all trace clocks. */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { compareScientificMetrics, summarizeResearchTrace, type ResearchTraceRow } from './lib/research-recorder'
import type { BatchResult, MetricSnapshot } from '../src/sim/types'

const root = resolve(process.argv[2] ?? 'research/evidence/m72_diagnostic_replay_2026-09-13')
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'))
const summary = JSON.parse(await readFile(resolve(root, 'summary.json'), 'utf8'))
if (!summary.complete || summary.selectedDiagnostics !== 11 || manifest.inputs.length !== 11) throw new Error('Incomplete diagnostics')
const inventory = []
let traceRows = 0
for (const selection of manifest.inputs as Array<{reason: string; file: string; checksum: string; run: BatchResult}>) {
  const original = await readFile(resolve(selection.file))
  if (sha(original) !== selection.checksum) throw new Error('Original M71 cell changed')
  const file = `${selection.reason}.json`
  const bytes = await readFile(resolve(root, file))
  const run = JSON.parse(bytes.toString()) as {
    originalMetrics: MetricSnapshot; replayMetrics: MetricSnapshot; trace: ResearchTraceRow[]
    summary: { reason: string; traceSummary: ReturnType<typeof summarizeResearchTrace> }
  }
  const actualOriginal = JSON.parse(original.toString()).results.find((r: BatchResult) =>
    r.seed === selection.run.seed && r.algorithmId === selection.run.algorithmId)
  if (!actualOriginal || JSON.stringify(actualOriginal) !== JSON.stringify(selection.run)) throw new Error('Selected source run mismatch')
  if (JSON.stringify(run.originalMetrics) !== JSON.stringify(selection.run.metrics)) throw new Error('Copied metrics mismatch')
  if (!compareScientificMetrics(run.replayMetrics, run.originalMetrics).exact) throw new Error('Replay metrics not exact')
  if (JSON.stringify(summarizeResearchTrace(run.trace)) !== JSON.stringify(run.summary.traceSummary)) throw new Error('Trace summary mismatch')
  const globalSummary = summary.summaries.find((s: {reason: string}) => s.reason === selection.reason)
  if (JSON.stringify(globalSummary) !== JSON.stringify(run.summary)) throw new Error('Global summary mismatch')
  let previousInput = -Infinity
  for (const row of run.trace) {
    if (row.inputTimeSeconds <= previousInput || row.measurement.time !== row.inputTimeSeconds ||
        row.outputTimeSeconds <= row.inputTimeSeconds) throw new Error('Invalid trace chronology')
    previousInput = row.inputTimeSeconds
    if ('scenario' in row || 'source' in row) throw new Error('Truth leaked into recorder row')
  }
  const m = run.replayMetrics
  const terminalTime = m.nativeDeclaration ? m.declarationTimeSeconds : m.nativeAbstention ? m.abstentionTimeSeconds : null
  if (terminalTime !== null && run.trace.at(-1)?.inputTimeSeconds !== terminalTime) throw new Error('Post-terminal ticks or missing terminal event')
  traceRows += run.trace.length
  inventory.push({ file, bytes: bytes.length, sha256: sha(bytes) })
}
const expectedFiles = new Set(['manifest.json', 'summary.json', ...inventory.map(r => r.file)])
const unexpected = (await readdir(root)).filter(f => !expectedFiles.has(f))
if (unexpected.length) throw new Error(`Unexpected archive files: ${unexpected}`)
process.stdout.write(JSON.stringify({ complete: true, diagnostics: inventory.length, traceRows,
  originalCellsUnchanged: true, exactScientificMetricMatch: true, traceChronologyValid: true, inventory }, null, 2) + '\n')
