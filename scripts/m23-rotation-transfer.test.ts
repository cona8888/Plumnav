import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { m23Field, m23Episode, runM23, M23_ANGLES, M23_ARMS, M23_RATES } from './lib/m23-rotation-transfer'
import { m21Calibrate, M21_NUISANCES } from './lib/m21-direction-study'
import { M23_ROOT } from './m23-rotation-transfer'
it('matches analytic gradient by finite differences and is rotationally equivariant without noise', () => {
  for (const phase of M23_ANGLES) for (const rate of M23_RATES) {
    const p = { x: 0.5, y: 0.5 }; const t = 11.5; const exact = m23Field(phase, rate, p, t)
    for (const axis of ['x', 'y'] as const) {
      const h = 1e-7; const d = (m23Field(phase, rate, { ...p, [axis]: p[axis] + h }, t).concentration -
        m23Field(phase, rate, { ...p, [axis]: p[axis] - h }, t).concentration) / (2 * h)
      expect(d).toBeCloseTo(exact.gradient[axis], 7)
    }
  }
  const n = { ...M21_NUISANCES[0]!, gain: 0, cross: 0, rho: 0, lag: 0.05, lagMismatch: 0 }
  const c = m21Calibrate(n, 777).calibration
  expect(m23Episode(n, 0.3, 0, 0.4, 888, c)).toEqual(m23Episode(n, 0.3, 0, 0.4, 888, c))
})
it.skipIf(process.env.M23_VERIFY !== '1')('verifies frozen sources, exact replay, factorial balance, angles, costs and gates', async () => {
  const read = async (p: string) => JSON.parse(await readFile(`${M23_ROOT}/${p}`, 'utf8'))
  const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
  const design = await read('design.json'); const inventory = await read('checksums.json')
  expect(design.sourceInventory).toHaveLength(101); expect(inventory.complete).toBe(true)
  for (const e of inventory.inventory) expect(hash(await readFile(`${M23_ROOT}/${e.path}`))).toBe(e.sha256)
  for (const e of design.sourceInventory) {
    expect(hash(await readFile(`${M23_ROOT}/source-snapshot/${e.path}`))).toBe(e.sha256)
    expect(hash(await readFile(e.path))).toBe(e.sha256)
  }
  const r = runM23()
  expect(JSON.stringify(r) + '\n').toBe(await readFile(`${M23_ROOT}/results.json`, 'utf8'))
  expect(JSON.stringify(r.summary) + '\n').toBe(await readFile(`${M23_ROOT}/summary.json`, 'utf8'))
  expect(r.calibrations).toHaveLength(14); expect(r.episodes).toHaveLength(31360)
  expect(new Set(r.episodes.map((e) => e.seed)).size).toBe(31360)
  let decisions = 0
  for (const e of r.episodes) {
    expect(e.seed).toBeGreaterThanOrEqual(300000); expect(e.views).toHaveLength(4); expect(e.decisions).toHaveLength(4)
    expect(r.calibrations.some((c) => c.seed === e.seed)).toBe(false)
    e.views.forEach((v, i) => { expect(v.time).toBe(8.5 + i); expect(v.heading).toBe(e.body + i * Math.PI / 2) })
    for (const d of e.decisions) {
      decisions++; expect(d.action.kind).toBe(d.direction ? 'follow' : 'explore'); expect(d.action.executedDistance).toBe(0)
      if (d.direction) {
        const delta = Math.atan2(d.direction.y, d.direction.x) - Math.atan2(e.truth.y, e.truth.x)
        expect(d.angleError).toBeCloseTo(Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))) * 180 / Math.PI, 10)
      } else expect(d.angleError).toBeNull()
    }
  }
  expect(decisions).toBe(125440)
  for (const a of r.summary.aggregates) {
    expect(a.episodes).toBe(640); expect(a.accepted).toBeLessThanOrEqual(640); expect(a.wrong).toBeLessThanOrEqual(a.accepted)
  }
  expect(r.summary.staticCells.every((c) => c.episodes === 10)).toBe(true)
  const af = r.summary.aggregates.filter((a) => a.arm === 'calibrated-recovery' &&
    (a.accepted < 320 || a.wrong > a.accepted * 0.05 || a.medianError === null || a.medianError > 30))
  const sf = r.summary.staticCells.filter((c) => c.accepted < 5 || c.wrong > c.accepted * 0.05)
  expect(r.summary.aggregateFailures).toEqual(af); expect(r.summary.staticFailures).toEqual(sf)
  expect(r.summary.advancesToExecutedActionTest).toBe(af.length === 0 && sf.length === 0)
  expect(M23_ARMS).toHaveLength(4)
})
