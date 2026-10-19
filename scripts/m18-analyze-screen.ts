import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { M18_DESIGN, m18Plans, m18Rows, screenM18, type M18Plan } from './lib/m18-geometry-feasibility'

const root = 'research/evidence/m18_geometry_feasibility_2026-09-08'
const output = 'research/analysis/m18_geometry_feasibility_2026-09-08'
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
const read = async (p: string) => JSON.parse(await readFile(join(root, p), 'utf8'))
const safe = (p: string) => { if (p.startsWith('/') || p.split('/').includes('..')) throw new Error('Unsafe archive path'); return p }
export const analyzeM18 = async () => {
  const design = await read('design.json'); const summary = await read('summary.json'); const inventory = await read('checksums.json')
  if (!summary.complete || !inventory.complete || summary.plans !== 144 || summary.epochs !== 432 || summary.plumeTrajectories !== 0 ||
      json(design.plans) !== json(m18Plans())) throw new Error('Incomplete or changed design')
  for (const [key, value] of Object.entries(M18_DESIGN)) if (json(design[key]) !== json(value)) throw new Error(`Changed criterion: ${key}`)
  const expected = ['design.json', 'summary.json', ...design.plans.map((p: M18Plan) => `${p.id}.json`)].sort()
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
  const results: ReturnType<typeof screenM18>[] = []; let replayedEpochs = 0
  for (const plan of design.plans as M18Plan[]) {
    const data = await read(`${plan.id}.json`); const result = screenM18(plan)
    if (json(data.result) !== json(result) || json(data.geometry) !== json(result.epochs.map((e) => m18Rows(plan, e.block)))) throw new Error(`Replay mismatch: ${plan.id}`)
    const expectedSummary = { plan, feasible: result.feasible, worstPredictionAllowance: result.worstPredictionAllowance, worstResidualAllowance: result.worstResidualAllowance }
    if (json(summary.summaries.find((s: any) => s.plan.id === plan.id)) !== json(expectedSummary)) throw new Error('Summary mismatch')
    if (result.feasible !== (result.budget.budgetValid && result.epochs.length === 3 && result.epochs.every((e) => Object.values(e.gates).every(Boolean)))) throw new Error('Qualification mismatch')
    for (const rows of data.geometry) {
      if (rows.trainingTimes.some((t: number) => t > rows.cutoff) || rows.testTimes.some((t: number) => t <= rows.cutoff)) throw new Error('Validation leakage')
      for (const r of [...rows.training, ...rows.testing]) if (json(Object.keys(r).sort()) !== json(['sigma', 'x'])) throw new Error('Outcome data in geometry archive')
    }
    results.push(result); replayedEpochs += result.epochs.length
  }
  if (results.length !== 144 || replayedEpochs !== 432) throw new Error('Missing replay')
  const grouped = []
  for (const map of ['open', 'wall', 'corridor']) for (const model of ['m14', 'm16']) {
    const subset = results.filter((r) => r.plan.map === map && r.plan.model === model)
    grouped.push({ map, model, plans: subset.length, feasible: subset.filter((r) => r.feasible).length,
      feasibleIds: subset.filter((r) => r.feasible).map((r) => r.plan.id) })
  }
  const failures = Object.fromEntries(Object.keys(results[0]!.epochs[0]!.gates).map((gate) => [gate,
    results.flatMap((r) => r.epochs).filter((e) => !e.gates[gate as keyof typeof e.gates]).length]))
  const analysis = { geometryOnly: true, plumeTrajectories: 0, verifiedArtifacts: inventory.inventory.length,
    verifiedSources: design.sourceInventory.length, replayedPlans: results.length, replayedEpochs,
    sourceInventorySha256: design.sourceInventorySha256,
    elapsedWallSeconds: (Date.parse(summary.completedAt) - Date.parse(summary.startedAt)) / 1000,
    peakRssBytes: summary.peakRssBytes, qualifiedPlans: results.filter((r) => r.feasible).length,
    anyEligibleForManufacturedDiagnostic: results.some((r) => r.feasible), advancesToPhysicalPlumeBenchmark: false,
    grouped, failureEpochCounts: failures, results }
  const n = (v: number | null) => v === null ? 'N/A' : v.toFixed(4)
  const table = ['| Profile | Model | Broad reach | Max prediction allowance | Max residual allowance | Qualifies |',
    '|---|---|---:|---:|---:|---|', ...results.filter((r) => r.plan.map === 'open' && r.plan.window === 6).map((r) =>
      `| ${r.plan.profile} | ${r.plan.model} | ${r.plan.reach} | ${n(r.worstPredictionAllowance)} | ${n(r.worstResidualAllowance)} | ${r.feasible ? 'YES' : 'NO'} |`)].join('\n')
  const report = ['# M18 verified geometry/noise feasibility screen',
    `${analysis.qualifiedPlans}/144 designs qualify for a subsequent manufactured-field diagnostic. **None is validated for a physical-plume benchmark or deployment.** This screen used no plume outcomes, source coordinates or concentration signals.`,
    `All ${analysis.verifiedArtifacts} artifacts and ${analysis.verifiedSources} frozen sources verified; ${analysis.replayedPlans} designs and ${replayedEpochs} matrix epochs replayed exactly. Main execution ${analysis.elapsedWallSeconds.toFixed(3)} s, ${(analysis.peakRssBytes / 2 ** 30).toFixed(2)} GiB peak RSS, one Mac process. Zero plume trajectories; no AWS.`,
    '## Fixed acceptance criteria',
    'Each of three evaluated epochs must retain enough training measurements, identifiable required derivative and withheld-reading operators, admissible numerical conditioning, complete prescribed validation channels, prediction noise allowance <=0.15, and worst-corner residual noise allowance <=0.15 per second. The residual budget is a new predeclared engineering criterion, not a validated accuracy threshold or M17 retuning. All plans have eighteen half-second cycles and nine seconds draw time; decision frequency, holdout size, turn count, reach and switching burden differ.',
    '## Open geometry, six-second windows', table,
    'The displayed maxima are across all three epochs; unavailable operators yield N/A rather than favourable-case averaging. A NO can result from measurement count, condition or identifiability even when a displayed noise allowance is small. Every three-second, wall and corridor result is retained in the JSON.',
    '## Qualified sets by geometry and model',
    '```json\n' + json(grouped).trim() + '\n```',
    '## Failure counts (nonexclusive, 432 epochs)',
    '```json\n' + json(failures).trim() + '\n```',
    '## What the result means for the study',
    'This necessary-check screen can reject a sampling policy before collecting concentration data. It cannot establish a best GSL algorithm, predict success rates, or validate source confirmation. The L1 marginal-noise envelopes are not calibrated confidence intervals; correlated samples, sensor lag, calibration error, clipping/saturation, temporal variation and spatial approximation bias remain for later tests. Larger reach can reduce derivative-noise amplification while increasing spatial bias. Clustered measurements can reduce forecast distance in time but reduce decision frequency. Neither benefit is free.',
    'A qualified design is eligible only for a new frozen manufactured-field diagnostic, preserving the failed pulse regimes and independent test returns. Realistic plume/navigation comparisons, baseline fidelity, source-absent behavior and external transfer remain necessary for the approved condition-dependent urban/outdoor GSL paper. Flux/residual reconstruction remains supporting diagnosis, not the core contribution.',
    `Source inventory SHA-256: ${analysis.sourceInventorySha256}`,
  ].join('\n\n') + '\n'
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'm18-analysis.json'), json(analysis), { flag: 'wx' })
  await writeFile(join(output, 'm18-report.md'), report, { flag: 'wx' })
  await copyFile('scripts/m18-analyze-screen.ts', join(output, 'analysis-source.ts'))
  const checksums = await Promise.all(['m18-analysis.json', 'm18-report.md', 'analysis-source.ts'].map(async (path) => {
    const b = await readFile(join(output, path)); return { path, bytes: b.length, sha256: hash(b) }
  }))
  await writeFile(join(output, 'analysis-checksums.json'), json(checksums), { flag: 'wx' })
  process.stdout.write(json({ ...analysis, results: undefined, analysisSha256: hash(json(analysis)) }))
}
if (process.env.M18_ANALYSIS_RUN === '1') analyzeM18().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
