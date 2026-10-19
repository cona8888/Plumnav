import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const input = 'research/evidence/m11_confirmation_diagnostic_2026-09-05'
const output = 'research/analysis/m11_confirmation_diagnostic_2026-09-05'
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const read = async (name: string) => JSON.parse(await readFile(join(input, name), 'utf8'))
const main = async () => {
  const checksums = await read('checksums.json')
  if (!checksums.complete) throw new Error('Incomplete diagnostic inventory')
  for (const entry of checksums.inventory) {
    if (entry.path.includes('..') || entry.path.startsWith('/')) throw new Error('Unsafe inventory path')
    const bytes = await readFile(join(input, entry.path))
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`Invalid artifact ${entry.path}`)
  }
  const summary = await read('summary.json')
  if (!summary.complete || summary.stationary.length !== 8 || summary.traces.length !== 2) throw new Error('Diagnostic dimensions failed')
  const traces = []
  for (const cellId of summary.design.traceCells) {
    const trace = await read(`trace-${cellId}.json`)
    const scans = trace.scans
    const events = trace.records.filter((r: any, i: number, a: any[]) => i === 0 ||
      r.confirmationIndex !== a[i - 1].confirmationIndex ||
      r.failedConfirmations !== a[i - 1].failedConfirmations ||
      (r.candidate !== null) !== (a[i - 1].candidate !== null))
    traces.push({ cellId, ...trace.summary, failedConfirmations: trace.failedConfirmations,
      matchedScientificColumns: trace.matchedScientificColumns,
      trustedScanReturns: trace.records.filter((r: any) => r.candidate && r.sampleMode === 'quad-return').length,
      trustedReturnsStartingGradientAdvance: trace.records.filter((r: any) => r.candidate &&
        r.sampleMode === 'quad-return' && r.phase === 'QUADRATURE GRADIENT ADVANCE').length,
      scanSaturationCount: scans.filter((s: any) => s.anySaturated).length,
      nearSourceScansWithinOnePercent: scans.filter((s: any) => s.distanceToSource <= 0.01).length,
      minimumChannelContrast: Math.min(...scans.map((s: any) => s.normalizedContrast)), events })
  }
  const table = [
    '| World | Mode | Noise | Accepted surface scans | Saturated scans | Median common signal | Median contrast |',
    '|---|---|---|---:|---:|---:|---:|',
    ...summary.stationary.map((s: any) => `| ${s.cellId} | ${s.armId} | ${s.noise} | ${s.accepted}/${s.scans} | ${s.saturated}/${s.scans} | ${s.commonMean.median.toFixed(4)} | ${s.contrast.median.toFixed(4)} |`),
  ].join('\n')
  const traceTable = [
    '| Replay | Matched scientific columns | Scans | Surface passes | Closest scan to source | Maximum confirmation index | Failed confirmations |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...traces.map((t: any) => `| ${t.cellId} | ${t.matchedScientificColumns} | ${t.scans} | ${t.acceptedSurfaceScans} | ${t.minimumScanSourceDistance.toFixed(4)} | ${t.maximumConfirmationIndex} | ${t.failedConfirmations} |`),
  ].join('\n')
  const analysis = { diagnosticOnly: true, verifiedArtifacts: checksums.inventory.length,
    evidenceSummarySha256: hash(await readFile(join(input, 'summary.json'))),
    idealRuleReady: summary.ideal.ready, stationary: summary.stationary, traces,
    analyticBounds: { assumptions: 'unsaturated channels, full support, unit geometry quality, signal term capped at one',
      maximumActiveContrast: 0.24 * (1 - 0.32 / 0.78), maximumPassiveContrast: 0.24 * (1 - 0.32),
      minimumActiveMeanAtZeroContrast: 0.32 + 0.45 * 0.32 / 0.78,
      minimumPassiveMeanAtZeroContrast: 0.32 + 0.45 * 0.32 } }
  const active = summary.stationary.filter((s: any) => s.armId === 'geometry-active')
  const findings = [
    `Known-source active scans passed surface acceptance ${active.reduce((sum: number, s: any) => sum + s.accepted, 0)}/${active.reduce((sum: number, s: any) => sum + s.scans, 0)} times across the two worlds and two sensor-noise settings. All active scan contrasts exceeded the hard 0.22 limit, and no stationary scan was saturated.`,
    'The open-world passive control also failed all scans; the obstructed-world passive control passed all twelve scans under each noise setting. Surface acceptance is attainable in one physical control, but is dependent on flow and footprint geometry.',
    'Removing additive noise did not rescue active acceptance. The observed active contrast was approximately 0.36–0.58 at the true source, above both the 0.22 hard gate and the approximately 0.142 best-case score limit. This supports a mismatch between the low-contrast emergence proxy and these simulated source/intake conditions.',
    `Instrumented replays had ${traces.map((t: any) => `${t.failedConfirmations} failed-confirmation resets (${t.cellId})`).join(' and ')}. Neither completed the confirmation pattern.`,
    `Trusted scan returns restarted gradient-advance movement ${traces.map((t: any) => `${t.trustedReturnsStartingGradientAdvance}/${t.trustedScanReturns} times in ${t.cellId}`).join('; ')}. Source review shows advance/burst movement takes priority over trusted-candidate confirmation, so a return can pull the robot away before the dwell sequence completes. This is a separate state-machine problem from the surface predicate.`,
    'The open replay scanned within 0.0062 domain widths of the true source, yet still failed surface acceptance. A navigation-only explanation is therefore insufficient in this example.',
  ]
  Object.assign(analysis, { findings })
  await mkdir(output, { recursive: true })
  const body = `${JSON.stringify(analysis, null, 2)}\n`
  await writeFile(join(output, 'm11-confirmation-analysis.json'), body)
  const report = `# M11 confirmation diagnostic\n\nAll ${checksums.inventory.length} recorded artifacts passed checksum verification. The complete ideal evidence rule returned ready=${summary.ideal.ready}. These are post-hoc diagnostic controls, not localization successes.\n\n## Main findings\n\n${findings.map((f) => `- ${f}`).join('\n')}\n\n## Known-source stationary controls\n\n${table}\n\nThe robot was held at the exact true source. Zero additive noise retains sensor lag, clipping, channel geometry, and physical plume fluctuations. Each row has twelve repeated scans from one world; scans are not independent world replicates.\n\n## Instrumented M10 replays\n\n${traceTable}\n\nEvery exported scientific column except compute timing matched its archived M10 counterpart. Events and all raw channel readings are preserved. Confirmation indices range from zero through nine; a reset is counted from the controller's failed-confirmation timestamp.\n\n## Surface-score constraints\n\nWith full support and unit geometry quality, the frozen score is signal × symmetry × evidence scale, where signal=clamp((mean−0.32)/0.45), symmetry=clamp(1−contrast/0.24), and the acceptance threshold is 0.32. Even at maximum signal, active strength 0.78 requires contrast ≤0.14154; passive sensing permits ≤0.16320. At zero contrast, minimum means are 0.50462 active and 0.46400 passive. Occlusion or poor geometry makes these requirements stricter; any saturated channel separately vetoes acceptance.\n\n## Next development work\n\nFirst isolate and correct confirmation-state priority, with tests showing that valid returns cannot interrupt candidate dwell and that rejection/reacquisition can execute. Separately design a flow-aware local source test that tolerates advective asymmetry and has source-absent and off-source controls. Simply widening the symmetry threshold to fit these two worlds would not supply specificity. Preserve M10 as the comparator; any new confirmation rule is a declared method revision requiring fresh development and later untouched validation.\n\n## Interpretation boundary\n\nThe ideal controls establish logical attainability only. Stationary known-source controls isolate the surface predicate and cannot satisfy ring sampling on their own. Two worlds cannot establish general performance. Active and passive sampling footprints differ, so their results do not isolate pump benefit. The unchanged M10 controller and nominal validation/test boundary remain preserved.\n\n## Execution correction\n\nThe first replay check rejected an omitted effective-physics-timestep metadata field in the diagnostic exporter. The correction is recorded with both script hashes. The eight completed stationary controls were preserved with exact configuration checks; both replays were then run with the corrected exporter and matched all 178 scientific columns. No simulation or controller rule was changed.\n\nAnalysis SHA-256: ${hash(body)}\n`
  await writeFile(join(output, 'm11-confirmation-report.md'), report)
  await copyFile('scripts/m11-confirmation-diagnostic.ts', join(output, 'diagnostic-source-final.ts'))
  await copyFile('scripts/m11-analyze-confirmation.ts', join(output, 'analysis-source.ts'))
  const analysisInventory = await Promise.all(['m11-confirmation-analysis.json', 'm11-confirmation-report.md',
    'diagnostic-source-final.ts', 'analysis-source.ts'].map(async (path) => {
      const bytes = await readFile(join(output, path)); return { path, sha256: hash(bytes), bytes: bytes.length }
    }))
  await writeFile(join(output, 'analysis-checksums.json'), `${JSON.stringify(analysisInventory, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ output, analysisSha256: hash(body), reportSha256: hash(report),
    stationary: summary.stationary, traces: traces.map(({events, ...rest}) => rest) }, null, 2)}\n`)
}
main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
