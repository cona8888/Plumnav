import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { M17_DESIGN, m17Jobs, m17Schedule, simulateM17, scoreM17, type M17Job } from './lib/m17-paired-study'
import { M17_POLICY } from './lib/m17-prediction-guard'

const root = 'research/evidence/m17_paired_prediction_2026-09-06'
const output = 'research/analysis/m17_paired_prediction_2026-09-06'
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
const read = async (p: string) => JSON.parse(await readFile(join(root, p), 'utf8'))
const safe = (p: string) => { if (p.startsWith('/') || p.split('/').includes('..')) throw new Error('Unsafe archive path'); return p }
type EstimatorSummary = ReturnType<typeof scoreM17>[number]['summary']
type Row = M17Job & { estimator: 'm14' | 'm16' | 'guarded'; result: EstimatorSummary }
const pooled = (rows: Row[]) => rows.length && rows.every((r) => r.result.residualRmse !== null)
  ? Math.sqrt(rows.reduce((s, r) => s + r.result.residualRmse! ** 2, 0) / rows.length) : null
export const analyzeM17 = async () => {
  const design = await read('design.json'); const summary = await read('summary.json'); const inventory = await read('checksums.json')
  if (!summary.complete || !inventory.complete || summary.trajectories !== M17_DESIGN.expectedTrajectories || summary.scoreRecords !== M17_DESIGN.expectedScores ||
      summary.summaries.length !== 870 || json(design.jobs) !== json(m17Jobs()) || json(design.policy) !== json(M17_POLICY)) throw new Error('Incomplete or changed design')
  const expected = ['design.json', 'summary.json', ...design.jobs.map((j: M17Job) => `${j.id}.json`)].sort()
  if (json(inventory.inventory.map((e: any) => e.path).sort()) !== json(expected)) throw new Error('Unexpected inventory')
  for (const e of inventory.inventory) {
    const b = await readFile(join(root, safe(e.path)))
    if (b.length !== e.bytes || hash(b) !== e.sha256) throw new Error(`Artifact hash mismatch: ${e.path}`)
  }
  if (hash(json(design.sourceInventory)) !== design.sourceInventorySha256 || summary.sourceInventorySha256 !== design.sourceInventorySha256) throw new Error('Source binding mismatch')
  for (const e of design.sourceInventory) {
    const b = await readFile(join(root, 'source-snapshot', safe(e.path)))
    if (b.length !== e.bytes || hash(b) !== e.sha256 || hash(await readFile(e.path)) !== e.sha256) throw new Error(`Frozen source changed: ${e.path}`)
  }
  const subset = new Set<string>(design.verificationSubset); let regenerated = 0; let replayedScores = 0
  const rows: Row[] = []
  const guardDiagnostics = { finalDecisions: 0, complexPredictionPass: 0, simplePredictionPass: 0,
    complexReasons: {} as Record<string, number>, simpleReasons: {} as Record<string, number>,
    sourceFreeIndividualPositive: 0, zeroIndividualPositive: 0 }
  for (const job of design.jobs as M17Job[]) {
    const r = await read(`${job.id}.json`) as { observations: ReturnType<typeof simulateM17>; analyses: ReturnType<typeof scoreM17> }
    const schedule = m17Schedule(job)
    if (json(r.observations.job) !== json(job) || r.observations.sensorLag !== 0.05 || r.observations.scans.length !== schedule.length ||
        r.observations.scans.some((s, i) => s.time !== schedule[i]!.start + schedule[i]!.duration || s.cycleSeconds !== schedule[i]!.duration ||
          s.quad.readings!.length !== 4 || s.quad.readings!.some((q) => q.reach !== schedule[i]!.reach ||
            Math.abs(q.effectiveIntegrationSamples - (s.cycleSeconds === 0.5 ? 8 / 3 : 32 / 7)) > 1e-12)) ||
        json(r.observations.budget) !== json({ horizon: 40, cycles: schedule.length, samplingSeconds: 9,
          activeSamplingSeconds: job.policy === 'fixed-passive' ? 0 : 9, idealTurningSeconds: job.policy === 'fixed-passive' ? 0 : 4,
          pathLength: 0, suctionEnergyProxy: job.policy === 'fixed-passive' ? 0 : 4 * 0.78 ** 2 * 9,
          reachSwitches: job.policy === 'paired-active' ? 9 : 0,
          reachSequence: schedule.map((s) => s.reach), cycleDurations: schedule.map((s) => s.duration) })) throw new Error(`Job or schedule mismatch: ${job.id}`)
    const replay = scoreM17(r.observations)
    if (json(replay) !== json(r.analyses)) throw new Error(`Score mismatch: ${job.id}`)
    if (json(summary.summaries.find((s: any) => s.job.id === job.id)) !== json({ job,
      estimators: replay.map(({ estimator, summary: result }) => ({ estimator, ...result })) })) throw new Error('Summary mismatch')
    replayedScores += replay.reduce((n, a) => n + a.records.length, 0)
    if (subset.has(job.id)) {
      if (json(simulateM17(job)) !== json(r.observations)) throw new Error(`Forward regeneration mismatch: ${job.id}`)
      regenerated++
    }
    for (const a of replay) {
      rows.push({ ...job, estimator: a.estimator, result: a.summary })
      if (a.estimator === 'guarded') for (const record of a.records.slice(-6)) {
        const e = record.evidence
        if (!('complex' in e)) throw new Error('Guard diagnostic missing')
        guardDiagnostics.finalDecisions++
        guardDiagnostics.complexPredictionPass += Number(e.complex.passed)
        guardDiagnostics.simplePredictionPass += Number(e.simple.passed)
        for (const key of ['complex', 'simple'] as const) {
          const reasons = guardDiagnostics[`${key}Reasons`]
          reasons[e[key].reason] = (reasons[e[key].reason] ?? 0) + 1
          if (e[key].trainingScans.some((t) => t > record.time - 1) || e[key].testScans.some((t) => t <= record.time - 1)) throw new Error('Prediction leakage')
        }
        if (job.field === 'wave') guardDiagnostics.sourceFreeIndividualPositive += Number(e.positive)
        if (job.field === 'zero') guardDiagnostics.zeroIndividualPositive += Number(e.positive)
      }
    }
  }
  if (replayedScores !== 13050 || regenerated !== 12 || rows.length !== 1450) throw new Error('Missing verification records')
  const origins = rows.filter((r) => r.policy === 'paired-active' && r.estimator === 'm16' && !['wave', 'zero'].includes(r.field) && r.offset === 0)
  const comparator = (r: Row) => rows.find((v) => v.field === r.field && v.width === r.width && v.period === r.period &&
    v.offset === r.offset && v.noise === r.noise && v.seed === r.seed && v.policy === 'wide-active' && v.estimator === 'm14')!
  const zeroSteady = origins.filter((r) => r.noise === 0 && r.period === 0)
  const zeroDynamic = origins.filter((r) => r.noise === 0 && r.period > 0)
  const noisy = origins.filter((r) => r.noise > 0)
  const guarded = rows.filter((r) => r.estimator === 'guarded')
  const guardedNoisy = guarded.filter((r) => !['wave', 'zero'].includes(r.field) && r.offset === 0 && r.noise > 0)
  const negative = guarded.filter((r) => ['wave', 'zero'].includes(r.field))
  const dynamicCandidate = pooled(zeroDynamic); const dynamicBaseline = pooled(zeroDynamic.map(comparator))
  const noisyCandidate = pooled(noisy); const noisyBaseline = pooled(noisy.map(comparator))
  const gates = {
    integrityAndMatchedAcquisition: true,
    steadyBiasImprovedBothWidths: zeroSteady.length === 2 && zeroSteady.every((r) => r.result.residualRmse !== null && comparator(r).result.residualRmse !== null && r.result.residualRmse <= 0.75 * comparator(r).result.residualRmse!),
    dynamicMseImproved: zeroDynamic.length === 12 && dynamicCandidate !== null && dynamicBaseline !== null && dynamicCandidate ** 2 <= 0.8 * dynamicBaseline ** 2,
    noDynamicSettingRegressed: zeroDynamic.length === 12 && zeroDynamic.every((r) => r.result.residualRmse !== null && comparator(r).result.residualRmse !== null && r.result.residualRmse <= 1.1 * comparator(r).result.residualRmse!),
    noisyOriginRmseNoWorse: noisy.length === 56 && noisy.every((r) => r.result.finalRawFits === 6) && noisyCandidate !== null && noisyBaseline !== null && noisyCandidate <= noisyBaseline,
    guardedNoisyOriginCoverage: guardedNoisy.length === 56 && guardedNoisy.every((r) => r.result.finalUsable >= 4),
    noNegativeControlCasePositive: negative.length === 10 && negative.every((r) => !r.result.casePositive),
  }
  const originTable = []
  for (const field of ['gaussian', 'moving', 'breathing'] as const) for (const width of [0.024, 0.042]) for (const period of [0, 5, 12]) for (const noise of [0, 0.025]) {
    if (field !== 'gaussian' && period === 0) continue
    const selected = rows.filter((r) => r.field === field && r.offset === 0 && r.width === width && r.period === period && r.noise === noise)
    const metric = (policy: M17Job['policy'], estimator: Row['estimator']) => pooled(selected.filter((r) => r.policy === policy && r.estimator === estimator))
    const newRows = selected.filter((r) => r.estimator === 'guarded')
    const acceptedCount = newRows.reduce((s, r) => s + r.result.availableResidualCount, 0)
    originTable.push({ field, width, period, noise, realizations: newRows.length, wideM14: metric('wide-active', 'm14'),
      pairedM14: metric('paired-active', 'm14'), pairedM16: metric('paired-active', 'm16'), passiveM14: metric('fixed-passive', 'm14'),
      guardedCompleteRmse: metric('paired-active', 'guarded'),
      guardedAvailableOnlyRmse: acceptedCount ? Math.sqrt(newRows.reduce((s, r) => s + r.result.availableResidualSquaredError, 0) / acceptedCount) : null,
      guardedUsable: newRows.reduce((s, r) => s + r.result.finalUsable, 0), guardedPositive: newRows.reduce((s, r) => s + r.result.finalPositive, 0),
      finalDecisions: newRows.length * 6,
      selectedModels: Object.fromEntries(['m14', 'm16', 'abstain'].map((m) => [m, newRows.reduce((s, r) => s + r.result.selectedModels[m]!, 0)])) })
  }
  const analysis = { diagnosticOnly: true, verifiedArtifacts: inventory.inventory.length, verifiedSourceFiles: design.sourceInventory.length,
    replayedScores, regeneratedTrajectories: regenerated, sourceInventorySha256: design.sourceInventorySha256,
    elapsedWallSeconds: (Date.parse(summary.completedAt) - Date.parse(summary.startedAt)) / 1000, peakRssBytes: summary.peakRssBytes,
    gates, advancesToPhysicalPlumeDiagnostic: Object.values(gates).every(Boolean), dynamicCandidateRmse: dynamicCandidate,
    dynamicBaselineRmse: dynamicBaseline, noisyCandidateRmse: noisyCandidate, noisyBaselineRmse: noisyBaseline,
    noisyGuardedCasesMeetingCoverage: guardedNoisy.filter((r) => r.result.finalUsable >= 4).length,
    noisyGuardedUsableDecisions: guardedNoisy.reduce((s, r) => s + r.result.finalUsable, 0), noisyGuardedTotalDecisions: 336,
    guardDiagnostics, originTable, rows }
  const n = (v: number | null) => v === null ? 'N/A' : v.toFixed(4)
  const table = ['| Field | Width | Period | Noise | Wide/M14 | Paired/M14 | Paired/M16 | Passive/M14 | Guard usable | Guard selected-only RMSE |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|', ...originTable.map((r) =>
      `| ${r.field} | ${r.width} | ${r.period} | ${r.noise} | ${n(r.wideM14)} | ${n(r.pairedM14)} | ${n(r.pairedM16)} | ${n(r.passiveM14)} | ${r.guardedUsable}/${r.finalDecisions} | ${n(r.guardedAvailableOnlyRmse)} |`)].join('\n')
  const report = ['# M17 paired sniffs and excluded-pair prediction: verified diagnostic',
    `Decision: **${analysis.advancesToPhysicalPlumeDiagnostic ? 'PASS to further physical-plume development only' : 'DO NOT ADVANCE to a larger physical-plume benchmark'}**. No app, held-out world or inherited frozen source changed.`,
    `Verified ${analysis.verifiedArtifacts} artifacts and ${analysis.verifiedSourceFiles} frozen sources; all ${replayedScores} scores replayed and ${regenerated} predefined trajectories regenerated exactly. Main execution: ${analysis.elapsedWallSeconds.toFixed(3)} s, ${(analysis.peakRssBytes / 2 ** 30).toFixed(2)} GiB peak RSS, one Mac process; no AWS.`,
    '## Frozen gates', Object.entries(gates).map(([name, pass]) => `- ${name}: ${pass ? 'PASS' : 'FAIL'}`).join('\n'),
    '## What changed and what did not',
    'Nine 1-second slots use either one broad/passive return or two back-to-back 0.5-second broad/local returns. Total draw time and active model energy are matched; short-return marginal noise is higher. The new paired arm has twice as many cycles and nine reach switches. Switching delays, purge dynamics and real pump costs are not validated. Both active arms have four ideal turn seconds. This is not a pure pairing ablation against M16: cadence and cycle duration changed in all contemporaneous controls.',
    'The guarded policy fits and estimates derivatives only from data at or before the current pair start. All eight current returns are excluded, and used only for prediction validation. It prefers M16, falls back to M14 if independently validated, and otherwise abstains. No field truth is available to either choice. Prediction allowances exclude training fit RMS and have a fixed uncertainty cap; they remain heuristic, not calibrated confidence bounds.',
    '## Nominal-origin residual errors and guarded coverage', table,
    'Every zero-noise row contains one realization and every noisy row four, each scored at six common final decision times. Moving-field origin is not the instantaneous peak. Errors are in manufactured transport residual, NOT leak-coordinate localization error. Full off-origin and negative-control results are retained in JSON. Raw missing fits yield N/A. The last column deliberately reports only accepted forecasts WITH coverage: it must not be ranked as an unconditional algorithm RMSE.',
    `Across 12 changing zero-noise origin settings, pooled residual RMSE is ${n(dynamicBaseline)} for wide/M14 versus ${n(dynamicCandidate)} for raw paired/M16. Across all 14 noisy origin settings it is ${n(noisyBaseline)} versus ${n(noisyCandidate)}. The complete guarded policy is usable on ${analysis.noisyGuardedUsableDecisions}/336 decisions and meets four-of-six coverage in ${analysis.noisyGuardedCasesMeetingCoverage}/56 noisy cases.`,
    '## Guard diagnostics', '```json\n' + json(guardDiagnostics).trim() + '\n```',
    '## Scientific boundary',
    'Paired acquisition and an independent prediction check are testable algorithm components, not claims of unprecedented biological novelty. A good sensor forecast does not bound unobserved derivative error. Separable, moving and breathing Gaussians have manufactured forcing that can be distributed or signed; they do not establish soil-leak, landfill or urban GSL performance. Four noise realizations per condition are development evidence, not population superiority. No failed gate may be bypassed by retuning thresholds or selecting only favourable fields.',
    `Source inventory SHA-256: ${analysis.sourceInventorySha256}`,
  ].join('\n\n') + '\n'
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'm17-analysis.json'), json(analysis), { flag: 'wx' })
  await writeFile(join(output, 'm17-report.md'), report, { flag: 'wx' })
  await copyFile('scripts/m17-analyze-study.ts', join(output, 'analysis-source.ts'))
  const checksums = await Promise.all(['m17-analysis.json', 'm17-report.md', 'analysis-source.ts'].map(async (path) => {
    const b = await readFile(join(output, path)); return { path, bytes: b.length, sha256: hash(b) }
  }))
  await writeFile(join(output, 'analysis-checksums.json'), json(checksums), { flag: 'wx' })
  process.stdout.write(json({ ...analysis, rows: undefined, analysisSha256: hash(json(analysis)) }))
}
if (process.env.M17_ANALYSIS_RUN === '1') analyzeM17().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
