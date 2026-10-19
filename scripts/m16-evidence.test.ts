import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { simulateM16, scoreM16 } from './lib/m16-multiscale-study'

const root = 'research/evidence/m16_space_time_multiscale_2026-09-06'
const read = async (p: string) => JSON.parse(await readFile(join(root, p), 'utf8'))
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
it('verifies all M16 evidence artifacts and unchanged frozen sources', async () => {
  const design = await read('design.json'); const inventory = await read('checksums.json')
  expect(inventory.complete).toBe(true)
  expect(inventory.inventory).toHaveLength(392)
  expect(design.sourceInventory).toHaveLength(69)
  for (const [prefix, entries] of [['', inventory.inventory], ['source-snapshot/', design.sourceInventory]] as const) {
    for (const e of entries) {
      const b = await readFile(join(root, `${prefix}${e.path}`))
      expect(hash(b), e.path).toBe(e.sha256)
      expect(b.length, e.path).toBe(e.bytes)
      if (prefix) expect(hash(await readFile(e.path)), e.path).toBe(e.sha256)
    }
  }
})
it('regenerates the predefined six trajectories and checks the frozen noisy-error decision', async () => {
  const design = await read('design.json'); const summary = await read('summary.json')
  expect(summary.complete).toBe(true)
  expect(summary.trajectories).toBe(390)
  expect(summary.scoreRecords).toBe(7800)
  expect(design.verificationSubset).toHaveLength(6)
  for (const id of design.verificationSubset) {
    const r = await read(`${id}.json`)
    expect(JSON.stringify(simulateM16(r.observations.job))).toBe(JSON.stringify(r.observations))
    expect(JSON.stringify(scoreM16(r.observations))).toBe(JSON.stringify(r.analyses))
  }
  const analysisRoot = 'research/analysis/m16_space_time_multiscale_2026-09-06'
  const inventory = JSON.parse(await readFile(join(analysisRoot, 'analysis-checksums.json'), 'utf8'))
  for (const e of inventory) expect(hash(await readFile(join(analysisRoot, e.path)))).toBe(e.sha256)
  const analysis = JSON.parse(await readFile(join(analysisRoot, 'm16-analysis.json'), 'utf8'))
  const peaks = analysis.rows.filter((r: any) => r.field === 'gaussian' && r.offset === 0 && r.noise > 0)
  const candidate = peaks.filter((r: any) => r.policy === 'two-scale-active' && r.estimator === 'm16')
  const baseline = peaks.filter((r: any) => r.policy === 'wide-active' && r.estimator === 'm14')
  const rms = (rows: any[]) => Math.sqrt(rows.reduce((s, r) => s + r.result.residualRmse ** 2, 0) / rows.length)
  expect(candidate).toHaveLength(24); expect(baseline).toHaveLength(24)
  expect(rms(candidate)).toBe(analysis.noisyCandidateRmse)
  expect(rms(baseline)).toBe(analysis.noisyBaselineRmse)
  expect(analysis.gates.noisyPeakRmseNoWorse).toBe(rms(candidate) <= rms(baseline))
  expect(analysis.advancesToPhysicalPlumeDiagnostic).toBe(Object.values(analysis.gates).every(Boolean))
})
