import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { M19_DESIGN, M19_ORDERS, m19Settings, m19Contexts, studyM19Setting, chooseM19Order,
  type M19Setting } from './lib/m19-scan-order'

const root = 'research/evidence/m19_scan_order_2026-09-08'
const output = 'research/analysis/m19_scan_order_2026-09-08'
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
const read = async (p: string) => JSON.parse(await readFile(join(root, p), 'utf8'))
const safe = (p: string) => { if (p.startsWith('/') || p.split('/').includes('..')) throw new Error('Unsafe archive path'); return p }
export const analyzeM19 = async () => {
  const design = await read('design.json'); const summary = await read('summary.json'); const inventory = await read('checksums.json')
  if (!summary.complete || !inventory.complete || summary.settings !== 18 || summary.factorialChecks !== 4896 || summary.rolloutChecks !== 1152 ||
      summary.rollouts !== 36 || summary.plumeTrajectories !== 0 || json(design.settings) !== json(m19Settings()) || json(design.contexts) !== json(m19Contexts())) throw new Error('Incomplete design')
  for (const [key, value] of Object.entries(M19_DESIGN)) if (json(design[key]) !== json(value)) throw new Error(`Changed criterion: ${key}`)
  const expected = ['design.json', 'summary.json', ...design.settings.map((s: M19Setting) => `${s.id}.json`)].sort()
  if (json(inventory.inventory.map((e: any) => e.path).sort()) !== json(expected)) throw new Error('Unexpected inventory')
  for (const e of inventory.inventory) {
    const b = await readFile(join(root, safe(e.path)))
    if (b.length !== e.bytes || hash(b) !== e.sha256) throw new Error(`Artifact mismatch: ${e.path}`)
  }
  if (hash(json(design.sourceInventory)) !== design.sourceInventorySha256 || summary.sourceInventorySha256 !== design.sourceInventorySha256) throw new Error('Source binding mismatch')
  for (const e of design.sourceInventory) {
    const b = await readFile(join(root, 'source-snapshot', safe(e.path)))
    if (b.length !== e.bytes || hash(b) !== e.sha256 || hash(await readFile(e.path)) !== e.sha256) throw new Error(`Frozen source changed: ${e.path}`)
  }
  const rows = []; let factorialChecks = 0; let rolloutChecks = 0
  const allDecisions: ReturnType<typeof studyM19Setting>['factorial'] = []
  for (const setting of design.settings as M19Setting[]) {
    const archived = await read(`${setting.id}.json`); const result = studyM19Setting(setting)
    if (json(result) !== json(archived)) throw new Error(`Replay mismatch: ${setting.id}`)
    const qualifiedRolloutDecisions = result.rollouts.reduce((n, r) => n + r.qualifiedDecisions, 0)
    const expectedSummary = { setting, warmFeasibleContexts: result.warmFeasibleContexts, coldFeasibleContexts: result.coldFeasibleContexts,
      qualifiedRolloutDecisions, eligibleForManufacturedDiagnostic: result.eligibleForManufacturedDiagnostic }
    if (json(summary.summaries.find((s: any) => s.setting.id === setting.id)) !== json(expectedSummary)) throw new Error('Summary mismatch')
    const warm = result.factorial.filter((r) => r.context.previousOrder !== null)
    if (result.eligibleForManufacturedDiagnostic !== (warm.length === 32 && warm.every((r) => r.selectedOrder !== null) &&
        result.rollouts.every((r) => r.steps.slice(2).every((s) => s.decision!.selectedOrder !== null)))) throw new Error('Qualification mismatch')
    const decisions = [...result.factorial, ...result.rollouts.flatMap((r) => r.steps.flatMap((s) => s.decision ? [s.decision] : []))]
    for (const d of decisions) {
      if (d.candidates.length !== 8 || d.selectedOrder !== chooseM19Order(d.candidates)) throw new Error('Selection mismatch')
      for (const c of d.candidates) if (c.feasible !== Object.values(c.gates).every(Boolean)) throw new Error('Gate mismatch')
    }
    for (const rollout of result.rollouts) {
      if (rollout.events.length !== 18 || rollout.events.reduce((n, e) => n + e.duration, 0) !== 9 ||
          rollout.steps.slice(0, 2).some((s) => s.decision !== null) || rollout.events.at(-1)!.start + 0.5 !== 36.5 ||
          rollout.budget.reachSwitches !== rollout.events.slice(1).filter((s, i) => s.reach !== rollout.events[i]!.reach).length) throw new Error('Rollout budget mismatch')
    }
    const orderStatistics = M19_ORDERS.map((order) => ({ order,
      warmFeasibleContexts: warm.filter((r) => r.candidates.find((c) => c.order === order)!.feasible).length,
      selectedWarmContexts: warm.filter((r) => r.selectedOrder === order).length,
      rolloutSelections: result.rollouts.flatMap((r) => r.steps.slice(2)).filter((s) => s.decision!.selectedOrder === order).length }))
    const matchedBLBvsLBL = { blbLower: 0, lblLower: 0, tied: 0, unavailable: 0 }
    for (const r of warm) {
      const b = r.candidates.find((c) => c.order === 'BLB')!.score; const l = r.candidates.find((c) => c.order === 'LBL')!.score
      if (b === null || l === null) matchedBLBvsLBL.unavailable++
      else if (Math.abs(b - l) <= 1e-10) matchedBLBvsLBL.tied++
      else if (b < l) matchedBLBvsLBL.blbLower++
      else matchedBLBvsLBL.lblLower++
    }
    rows.push({ ...expectedSummary, staticOrdersFeasibleEveryWarmContext: orderStatistics.filter((r) => r.warmFeasibleContexts === 32).map((r) => r.order),
      orderStatistics, matchedBLBvsLBL, rolloutOrders: result.rollouts.map((r) => ({ initialBearing: r.initialBearing,
        orders: r.steps.map((s) => s.acquisitionOrder), qualified: r.steps.map((s) => s.decision?.selectedOrder !== null && s.decision !== null),
        budget: r.budget })) })
    factorialChecks += result.factorial.reduce((n, c) => n + c.candidates.length, 0)
    rolloutChecks += result.rollouts.reduce((n, r) => n + r.steps.reduce((m, s) => m + (s.decision?.candidates.length ?? 0), 0), 0)
    allDecisions.push(...result.factorial)
  }
  if (factorialChecks !== 4896 || rolloutChecks !== 1152) throw new Error('Incomplete replay')
  const eligible = rows.filter((r) => r.eligibleForManufacturedDiagnostic).map((r) => r.setting.id)
  const failureCounts = Object.fromEntries(Object.keys(allDecisions[0]!.candidates[0]!.gates).map((gate) => [gate,
    allDecisions.flatMap((r) => r.candidates).filter((c) => !c.gates[gate as keyof typeof c.gates]).length]))
  const analysis = { geometryOnly: true, plumeTrajectories: 0, verifiedArtifacts: inventory.inventory.length, verifiedSources: design.sourceInventory.length,
    sourceInventorySha256: design.sourceInventorySha256, replayedFactorialChecks: factorialChecks, replayedRolloutChecks: rolloutChecks,
    elapsedWallSeconds: (Date.parse(summary.completedAt) - Date.parse(summary.startedAt)) / 1000, peakRssBytes: summary.peakRssBytes,
    eligibleSettings: eligible, advancesToPhysicalPlumeBenchmark: false, failureCounts, rows }
  const table = ['| Map | Model | Broad reach | Warm contexts | Cold contexts | Qualified rollout decisions | Eligible for field diagnostic |',
    '|---|---|---:|---:|---:|---:|---|', ...rows.map((r) =>
      `| ${r.setting.map} | ${r.setting.model} | ${r.setting.reach} | ${r.warmFeasibleContexts}/32 | ${r.coldFeasibleContexts}/2 | ${r.qualifiedRolloutDecisions}/8 | ${r.eligibleForManufacturedDiagnostic ? 'YES' : 'NO'} |`)].join('\n')
  const report = ['# M19 scan-order selector: verified geometry-only comparison',
    `${eligible.length}/18 settings qualify for a NEW manufactured-field diagnostic. **No setting is validated for a physical-plume benchmark or the live app.** No concentration outcomes or source locations entered selection.`,
    `Verified ${analysis.verifiedArtifacts} artifacts and ${analysis.verifiedSources} frozen sources; all ${factorialChecks} factorial and ${rolloutChecks} rollout candidate checks replayed exactly. Main calculation ${analysis.elapsedWallSeconds.toFixed(3)} s, ${(analysis.peakRssBytes / 2 ** 30).toFixed(2)} GiB peak RSS, one Mac process. No AWS and no plume trajectories.`,
    '## Fixed decision',
    'A setting must offer at least one feasible current order in all 32 independently crossed previous-order/previous-bearing/current-bearing contexts, plus eight qualified post-warm-up decisions across the two causal rollouts. Cold-start checks are diagnostic: the fixed first two blocks are explicitly paid warm-up with no confirmation decisions. All six blocks execute even if the selector abstains; failed choices use the fixed exploration recipe and cannot claim qualified confirmation.',
    'Noise remains0.025; both inherited precision caps remain0.15. The selector rejects failed candidates, minimizes the maximum normalized noise allowance, and breaks near-ties by reach-switch count then lexical order. It does not optimize actual localization success, physical sensor SNR or model bias.',
    '## All settings', table,
    '## Order statistics and causal acquisition sequences',
    '```json\n' + json(rows.filter((r) => r.setting.map === 'open').map((r) => ({ setting: r.setting,
      staticOrdersFeasibleEveryWarmContext: r.staticOrdersFeasibleEveryWarmContext, orderStatistics: r.orderStatistics,
      matchedBLBvsLBL: r.matchedBLBvsLBL, rolloutOrders: r.rolloutOrders }))).trim() + '\n```',
    'Every wall/corridor record and every candidate is retained in the evidence and analysis JSON. A static order that qualifies in every warm context is an essential simpler comparator; do not credit an adaptive selector with gains that a fixed recipe achieves. Matched BLB/LBL comparisons hold both bearings and prior order fixed; these are matrix effects, not statistical evidence of biological benefit.',
    '## Interpretation limits',
    'All arms retain eighteen half-second cycles and nine seconds draw time, with 3 seconds of explicit warm-up, 2.5 ideal turn seconds and zero travel. Selected reach-switch counts vary. Real purge and valve delays, reach-dependent energy, correlated sensor noise and spatial model mismatch remain unvalidated. The L1 noise envelopes are not confidence intervals or model-error bounds. A single-reach or lower-order recipe can look best geometrically while being biased in a real plume.',
    'Qualification is permission only for another frozen manufactured-field test retaining the rapid amplitude pulses, narrow/moving/breathing controls and source-free cases. The approved paper still concerns condition-dependent autonomous GSL, not derivative/flux estimation as an end in itself. Do not claim a best GSL algorithm or novel biological mechanism from this screen.',
    '## Correction to prior narrative',
    'The first M18 execution summary reversed the named reach orders in its three-epoch table. The corrected labels are LBL at26.5/36.5s and BLB at31.5s. The underlying M18 code, protocol, results and checksums were correct and are unchanged. A new regression test checks the labels against schedule parity.',
    `Source inventory SHA-256: ${analysis.sourceInventorySha256}`,
  ].join('\n\n') + '\n'
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'm19-analysis.json'), json(analysis), { flag: 'wx' })
  await writeFile(join(output, 'm19-report.md'), report, { flag: 'wx' })
  await copyFile('scripts/m19-analyze-study.ts', join(output, 'analysis-source.ts'))
  const checksums = await Promise.all(['m19-analysis.json', 'm19-report.md', 'analysis-source.ts'].map(async (path) => {
    const b = await readFile(join(output, path)); return { path, bytes: b.length, sha256: hash(b) }
  }))
  await writeFile(join(output, 'analysis-checksums.json'), json(checksums), { flag: 'wx' })
  process.stdout.write(json({ ...analysis, rows: undefined, analysisSha256: hash(json(analysis)) }))
}
if (process.env.M19_ANALYSIS_RUN === '1') analyzeM19().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
