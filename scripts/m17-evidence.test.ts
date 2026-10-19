import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { m17Jobs, simulateM17, scoreM17 } from './lib/m17-paired-study'

const root = 'research/evidence/m17_paired_prediction_2026-09-06'
const read = async (p: string) => JSON.parse(await readFile(join(root, p), 'utf8'))
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
it('verifies all M17 artifacts and unchanged frozen source snapshots', async () => {
  const design = await read('design.json'); const inventory = await read('checksums.json')
  expect(inventory.complete).toBe(true); expect(inventory.inventory).toHaveLength(872)
  expect(design.sourceInventory).toHaveLength(74); expect(design.jobs).toEqual(m17Jobs())
  for (const [prefix, entries] of [['', inventory.inventory], ['source-snapshot/', design.sourceInventory]] as const) {
    for (const e of entries) {
      const b = await readFile(join(root, `${prefix}${e.path}`))
      expect(hash(b), e.path).toBe(e.sha256); expect(b.length, e.path).toBe(e.bytes)
      if (prefix) expect(hash(await readFile(e.path)), e.path).toBe(e.sha256)
    }
  }
})
it('regenerates 12 predefined trajectories and independently checks coverage/error gates', async () => {
  const design = await read('design.json'); const summary = await read('summary.json')
  expect(summary.complete).toBe(true); expect(summary.trajectories).toBe(870); expect(summary.scoreRecords).toBe(13050)
  expect(design.verificationSubset).toHaveLength(12)
  for (const id of design.verificationSubset) {
    const r = await read(`${id}.json`)
    expect(JSON.stringify(simulateM17(r.observations.job))).toBe(JSON.stringify(r.observations))
    expect(JSON.stringify(scoreM17(r.observations))).toBe(JSON.stringify(r.analyses))
  }
  const analysisRoot = 'research/analysis/m17_paired_prediction_2026-09-06'
  const inventory = JSON.parse(await readFile(join(analysisRoot, 'analysis-checksums.json'), 'utf8'))
  for (const e of inventory) {
    const b = await readFile(join(analysisRoot, e.path))
    expect(hash(b)).toBe(e.sha256); expect(b.length).toBe(e.bytes)
  }
  const analysis = JSON.parse(await readFile(join(analysisRoot, 'm17-analysis.json'), 'utf8'))
  const origins = analysis.rows.filter((r: any) => !['wave', 'zero'].includes(r.field) && r.offset === 0 && r.noise > 0)
  const candidate = origins.filter((r: any) => r.policy === 'paired-active' && r.estimator === 'm16')
  const baseline = origins.filter((r: any) => r.policy === 'wide-active' && r.estimator === 'm14')
  const guarded = origins.filter((r: any) => r.estimator === 'guarded')
  const rms = (rows: any[]) => rows.every((r) => r.result.residualRmse !== null)
    ? Math.sqrt(rows.reduce((s, r) => s + r.result.residualRmse ** 2, 0) / rows.length) : null
  expect(candidate).toHaveLength(56); expect(baseline).toHaveLength(56); expect(guarded).toHaveLength(56)
  expect(rms(candidate)).toBe(analysis.noisyCandidateRmse); expect(rms(baseline)).toBe(analysis.noisyBaselineRmse)
  expect(analysis.gates.noisyOriginRmseNoWorse).toBe(candidate.every((r: any) => r.result.finalRawFits === 6) &&
    rms(candidate) !== null && rms(baseline) !== null && rms(candidate)! <= rms(baseline)!)
  expect(analysis.gates.guardedNoisyOriginCoverage).toBe(guarded.every((r: any) => r.result.finalUsable >= 4))
  expect(analysis.noisyGuardedUsableDecisions).toBe(guarded.reduce((s: number, r: any) => s + r.result.finalUsable, 0))
  expect(analysis.advancesToPhysicalPlumeDiagnostic).toBe(Object.values(analysis.gates).every(Boolean))
  for (const row of analysis.rows) {
    if (row.result.finalRawFits < 6) expect(row.result.residualRmse).toBeNull()
    if (row.estimator === 'guarded') expect(Object.values(row.result.selectedModels).reduce((s: number, v: any) => s + v, 0)).toBe(6)
  }
})
it('verifies the separately labelled post-hoc audit without altering the frozen decision', async () => {
  const folder = 'research/analysis/m17_paired_prediction_2026-09-06/posthoc'
  const checksums = JSON.parse(await readFile(join(folder, 'checksums.json'), 'utf8'))
  for (const e of checksums) {
    const b = await readFile(join(folder, e.path))
    expect(hash(b)).toBe(e.sha256); expect(b.length).toBe(e.bytes)
  }
  const audit = JSON.parse(await readFile(join(folder, 'audit.json'), 'utf8'))
  expect(audit.postHoc).toBe(true); expect(audit.noPolicyChanges).toBe(true)
  for (const e of audit.inputHashes) expect(hash(await readFile(e.path))).toBe(e.sha256)
  for (const r of audit.forecastGeometry) for (const m of r.models) {
    expect(m.maximumAllowance).toBeGreaterThan(audit.predictionCap)
    expect(m.maximumMarginalNoiseToMeetCap).toBeCloseTo(0.025 * (0.15 - 1e-4) / (m.maximumAllowance - 1e-4), 14)
  }
  const analysis = JSON.parse(await readFile('research/analysis/m17_paired_prediction_2026-09-06/m17-analysis.json', 'utf8'))
  expect(audit.advancesToPhysicalPlumeDiagnostic).toBe(analysis.advancesToPhysicalPlumeDiagnostic)
  const noisy = analysis.originTable.filter((r: any) => r.noise === 0.025)
  expect(audit.conditional.pairedM16LowerThanWideM14).toBe(noisy.filter((r: any) => r.pairedM16 < r.wideM14).length)
  for (const [key, count] of Object.entries(audit.conditional.lowestObservedErrorCounts)) {
    expect(count).toBe(noisy.filter((r: any) => ['wideM14', 'pairedM14', 'pairedM16', 'passiveM14'].every((k) => r[key] <= r[k])).length)
  }
})
