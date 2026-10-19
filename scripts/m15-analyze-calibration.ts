import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { M15_CALIBRATION, m15Jobs } from './lib/m15-manufactured-fields'
import { simulateCalibration, analyzeCalibration, type CalibrationObservations } from './lib/m15-measurement-calibration'

const root = 'research/evidence/m15_measurement_calibration_2026-09-06'
const output = 'research/analysis/m15_measurement_calibration_2026-09-06'
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
const read = async (p: string) => JSON.parse(await readFile(join(root, p), 'utf8'))
const safe = (p: string) => { if (p.startsWith('/') || p.split('/').includes('..')) throw new Error('Unsafe archive path'); return p }
const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
const rms = (v: number[]) => v.length ? Math.sqrt(mean(v.map((x) => x * x))!) : null
type Analysis = ReturnType<typeof analyzeCalibration>[number]
type Stored = { observations: CalibrationObservations; analyses: Analysis[] }
type Group = { metadata: Record<string, unknown>; values: Analysis['summary'][]; noiseChanges: number[]; deliveryChanges: number[] }
export const analyzeM15 = async () => {
  const design = await read('design.json'); const summary = await read('summary.json'); const inventory = await read('checksums.json')
  if (!summary.complete || !inventory.complete || summary.trajectories !== 1440 || summary.windowAnalyses !== 2880 ||
      summary.scoreRecords !== 34560 || summary.summaries.length !== 1440 || json(design.jobs) !== json(m15Jobs()) ||
      json(design.calibration) !== json(M15_CALIBRATION)) throw new Error('Incomplete or changed M15 design')
  const expected = ['design.json', 'summary.json', ...design.jobs.map((j: any) => `${j.id}.json`)].sort()
  if (json(inventory.inventory.map((e: any) => e.path).sort()) !== json(expected)) throw new Error('Wrong artifact inventory')
  for (const e of inventory.inventory) {
    const b = await readFile(join(root, safe(e.path)))
    if (hash(b) !== e.sha256 || b.length !== e.bytes) throw new Error(`Evidence hash mismatch: ${e.path}`)
  }
  if (hash(json(design.sourceInventory)) !== design.sourceInventorySha256 || summary.sourceInventorySha256 !== design.sourceInventorySha256) throw new Error('Source binding mismatch')
  for (const e of design.sourceInventory) {
    const b = await readFile(join(root, 'source-snapshot', safe(e.path)))
    if (hash(b) !== e.sha256 || b.length !== e.bytes || hash(await readFile(e.path)) !== e.sha256) throw new Error(`Source changed: ${e.path}`)
  }
  const samples = new Set<string>(design.verificationSubset)
  const groups = new Map<string, Group>()
  const controls = new Map<string, Stored>()
  const sourceFreePositive = []; let replayedScores = 0; let regenerated = 0
  for (const job of design.jobs) {
    const r = await read(`${job.id}.json`) as Stored
    if (json(r.observations.job) !== json(job) || r.observations.scans.length !== 12 ||
        r.observations.scans.some((s, i) => s.time !== 10.75 + i * 2.5) ||
        json(r.observations.budget) !== json({ horizon: 40, cycles: 12, samplingSeconds: 9,
          turningSeconds: job.policy === 'sniff-turn' ? 5.5 : 0, pathLength: 0 })) throw new Error(`Schedule/identity mismatch: ${job.id}`)
    const replay = analyzeCalibration(r.observations)
    if (json(replay) !== json(r.analyses)) throw new Error(`Score replay mismatch: ${job.id}`)
    const summaryRow = summary.summaries.find((s: any) => s.job.id === job.id)
    if (json(summaryRow) !== json({ job, windows: replay.map(({ window, summary: s }) => ({ window, ...s })) })) throw new Error('Summary mismatch')
    replayedScores += 24
    if (samples.has(job.id)) {
      if (json(simulateCalibration(job)) !== json(r.observations)) throw new Error(`Regeneration mismatch: ${job.id}`)
      regenerated++
    }
    const controlId = job.id.replace(/-n[^-]+-s\d+$/, '-n0-s15101')
    if (job.noise === 0) controls.set(job.id, r)
    const control = controls.get(controlId)
    if (!control) throw new Error('Missing paired zero-noise control')
    const priorDeliveryId = job.delivery === 'midpoint' ? null : controlId.replace(`-${job.delivery}-n0`, `-${job.delivery === 'sensor' ? 'integrated' : 'midpoint'}-n0`)
    const priorDelivery = priorDeliveryId ? controls.get(priorDeliveryId) : null
    if (priorDeliveryId && !priorDelivery) throw new Error('Missing delivery ablation')
    for (const [w, analysis] of r.analyses.entries()) {
      const { id: _id, anchor: _anchor, seed: _seed, ...factors } = job
      const metadata = { ...factors, window: analysis.window }
      const key = json(metadata)
      const group: Group = groups.get(key) ?? { metadata, values: [], noiseChanges: [], deliveryChanges: [] }
      group.values.push(analysis.summary)
      for (const [i, record] of analysis.records.entries()) {
        if (i < 6 || !record.fit) continue
        const baseline = control.analyses[w]!.records[i]!.fit
        if (job.noise > 0 && baseline) group.noiseChanges.push(record.fit.residual - baseline.residual)
        const previous = priorDelivery?.analyses[w]!.records[i]!.fit
        if (job.noise === 0 && previous) group.deliveryChanges.push(record.fit.residual - previous.residual)
      }
      groups.set(key, group)
      if (job.field === 'source-free-wave' && analysis.summary.positive >= 4) sourceFreePositive.push({ id: job.id, window: analysis.window, positive: analysis.summary.positive })
    }
  }
  if (regenerated !== 12 || replayedScores !== 34560) throw new Error('Incomplete independent verification')
  const strata = [...groups.values()].map(({ metadata, values, noiseChanges, deliveryChanges }) => ({ ...metadata,
    trajectories: values.length, finalScans: values.length * 6,
    usableScans: values.reduce((s, v) => s + v.usable, 0), positiveScans: values.reduce((s, v) => s + v.positive, 0),
    rawFitCount: values.reduce((s, v) => s + v.rawFits, 0),
    residualRmse: rms(values.flatMap((v) => v.residualRmse === null ? [] : [v.residualRmse])),
    temporalRmse: rms(values.flatMap((v) => v.temporalRmse === null ? [] : [v.temporalRmse])),
    laplacianRmse: rms(values.flatMap((v) => v.laplacianRmse === null ? [] : [v.laplacianRmse])),
    gradientRmse: rms(values.flatMap((v) => v.gradientRmse === null ? [] : [v.gradientRmse])),
    residualBias: mean(values.flatMap((v) => v.residualBias === null ? [] : [v.residualBias])),
    noiseInducedResidualRms: rms(noiseChanges), precedingDeliveryResidualRms: rms(deliveryChanges),
  }))
  const result = { diagnosticOnly: true, candidatePromoted: false, verifiedArtifacts: inventory.inventory.length,
    verifiedSourceFiles: design.sourceInventory.length, regeneratedTrajectories: regenerated, replayedScores,
    sourceInventorySha256: design.sourceInventorySha256,
    elapsedWallSeconds: (Date.parse(summary.completedAt) - Date.parse(summary.startedAt)) / 1000,
    peakRssBytes: summary.peakRssBytes, sourceFreePositive, strata }
  const n = (v: unknown) => typeof v === 'number' ? v.toFixed(4) : 'N/A'
  const selected = strata.filter((s: any) => s.field === 'gaussian-steady' && s.offset === 0 && s.delivery === 'sensor' && s.window === 6)
  const table = ['| Geometry / bearing | Noise | Residual RMSE | Noise-induced RMS | Usable final scans |',
    '|---|---:|---:|---:|---:|', ...selected.map((s: any) => `| ${s.sensing} r=${s.reach} / ${s.policy} | ${s.noise} | ${n(s.residualRmse)} | ${n(s.noiseInducedResidualRms)} | ${s.usableScans}/${s.finalScans} |`)].join('\n')
  const temporal = strata.filter((s: any) => s.offset === 0 && s.sensing === 'active-suction' && s.reach === 0.065 && s.policy === 'sniff-turn' && s.noise === 0)
  const timeTable = ['| Field | Delivery | Window (s) | Residual RMSE | Ct RMSE | Change from preceding delivery (RMS) | Usable / 6 |',
    '|---|---|---:|---:|---:|---:|---:|', ...temporal.map((s: any) => `| ${s.field} | ${s.delivery} | ${s.window} | ${n(s.residualRmse)} | ${n(s.temporalRmse)} | ${n(s.precedingDeliveryResidualRms)} | ${s.usableScans}/6 |`)].join('\n')
  const report = ['# M15 controlled measurement-error calibration',
    'All results below are descriptive calibration of manufactured fields. They are not autonomous GSL performance, novel-algorithm evidence, or field validation. No controller or decision threshold was changed.',
    `Verified ${result.verifiedArtifacts} evidence artifacts and ${result.verifiedSourceFiles} source snapshots; replayed ${replayedScores} scores and regenerated ${regenerated} predefined trajectories exactly. The primary batch took ${n(result.elapsedWallSeconds)} s on one Mac process, peak RSS ${(result.peakRssBytes / 2 ** 30).toFixed(2)} GiB. No AWS.`,
    '## Static Gaussian peak: footprint/noise tradeoff', table,
    'RMSE is against the exact local residual at return time. Noise-induced RMS compares each noisy reconstruction with its zero-noise counterpart. The zero-noise strata have one trajectory; noisy strata have four paired realizations. Unthresholded coefficient errors remain visible even if the frozen M14 condition gate rejects the fit; those estimates are diagnostic only. Active/passive footprints and hardware energy are not matched.',
    '## Temporal and delivery decomposition', timeTable,
    'Midpoint → integrated changes only aspiration averaging; integrated → sensor adds the frozen fast sensor response. Differences between 4 s and 6 s also change sample count and orientation balance, not just temporal bias. The model basis and condition threshold remain frozen. These are controlled contrasts, not a claim that one error component caused every M14 failure.',
    '## Exact source-free control',
    `${sourceFreePositive.length} source-free-wave window analyses have at least four positive checks among the final six. These are diagnostic false-source-evidence cases, not actual robot declarations. Exact analytical R is zero; a positive residual from approximation/noise is a calibration failure. The complete affected id list is retained in the JSON.`,
    '## Scope and next use',
    'Gaussian offsets are distances from a prescribed concentration peak, not leak-coordinate errors. The constructed forcing can be distributed or signed; a positive exact residual 1.5% from the peak does not establish a false point-source declaration. The wave is a true zero-residual mathematical control, not a turbulent urban plume. No geometry clipping or uncertain wind is varied here, and four noise realizations do not calibrate confidence levels.',
    'Use the error decomposition to design an uncertainty-aware, multi-scale confirmation test with independent negative controls. Do not select a smaller footprint solely for noiseless accuracy or shorten the window solely for responsiveness. No revision advances automatically from this calibration, and the app remains at the unchanged M12 controller.',
    `Source inventory SHA-256: ${result.sourceInventorySha256}`,
  ].join('\n\n') + '\n'
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'm15-calibration-analysis.json'), json(result), { flag: 'wx' })
  await writeFile(join(output, 'm15-calibration-report.md'), report, { flag: 'wx' })
  await copyFile('scripts/m15-analyze-calibration.ts', join(output, 'analysis-source.ts'))
  const checksums = await Promise.all(['m15-calibration-analysis.json', 'm15-calibration-report.md', 'analysis-source.ts'].map(async (path) => {
    const b = await readFile(join(output, path)); return { path, bytes: b.length, sha256: hash(b) }
  }))
  await writeFile(join(output, 'analysis-checksums.json'), json(checksums), { flag: 'wx' })
  process.stdout.write(json({ ...result, strata: selected, analysisSha256: hash(json(result)) }))
}
if (process.env.M15_ANALYSIS_RUN === '1') analyzeM15().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1
})
