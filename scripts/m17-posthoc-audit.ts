import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { scoreM17, simulateM17 } from './lib/m17-paired-study'

const root = 'research/evidence/m17_paired_prediction_2026-09-06'
const analysisRoot = 'research/analysis/m17_paired_prediction_2026-09-06'
const output = join(analysisRoot, 'posthoc')
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
/** Saved-data diagnosis only. Does not resimulate, select a new policy, retune a
 * threshold, or alter the preregistered pass/fail decision. */
export const auditM17 = async () => {
  const inventory = JSON.parse(await readFile(join(root, 'checksums.json'), 'utf8'))
  const analysisInventory = JSON.parse(await readFile(join(analysisRoot, 'analysis-checksums.json'), 'utf8'))
  const checked: Array<{ path: string; sha256: string }> = []
  const readChecked = async (base: string, path: string, entries: any[]) => {
    const e = entries.find((v) => v.path === path); const b = await readFile(join(base, path))
    if (!e || b.length !== e.bytes || hash(b) !== e.sha256) throw new Error(`Hash mismatch: ${path}`)
    checked.push({ path: join(base, path), sha256: e.sha256 }); return JSON.parse(b.toString())
  }
  const analysis = await readChecked(analysisRoot, 'm17-analysis.json', analysisInventory)
  const id = 'gaussian-w0.024-p0-x0-paired-active-n0.025-s17101.json'
  const raw = await readChecked(root, id, inventory.inventory) as { observations: ReturnType<typeof simulateM17>; analyses: ReturnType<typeof scoreM17> }
  const guard = raw.analyses.find((a) => a.estimator === 'guarded')!
  const cap = 0.15; const tolerance = 1e-4; const noise = 0.025
  const forecastGeometry = guard.records.slice(-6).map((r) => {
    if (!('complex' in r.evidence)) throw new Error('Missing forecast audit')
    const evidence = r.evidence
    return { time: r.time, models: (['complex', 'simple'] as const).map((model) => {
      const p = evidence[model]; const bound = p.maximumAllowance
      if (bound === null) throw new Error('Unavailable geometry allowance')
      return { model, maximumAllowance: bound, exceedsCapByFactor: bound / cap,
        maximumMarginalNoiseToMeetCap: noise * (cap - tolerance) / (bound - tolerance),
        predictionRmse: p.predictionRmse, reason: p.reason }
    }) }
  })
  const decompositions = []
  for (const width of [0.024, 0.042]) {
    const file = `gaussian-w${width}-p5-x0-paired-active-n0-s17101.json`
    const data = await readChecked(root, file, inventory.inventory) as typeof raw
    const rmse = (values: number[]) => Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length)
    for (const estimator of ['m14', 'm16'] as const) {
      const records = data.analyses.find((a) => a.estimator === estimator)!.records.slice(-6)
      if (records.some((r) => r.fit === null)) throw new Error('Cannot decompose missing fit')
      decompositions.push({ width, period: 5, estimator,
        fitRms: rmse(records.map((r) => r.fit!.fitRms)),
        residualErrorRms: rmse(records.map((r) => r.fit!.residual - r.truth.residual)),
        temporalErrorRms: rmse(records.map((r) => r.fit!.temporal - r.truth.temporal)),
        advectionErrorRms: rmse(records.map((r) => 0.018 * (r.fit!.gradient.x - r.truth.gradient.x) + 0.006 * (r.fit!.gradient.y - r.truth.gradient.y))),
        diffusionErrorRms: rmse(records.map((r) => -0.0004 * (r.fit!.laplacian - r.truth.laplacian))) })
    }
  }
  const noisy = analysis.originTable.filter((r: any) => r.noise === 0.025)
  const conditional = { originSettings: noisy.length,
    pairedM16LowerThanWideM14: noisy.filter((r: any) => r.pairedM16 < r.wideM14).length,
    lowestObservedErrorCounts: Object.fromEntries(['wideM14', 'pairedM14', 'pairedM16', 'passiveM14'].map((key) => [key,
      noisy.filter((r: any) => ['wideM14', 'pairedM14', 'pairedM16', 'passiveM14'].every((k) => r[key] <= r[k])).length])) }
  const audit = { postHoc: true, noPolicyChanges: true, advancesToPhysicalPlumeDiagnostic: analysis.advancesToPhysicalPlumeDiagnostic,
    inputHashes: checked, predictionCap: cap, forecastGeometry, decompositions, conditional }
  const report = ['# M17 saved-data audit (post hoc; no revised gates)',
    'The noisy guard failure is structurally predictable from the existing acquisition matrix and marginal-noise envelope, not merely from large observed forecast errors. In the representative unclipped steady-origin case, the complex model allowance is 1.1244 or 2.0974 and the simple allowance 0.3020 or 0.3782, all above the frozen 0.15 cap. These allowances use geometry and calibration, not fit RMS or field truth. A geometry-only feasibility check should precede any next candidate campaign.',
    'The noise ceilings below solve the existing linear allowance equation only. They are not recommendations to lower the simulated noise or claims that a real sensor can achieve them; meeting a cap would not establish prediction correctness or residual accuracy.',
    '```json\n' + json(forecastGeometry).trim() + '\n```',
    '## Rapid amplitude-pulse error decomposition on the SAME paired observations',
    '```json\n' + json(decompositions).trim() + '\n```',
    'RMS components are correlated and must not be added independently. This diagnosis does not isolate one causal mechanism or demonstrate that pairing itself caused an improvement over M16, because cadence/duration changed.',
    '## Condition dependence (descriptive only)',
    '```json\n' + json(conditional).trim() + '\n```',
    'A lowest observed error in four development realizations is not a statistically established algorithm winner. These are fixed-probe residual controls, not navigation, success-rate or real-leak localization results. The guarded policy has zero noisy-origin coverage and is excluded from any error ranking; its lack of false positives is not useful safety performance when it makes no usable decision.',
    'No threshold, model, seed, field, source archive or original analysis was changed. M17 remains a failed advancement candidate.',
  ].join('\n\n') + '\n'
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'audit.json'), json(audit), { flag: 'wx' })
  await writeFile(join(output, 'audit.md'), report, { flag: 'wx' })
  await copyFile('scripts/m17-posthoc-audit.ts', join(output, 'audit-source.ts'))
  const checksums = await Promise.all(['audit.json', 'audit.md', 'audit-source.ts'].map(async (path) => {
    const b = await readFile(join(output, path)); return { path, bytes: b.length, sha256: hash(b) }
  }))
  await writeFile(join(output, 'checksums.json'), json(checksums), { flag: 'wx' })
  process.stdout.write(json(audit))
}
if (process.env.M17_POSTHOC_RUN === '1') auditM17().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
