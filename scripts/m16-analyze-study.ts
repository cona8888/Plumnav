import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { m16Jobs, m16Reach, simulateM16, scoreM16, type M16Job } from './lib/m16-multiscale-study'
import { M16_POLICY } from './lib/m16-space-time-evidence'

const root = 'research/evidence/m16_space_time_multiscale_2026-09-06'
const output = 'research/analysis/m16_space_time_multiscale_2026-09-06'
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
const read = async (p: string) => JSON.parse(await readFile(join(root, p), 'utf8'))
const safe = (p: string) => { if (p.startsWith('/') || p.split('/').includes('..')) throw new Error('Unsafe archive path'); return p }
type EstimatorSummary = ReturnType<typeof scoreM16>[number]['summary']
type Row = M16Job & { estimator: 'm14' | 'm16'; result: EstimatorSummary }
const pooled = (rows: Row[]) => rows.length && rows.every((r) => r.result.residualRmse !== null)
  ? Math.sqrt(rows.reduce((s, r) => s + r.result.residualRmse! ** 2, 0) / rows.length) : null
export const analyzeM16 = async () => {
  const design = await read('design.json'); const summary = await read('summary.json'); const inventory = await read('checksums.json')
  if (!summary.complete || !inventory.complete || summary.trajectories !== 390 || summary.scoreRecords !== 7800 ||
      summary.summaries.length !== 390 || json(design.jobs) !== json(m16Jobs()) || json(design.policy) !== json(M16_POLICY)) throw new Error('Incomplete or changed design')
  const expected = ['design.json', 'summary.json', ...design.jobs.map((j: M16Job) => `${j.id}.json`)].sort()
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
  for (const job of design.jobs as M16Job[]) {
    const r = await read(`${job.id}.json`) as { observations: ReturnType<typeof simulateM16>; analyses: ReturnType<typeof scoreM16> }
    if (json(r.observations.job) !== json(job) || r.observations.sensorLag !== 0.05 || r.observations.scans.length !== 12 ||
        r.observations.scans.some((s, i) => s.time !== 10.75 + 2.5 * i || s.quad.readings!.some((q) => q.reach !== m16Reach(job, i))) ||
        json(r.observations.budget) !== json({ horizon: 40, cycles: 12, samplingSeconds: 9,
          turningSeconds: job.policy === 'fixed-passive' ? 0 : 5.5, pathLength: 0,
          reachSequence: Array.from({ length: 12 }, (_, i) => m16Reach(job, i)) })) throw new Error('Job or schedule mismatch')
    const replay = scoreM16(r.observations)
    if (json(replay) !== json(r.analyses)) throw new Error(`Score mismatch: ${job.id}`)
    if (json(summary.summaries.find((s: any) => s.job.id === job.id)) !== json({ job,
      estimators: replay.map(({ estimator, summary: result }) => ({ estimator, ...result })) })) throw new Error('Summary mismatch')
    replayedScores += replay.reduce((n, a) => n + a.records.length, 0)
    if (subset.has(job.id)) {
      if (json(simulateM16(job)) !== json(r.observations)) throw new Error(`Forward regeneration mismatch: ${job.id}`)
      regenerated++
    }
    for (const a of replay) rows.push({ ...job, estimator: a.estimator, result: a.summary })
  }
  if (replayedScores !== 7800 || regenerated !== 6 || rows.length !== 650) throw new Error('Missing verification records')
  const candidate = rows.filter((r) => r.policy === 'two-scale-active' && r.estimator === 'm16')
  const peaks = candidate.filter((r) => r.field === 'gaussian' && r.offset === 0)
  const comparator = (r: Row) => rows.find((v) => v.field === r.field && v.width === r.width && v.period === r.period &&
    v.offset === r.offset && v.noise === r.noise && v.seed === r.seed && v.policy === 'wide-active' && v.estimator === 'm14')!
  const zeroSteady = peaks.filter((r) => r.noise === 0 && r.period === 0)
  const zeroPulsing = peaks.filter((r) => r.noise === 0 && r.period > 0)
  const noisyPeaks = peaks.filter((r) => r.noise > 0)
  const pulsingCandidate = pooled(zeroPulsing); const pulsingBaseline = pooled(zeroPulsing.map(comparator))
  const noisyCandidate = pooled(noisyPeaks); const noisyBaseline = pooled(noisyPeaks.map(comparator))
  const gates = {
    integrityAndMatchedAcquisition: true,
    steadyBiasImprovedBothWidths: zeroSteady.length === 2 && zeroSteady.every((r) => r.result.residualRmse !== null && comparator(r).result.residualRmse !== null &&
      r.result.residualRmse <= 0.75 * comparator(r).result.residualRmse!),
    pulsingMseImproved: zeroPulsing.length === 4 && pulsingCandidate !== null && pulsingBaseline !== null && pulsingCandidate ** 2 <= 0.8 * pulsingBaseline ** 2,
    noPulsingSettingRegressed: zeroPulsing.length === 4 && zeroPulsing.every((r) => r.result.residualRmse !== null && comparator(r).result.residualRmse !== null &&
      r.result.residualRmse <= 1.1 * comparator(r).result.residualRmse!),
    noisyPeakRmseNoWorse: noisyPeaks.length === 24 && noisyCandidate !== null && noisyBaseline !== null && noisyCandidate <= noisyBaseline,
    noisyPeakCoverage: noisyPeaks.length === 24 && noisyPeaks.every((r) => r.result.finalRawFits === 6 && r.result.finalUsable >= 4),
    noNegativeControlCasePositive: candidate.filter((r) => r.field !== 'gaussian').length === 10 && candidate.filter((r) => r.field !== 'gaussian').every((r) => !r.result.casePositive),
  }
  const peakTable = []
  for (const width of [0.024, 0.042]) for (const period of [0, 5, 12]) for (const noise of [0, 0.025]) {
    const selected = rows.filter((r) => r.field === 'gaussian' && r.offset === 0 && r.width === width && r.period === period && r.noise === noise)
    const metric = (policy: M16Job['policy'], estimator: Row['estimator']) => pooled(selected.filter((r) => r.policy === policy && r.estimator === estimator))
    const newRows = selected.filter((r) => r.policy === 'two-scale-active' && r.estimator === 'm16')
    peakTable.push({ width, period, noise, realizations: newRows.length,
      wideM14: metric('wide-active', 'm14'), twoScaleM14: metric('two-scale-active', 'm14'),
      wideM16: metric('wide-active', 'm16'), twoScaleM16: metric('two-scale-active', 'm16'), passiveM14: metric('fixed-passive', 'm14'),
      candidateUsable: newRows.reduce((s, r) => s + r.result.finalUsable, 0), candidatePositive: newRows.reduce((s, r) => s + r.result.finalPositive, 0),
      finalScans: newRows.length * 6 })
  }
  const analysis = { diagnosticOnly: true, verifiedArtifacts: inventory.inventory.length, verifiedSourceFiles: design.sourceInventory.length,
    replayedScores, regeneratedTrajectories: regenerated, sourceInventorySha256: design.sourceInventorySha256,
    elapsedWallSeconds: (Date.parse(summary.completedAt) - Date.parse(summary.startedAt)) / 1000, peakRssBytes: summary.peakRssBytes,
    gates, advancesToPhysicalPlumeDiagnostic: Object.values(gates).every(Boolean),
    pulsingCandidateRmse: pulsingCandidate, pulsingBaselineRmse: pulsingBaseline, noisyCandidateRmse: noisyCandidate, noisyBaselineRmse: noisyBaseline,
    peakTable, rows }
  const n = (v: number | null) => v === null ? 'N/A' : v.toFixed(4)
  const table = ['| Width | Period (s; 0=steady) | Noise | Wide/M14 | Two-scale/M14 | Two-scale/M16 | Passive/M14 | M16 usable | M16 positive |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|', ...peakTable.map((r) =>
      `| ${r.width} | ${r.period} | ${r.noise} | ${n(r.wideM14)} | ${n(r.twoScaleM14)} | ${n(r.twoScaleM16)} | ${n(r.passiveM14)} | ${r.candidateUsable}/${r.finalScans} | ${r.candidatePositive}/${r.finalScans} |`)].join('\n')
  const report = ['# M16 two-scale space/time candidate: verified parameter-transfer study',
    `Decision: **${analysis.advancesToPhysicalPlumeDiagnostic ? 'PASS to further physical-plume development only' : 'DO NOT ADVANCE to a larger physical-plume benchmark'}**. No live controller, M14/M15 rule or held-out scenario partition was changed.`,
    `Verified ${analysis.verifiedArtifacts} artifacts and ${analysis.verifiedSourceFiles} frozen sources; all ${replayedScores} scores replayed and ${regenerated} predefined forward trajectories regenerated exactly. One Mac process: ${analysis.elapsedWallSeconds.toFixed(3)} s, ${(analysis.peakRssBytes / 2 ** 30).toFixed(2)} GiB peak RSS; no AWS.`,
    '## Frozen gates', Object.entries(gates).map(([name, pass]) => `- ${name}: ${pass ? 'PASS' : 'FAIL'}`).join('\n'),
    '## Peak residual RMSE and source-evidence checks', table,
    'Each zero-noise row is one trajectory, each noisy row four paired realizations, with six evaluated returns per trajectory. These are conditional errors in manufactured fields, not population performance or localization error. All off-peak and negative-control rows remain in the JSON. Missing raw fits yield N/A, not favourable-case averaging.',
    `Across the four modulated zero-noise peaks, pooled residual RMSE is ${n(pulsingBaseline)} for wide/M14 and ${n(pulsingCandidate)} for two-scale/M16. Across all six noisy peak settings, it is ${n(noisyBaseline)} versus ${n(noisyCandidate)}.`,
    '## Model and comparison interpretation',
    'M16 adds time curvature, gradient/time terms, isotropic curvature/time coupling and a radial fourth-order term, integrating observation moments through aspiration. Its single-reach ablation cannot generally separate radial fourth-order curvature from the Laplacian; those unidentifiable fits are deliberately retained as unavailable. Two reaches are information needed by this model, not evidence that every GSL method needs two reaches.',
    'The new model reports physical residual uncertainty rather than applying M14’s condition-200 cutoff to a different basis. It retains rank/operator reconstruction checks and the three-scale L1 noise/fit allowance. This is an explicitly changed research decision policy, not an improved calibrated confidence interval. A finite fit, a smaller derivative error, positive source evidence and an accurately localized leak coordinate remain separate outcomes.',
    'Acquisition is matched for active arms: twelve slots, six broad/six local cycles for two-scale, equal 9-second aspiration time and 5.5 ideal turning seconds. Variable reach is an observation-model capability, not a validated real nozzle or energy-neutral pump adjustment. Sensor lag remains a model mismatch; complex geometry and uncertain wind were not exercised by this parameter-transfer study.',
    '## Scientific limits and next decision',
    'The widths and periods differ from M15 but belong to the same manufactured family. Gaussian forcing can be distributed or signed, so peak offsets are not point-leak truth. Source-free and zero fields are mathematical controls, not field data. Passing would authorize only the next development diagnostic. A failed noise, coverage or regime-regression gate must not be bypassed by choosing only favourable widths or periods, changing thresholds after outcomes, or opening held-out worlds.',
    `Source inventory SHA-256: ${analysis.sourceInventorySha256}`,
  ].join('\n\n') + '\n'
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'm16-analysis.json'), json(analysis), { flag: 'wx' })
  await writeFile(join(output, 'm16-report.md'), report, { flag: 'wx' })
  await copyFile('scripts/m16-analyze-study.ts', join(output, 'analysis-source.ts'))
  const checksums = await Promise.all(['m16-analysis.json', 'm16-report.md', 'analysis-source.ts'].map(async (path) => {
    const b = await readFile(join(output, path)); return { path, bytes: b.length, sha256: hash(b) }
  }))
  await writeFile(join(output, 'analysis-checksums.json'), json(checksums), { flag: 'wx' })
  process.stdout.write(json({ ...analysis, rows: undefined, analysisSha256: hash(json(analysis)) }))
}
if (process.env.M16_ANALYSIS_RUN === '1') analyzeM16().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
