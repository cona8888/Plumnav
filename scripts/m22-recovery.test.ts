import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { recoveryDecision, runM22, M22_ARMS } from './lib/m22-recovery'
import { directionDecision } from './lib/m21-direction'
import { M22_ROOT } from './m22-recovery-study'
const c = { slopes: [1, 1, 1, 1], offsets: [0, 0, 0, 0], rawVariance: 0.00001, correctedVariance: 0.00001 }
it('rejects stale and future inputs and keeps exploration explicitly separate', () => {
  const views = [0, 1, 2, 3].map((i) => ({ heading: 0, time: 8.5 + i, values: [0.6, 0.5, 0.4, 0.5] }))
  expect(recoveryDecision(views, c, 'calibrated-recovery', 11.5).action.kind).toBe('follow')
  for (const time of [10, 12, NaN]) {
    const d = recoveryDecision(views, c, 'calibrated-recovery', time)
    expect(d.direction).toBeNull(); expect(d.action.kind).toBe('explore'); expect(d.action.executedDistance).toBe(0)
  }
  const rotating = views.map((v, i) => ({ ...v, heading: i < 2 ? Math.PI : 0 }))
  expect(recoveryDecision(rotating, c, 'calibrated-consistent', 11.5).direction).toBeNull()
  expect(recoveryDecision(rotating, c, 'calibrated-recovery', 11.5).stage).toBe('recent-pair')
  expect(recoveryDecision(rotating, c, 'calibrated-recovery', 11.5).direction?.x).toBe(1)
})
it('preserves inherited pooled and consistent algebra and raw calibration independence', () => {
  const views = [0, 1, 2, 3].map((i) => ({ heading: i * Math.PI / 2, time: 8.5 + i, values: [0.6, 0.4, 0.5, 0.5] }))
  for (const [arm, rule] of [['raw-pooled', 'raw'], ['calibrated-pooled', 'calibrated'], ['calibrated-consistent', 'rotation-consistent']] as const)
    expect(recoveryDecision(views, c, arm, 11.5).direction).toEqual(directionDecision(views, c, rule).direction)
  expect(recoveryDecision(views, { ...c, slopes: [1.2, 0.8, 1.1, 0.9] }, 'raw-consistent', 11.5).direction)
    .toEqual(recoveryDecision(views, c, 'raw-consistent', 11.5).direction)
})
it.skipIf(process.env.M22_VERIFY !== '1')('verifies frozen inputs, exact replay and all independent angles and cell counts', async () => {
  const read = async (p: string) => JSON.parse(await readFile(`${M22_ROOT}/${p}`, 'utf8'))
  const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
  const design = await read('design.json'); const inventory = await read('checksums.json')
  expect(design.sourceInventory).toHaveLength(96); expect(inventory.complete).toBe(true)
  for (const e of inventory.inventory) expect(hash(await readFile(`${M22_ROOT}/${e.path}`))).toBe(e.sha256)
  for (const e of design.sourceInventory) {
    expect(hash(await readFile(`${M22_ROOT}/source-snapshot/${e.path}`))).toBe(e.sha256)
    expect(hash(await readFile(e.path))).toBe(e.sha256)
  }
  const r = runM22(); expect(JSON.stringify(r) + '\n').toBe(await readFile(`${M22_ROOT}/results.json`, 'utf8'))
  expect(JSON.stringify(r.summary) + '\n').toBe(await readFile(`${M22_ROOT}/summary.json`, 'utf8'))
  expect(r.calibrations).toHaveLength(35); expect(r.episodes).toHaveLength(5600)
  expect(new Set(r.episodes.map((e) => e.seed)).size).toBe(5600)
  for (const e of r.episodes) {
    expect(e.seed).toBeGreaterThanOrEqual(200000); expect(e.decisions).toHaveLength(6)
    for (const d of e.decisions) {
      expect(d.action.kind).toBe(d.direction ? 'follow' : 'explore')
      expect(Math.hypot(d.action.direction.x, d.action.direction.y)).toBeCloseTo(1, 12)
      expect(d.action.executedDistance).toBe(0)
      if (d.direction && !e.nullDirection) {
        const a = Math.atan2(d.direction.y, d.direction.x) - Math.atan2(e.gradient.y, e.gradient.x)
        expect(d.angleError).toBeCloseTo(Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) * 180 / Math.PI, 8)
      } else expect(d.angleError).toBeNull()
    }
  }
  for (const cell of r.summary.cells) {
    expect(cell.episodes).toBe(100); expect(cell.accepted + cell.explore).toBe(100)
    const ds = r.episodes.filter((e) => e.field === cell.field && e.nuisance === cell.nuisance).flatMap((e) => e.decisions.filter((d) => d.arm === cell.arm))
    expect(cell.accepted).toBe(ds.filter((d) => d.direction).length)
    expect(cell.wrong).toBe(ds.filter((d) => d.angleError !== null && d.angleError > 45).length)
  }
  for (const mode of ['raw', 'calibrated'] as const) {
    const cells = r.summary.cells.filter((c) => c.arm === `${mode}-recovery`)
    const failures = cells.filter((c) => c.nullDirection ? c.accepted / 100 > 0.05 :
      (c.accepted > 0 && c.wrong / c.accepted > 0.05) || (['linear', 'off-peak', 'turning'].includes(c.field) && c.accepted / 100 < 0.5))
    expect(failures).toEqual(r.summary.recoveryFailures[mode])
  }
  expect(M22_ARMS).toHaveLength(6)
})
