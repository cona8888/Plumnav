import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { runM21 } from './lib/m21-direction-study'
import { M21_ROOT } from './m21-direction-study'

// Separate correction to the original frozen opt-in verifier, which compared
// in-memory -0 with JSON's 0. Preserve that source/evidence unchanged. Compare
// exact serialized bytes, then independently inspect all scientific outcomes.
it('replays exact M21 archive bytes and independently validates all directional decisions', async () => {
  const read = async (p: string) => JSON.parse(await readFile(`${M21_ROOT}/${p}`, 'utf8'))
  const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
  const design = await read('design.json'); const inventory = await read('checksums.json')
  expect(inventory.complete).toBe(true); expect(inventory.inventory).toHaveLength(4)
  expect(design.sourceInventory).toHaveLength(91)
  for (const e of inventory.inventory) {
    const b = await readFile(`${M21_ROOT}/${e.path}`); expect(hash(b)).toBe(e.sha256); expect(b.length).toBe(e.bytes)
  }
  for (const e of design.sourceInventory) {
    expect(hash(await readFile(`${M21_ROOT}/source-snapshot/${e.path}`))).toBe(e.sha256)
    expect(hash(await readFile(e.path))).toBe(e.sha256)
  }
  const result = runM21()
  expect(JSON.stringify(result) + '\n').toBe(await readFile(`${M21_ROOT}/results.json`, 'utf8'))
  expect(JSON.stringify(result.summary) + '\n').toBe(await readFile(`${M21_ROOT}/summary.json`, 'utf8'))
  expect(result.calibrations).toHaveLength(35); expect(result.episodes).toHaveLength(5600)
  expect(new Set(result.episodes.map((e) => e.seed)).size).toBe(5600)
  let decisions = 0
  for (const e of result.episodes) {
    expect(result.calibrations.some((c) => c.seed === e.seed)).toBe(false)
    expect(e.views).toHaveLength(4); expect(e.decisions).toHaveLength(3)
    e.views.forEach((v, i) => { expect(v.heading).toBe(i * Math.PI / 2); expect(v.values.every(Number.isFinite)).toBe(true) })
    for (const d of e.decisions) {
      decisions++
      if (d.direction) {
        expect(Math.hypot(d.direction.x, d.direction.y)).toBeCloseTo(1, 12)
        if (!e.nullDirection) {
          const angle = Math.atan2(d.direction.y, d.direction.x) - Math.atan2(e.gradient.y, e.gradient.x)
          expect(d.angleError).toBeCloseTo(Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle))) * 180 / Math.PI, 8)
        } else expect(d.angleError).toBeNull()
      } else expect(d.angleError).toBeNull()
    }
  }
  expect(decisions).toBe(16800)
  for (const c of result.summary.cells) {
    const ds = result.episodes.filter((e) => e.field === c.field && e.nuisance === c.nuisance).flatMap((e) => e.decisions.filter((d) => d.rule === c.rule))
    expect(ds).toHaveLength(100); expect(c.episodes).toBe(100)
    expect(c.accepted).toBe(ds.filter((d) => d.direction).length)
    expect(c.wrong).toBe(ds.filter((d) => d.direction && d.angleError !== null && d.angleError > 45).length)
    expect(Object.values(c.reasons).reduce((s, n) => s + n, 0)).toBe(100)
  }
  const passes = result.summary.cells.filter((c) => c.rule === 'rotation-consistent').every((c) => c.nullDirection ? c.accepted <= 5 :
    (c.accepted === 0 || c.wrong <= 0.05 * c.accepted) && (!['linear', 'off-peak'].includes(c.field) || c.accepted >= 50))
  expect(result.summary.advancesToFurtherComponentTest).toBe(passes)
})
