import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { runM22 } from './lib/m22-recovery'
import { M22_ROOT } from './m22-recovery-study'
// The frozen opt-in verifier compares acos/atan2 in degrees at near-zero angles,
// where acos is ill-conditioned. Preserve it; use stable cosine agreement and
// independent atan2-based scientific classifications instead. No gate changes.
it('replays M22 bytes and independently validates stable angles, actions and every gate', async () => {
  const read = async (p: string) => JSON.parse(await readFile(`${M22_ROOT}/${p}`, 'utf8'))
  const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
  const design = await read('design.json'); const inventory = await read('checksums.json')
  expect(design.sourceInventory).toHaveLength(96); expect(inventory.complete).toBe(true)
  for (const e of inventory.inventory) {
    const b = await readFile(`${M22_ROOT}/${e.path}`); expect(hash(b)).toBe(e.sha256); expect(b.length).toBe(e.bytes)
  }
  for (const e of design.sourceInventory) {
    expect(hash(await readFile(`${M22_ROOT}/source-snapshot/${e.path}`))).toBe(e.sha256)
    expect(hash(await readFile(e.path))).toBe(e.sha256)
  }
  const r = runM22()
  for (const [name, value] of [['results.json', r], ['summary.json', r.summary]] as const) {
    const text = JSON.stringify(value) + '\n'
    expect(text).toBe(await readFile(`${M22_ROOT}/${name}`, 'utf8'))
    expect(text).toBe(await readFile(`research/evidence/m22_recovery_provisional_typing_2026-09-08/${name}`, 'utf8'))
  }
  expect(r.calibrations).toHaveLength(35); expect(r.episodes).toHaveLength(5600)
  expect(new Set(r.episodes.map((e) => e.seed)).size).toBe(5600)
  let count = 0
  for (const e of r.episodes) {
    expect(e.seed).toBeGreaterThanOrEqual(200000); expect(e.decisions).toHaveLength(6)
    expect(r.calibrations.some((c) => c.seed === e.seed)).toBe(false)
    for (const d of e.decisions) {
      count++
      expect(d.action.kind).toBe(d.direction ? 'follow' : 'explore')
      expect(d.action.plannedDistance).toBe(0.01); expect(d.action.plannedDuration).toBe(1); expect(d.action.executedDistance).toBe(0)
      expect(Math.hypot(d.action.direction.x, d.action.direction.y)).toBeCloseTo(1, 12)
      if (d.direction && !e.nullDirection) {
        const a = Math.atan2(d.direction.y, d.direction.x) - Math.atan2(e.gradient.y, e.gradient.x)
        const independent = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)))
        expect(Number.isFinite(d.angleError)).toBe(true)
        expect(Math.cos(d.angleError! * Math.PI / 180)).toBeCloseTo(Math.cos(independent), 12)
        expect(d.angleError! > 45).toBe(independent > Math.PI / 4)
      } else expect(d.angleError).toBeNull()
    }
  }
  expect(count).toBe(33600)
  for (const cell of r.summary.cells) {
    const ds = r.episodes.filter((e) => e.field === cell.field && e.nuisance === cell.nuisance).flatMap((e) => e.decisions.filter((d) => d.arm === cell.arm))
    expect(ds).toHaveLength(100); expect(cell.episodes).toBe(100)
    expect(cell.accepted).toBe(ds.filter((d) => d.direction).length)
    expect(cell.explore).toBe(ds.filter((d) => d.action.kind === 'explore').length)
    expect(cell.wrong).toBe(ds.filter((d) => d.angleError !== null && d.angleError > 45).length)
    expect(cell.recovered).toBe(ds.filter((d) => d.direction && d.stage === 'recent-pair').length)
  }
  for (const mode of ['raw', 'calibrated'] as const) {
    const failures = r.summary.cells.filter((c) => c.arm === `${mode}-recovery`).filter((c) => c.nullDirection ? c.accepted > 5 :
      (c.accepted > 0 && c.wrong / c.accepted > 0.05) || (['linear', 'off-peak', 'turning'].includes(c.field) && c.accepted < 50))
    expect(failures).toEqual(r.summary.recoveryFailures[mode])
    expect(mode === 'raw' ? r.summary.rawAdvances : r.summary.calibratedAdvances).toBe(failures.length === 0)
  }
})
