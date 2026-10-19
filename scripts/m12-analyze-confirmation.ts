import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const input = 'research/evidence/m12_confirmation_scheduling_2026-09-05'
const output = 'research/analysis/m12_confirmation_scheduling_2026-09-05'
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const read = async (name: string) => JSON.parse(await readFile(join(input, name), 'utf8'))
const safePath = (path: string) => {
  if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('Unsafe inventory path')
  return path
}
const main = async () => {
  const inventory = await read('checksums.json')
  const design = await read('design.json')
  const summary = await read('summary.json')
  const expected = ['design.json', 'summary.json', ...design.jobs.flatMap((job: any) =>
    ['json', 'csv'].map((extension) => `${job.cellId}-${job.algorithmId}.${extension}`))].sort()
  if (!inventory.complete || !summary.complete || design.jobs.length !== 6 ||
      json(inventory.inventory.map((e: any) => e.path).sort()) !== json(expected)) {
    throw new Error('Incomplete or unexpected evidence inventory')
  }
  for (const entry of inventory.inventory) {
    const bytes = await readFile(join(input, safePath(entry.path)))
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`Invalid artifact: ${entry.path}`)
  }
  if (hash(json(design.sourceInventory)) !== design.sourceInventorySha256 ||
      summary.sourceInventorySha256 !== design.sourceInventorySha256) throw new Error('Source inventory mismatch')
  for (const entry of design.sourceInventory) {
    const bytes = await readFile(join(input, 'source-snapshot', safePath(entry.path)))
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`Invalid source snapshot: ${entry.path}`)
  }
  const runs = []
  for (const job of design.jobs) {
    const { summary: result, records } = await read(`${job.cellId}-${job.algorithmId}.json`)
    const trusted = records.filter((r: any) => r.returned && r.candidate)
    const advances = trusted.filter((r: any) => r.phase === 'QUADRATURE GRADIENT ADVANCE').length
    const maximumIndex = Math.max(...records.map((r: any) => r.confirmationIndex))
    const resets = Math.max(...records.map((r: any) => r.resets))
    if (trusted.length !== result.trustedReturns || advances !== result.advanceOnTrustedReturn ||
        maximumIndex !== result.maximumConfirmationIndex || resets !== result.resets) {
      throw new Error(`Trace-summary disagreement: ${job.cellId}/${job.algorithmId}`)
    }
    const phases: Record<string, number> = {}
    for (const record of records) phases[record.phase] = (phases[record.phase] ?? 0) + 1
    const candidateErrors = records.flatMap((r: any) => r.candidateError === null ? [] : [r.candidateError]) as number[]
    runs.push({ ...result, ticks: records.length, phaseTicks: phases,
      minimumCandidateError: candidateErrors.length ? Math.min(...candidateErrors) : null,
      resetTimes: records.filter((r: any, i: number) => r.resets > (records[i - 1]?.resets ?? 0)).map((r: any) => r.time),
      events: records.filter((r: any, i: number) => i === 0 ||
        r.confirmationIndex !== records[i - 1].confirmationIndex || r.resets !== records[i - 1].resets ||
        Boolean(r.candidate) !== Boolean(records[i - 1].candidate)),
    })
  }
  const priorityPresent = runs.filter((r) => r.algorithmId === 'quad-sniff-confirmation' && r.cellId.endsWith('emitting'))
  const controls = runs.filter((r) => r.algorithmId === 'quad-sniff')
  const absent = runs.filter((r) => r.cellId.endsWith('absent'))
  if (priorityPresent.length !== 2 || controls.length !== 2 || absent.length !== 2) throw new Error('Invalid job groups')
  const checks = {
    preservedM10: controls.every((r) => r.matchedM10ScientificColumns === 177),
    priorityRespected: priorityPresent.every((r) => r.trustedReturns > 0 && r.advanceOnTrustedReturn === 0),
    confirmationCompletedAndRejected: priorityPresent.every((r) => r.resets >= 1 && r.maximumConfirmationIndex === 9),
    absentSafety: absent.every((r) => !r.spuriousDeclaration),
  }
  if (json(checks) !== json(summary.checks)) throw new Error('Recomputed checks disagree')
  const analysis = { diagnosticOnly: true, verifiedArtifacts: inventory.inventory.length,
    verifiedSourceFiles: design.sourceInventory.length, sourceInventorySha256: design.sourceInventorySha256,
    evidenceSummarySha256: hash(await readFile(join(input, 'summary.json'))), checks,
    mechanismPassed: Object.values(checks).every(Boolean),
    elapsedWallSeconds: (Date.parse(summary.completedAt) - Date.parse(summary.startedAt)) / 1000,
    peakRssBytes: summary.peakRssBytes, runs }
  const table = [
    '| World | Controller | Gradient advances / trusted returns | Max confirmation index | Rejection resets | Surface-count passes | Native declaration |',
    '|---|---|---:|---:|---:|---:|---|',
    ...runs.map((r) => `| ${r.cellId} | ${r.algorithmId === 'quad-sniff' ? 'M10' : 'M12'} | ${r.advanceOnTrustedReturn}/${r.trustedReturns} | ${r.maximumConfirmationIndex} | ${r.resets} | ${r.surfaceCountPasses} | ${r.nativeDeclaration ? 'yes' : 'no'} |`),
  ].join('\n')
  const report = `# M12 confirmation scheduling verification\n\nSeparate scheduling-only revision, simulator 0.15.0. All ${analysis.verifiedArtifacts} evidence artifacts and ${analysis.verifiedSourceFiles} frozen source files passed checksum verification. Duration: ${analysis.elapsedWallSeconds.toFixed(1)} seconds; peak process RSS: ${(analysis.peakRssBytes / 1024 ** 3).toFixed(2)} GiB.\n\n## Predefined mechanism checks\n\n${Object.entries(checks).map(([key, value]) => `- ${key}: ${value ? 'PASS' : 'FAIL'}`).join('\n')}\n\n${table}\n\nBoth M10 controls are compared with their archived scientific rows: 177 columns, excluding compute timings and the simulator-version label. The M12 controller changes movement priority and station-keeping during the existing confirmation dwell only; candidate and declaration requirements are unchanged.\n\n## What this establishes\n\n${checks.priorityRespected ? 'The new controller prevented trusted scan returns from selecting gradient-advance movement in both emitting examples.' : 'The priority check did not pass in both examples; inspect the saved phase traces before claiming the mechanism is fixed.'} ${checks.confirmationCompletedAndRejected ? 'Both emitting examples reached the end of the nine-waypoint confirmation sequence and exercised rejection/reset. Thus the previously unreachable rejection path is now exercised in these plume worlds.' : 'The complete-sequence/rejection check did not pass in both examples. Synthetic regression tests establish logic attainability, but end-to-end progression remains incomplete in at least one world.'}\n\nThe confirmation index can also advance over a blocked waypoint. Index nine therefore denotes completion of the controller sequence, not proof that every intended physical pose was visited. Events and phase counts are retained for inspection.\n\nM12 made ${priorityPresent.filter((r) => r.correctDeclaration).length}/2 correct native declarations in the emitting diagnostic worlds and ${absent.filter((r) => r.spuriousDeclaration).length}/2 spurious declarations in the absent worlds. These tiny, reused development examples are not a success-rate estimate, a safety claim, or a ranking against other algorithms. A nondeclaration in a present world is not a localization success.\n\n## Remaining scientific work\n\nThe prior M11 known-source controls identified a separate mismatch between the active intake observations and the low-contrast surface predicate. Scheduling verification does not validate that predicate. Next, develop and freeze a flow-aware local-source confirmation test using matched known-source, displaced/off-source, and source-absent observations. Include passive-array controls and matched sensing/time/energy budgets. Do not merely widen symmetry thresholds to fit these two worlds. After development, test the frozen method on untouched validation seeds before a broader urban/outdoor comparison. Source coordinates remain evaluation-only.\n\nThe benchmark question remains which method works under which conditions, not how to manufacture a universal winner. Neither real-world methane/soil performance nor active-suction benefit has been established by this diagnostic.\n\nSource inventory SHA-256: ${analysis.sourceInventorySha256}\nAnalysis SHA-256: ${hash(json(analysis))}\n`
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'm12-confirmation-analysis.json'), json(analysis))
  await writeFile(join(output, 'm12-confirmation-report.md'), report)
  await copyFile('scripts/m12-analyze-confirmation.ts', join(output, 'analysis-source.ts'))
  const analysisInventory = await Promise.all(['m12-confirmation-analysis.json', 'm12-confirmation-report.md',
    'analysis-source.ts'].map(async (path) => {
      const bytes = await readFile(join(output, path)); return { path, sha256: hash(bytes), bytes: bytes.length }
    }))
  await writeFile(join(output, 'analysis-checksums.json'), json(analysisInventory))
  process.stdout.write(json({ ...analysis, runs: runs.map(({ events, ...rest }) => rest),
    reportSha256: hash(report), analysisSha256: hash(json(analysis)) }))
}
main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
