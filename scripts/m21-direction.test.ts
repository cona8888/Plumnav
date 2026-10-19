import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { directionDecision, fitDirectionCalibration } from './lib/m21-direction'
import { m21Field, m21Calibrate, m21Episode, M21_NUISANCES, runM21 } from './lib/m21-direction-study'
import { M21_ROOT } from './m21-direction-study'
const identity = { slopes: [1, 1, 1, 1], offsets: [0, 0, 0, 0], rawVariance: 0.00001, correctedVariance: 0.00001 }
it('recovers two-level affine calibration and world direction under body rotation', () => {
  const gains = [1.2, 0.8, 1.1, 0.9]; const offsets = [0.01, 0.02, -0.01, 0.03]
  const ref = (level: number) => Array.from({ length: 4 }, () => gains.map((g, i) => g * level + offsets[i]!))
  const c = fitDirectionCalibration(ref(0.25), ref(0.75))
  c.slopes.forEach((v, i) => expect(v).toBeCloseTo(gains[i]!, 12))
  c.offsets.forEach((v, i) => expect(v).toBeCloseTo(offsets[i]!, 12))
  const views = [0, 1, 2, 3].map((k) => { const heading = k * Math.PI / 2; const x = 0.1 * Math.cos(heading); const y = -0.1 * Math.sin(heading)
    return { heading, values: [0.5 + x, 0.5 - y, 0.5 - x, 0.5 + y].map((v, i) => v * gains[i]! + offsets[i]!) } })
  const d = directionDecision(views, c, 'rotation-consistent')
  expect(d.direction?.x).toBeCloseTo(1, 12); expect(d.direction?.y).toBeCloseTo(0, 12)
  expect(directionDecision(views.slice(1), c, 'raw').direction).toBeNull()
})
it('abstains on clipping, flat signal, bad calibration and inconsistent rotations', () => {
  const views = [0, 0, 0, Math.PI].map((heading) => ({ heading, values: [0.6, 0.5, 0.4, 0.5] }))
  expect(directionDecision(views, identity, 'calibrated').direction).not.toBeNull()
  expect(directionDecision(views, identity, 'rotation-consistent').reason).toBe('inconsistent-rotation')
  expect(directionDecision(views.map((v) => ({ ...v, values: [0.5, 0.5, 0.5, 0.5] })), identity, 'raw').direction).toBeNull()
  expect(directionDecision(views, { ...identity, slopes: [NaN, 1, 1, 1] }, 'raw').direction).toBeNull()
  expect(directionDecision(views.map((v) => ({ ...v, values: [1.5, 0.5, 0.5, 0.5] })), identity, 'raw').direction).toBeNull()
})
it('verifies analytic field gradients by finite differences and deterministic forward replay', () => {
  for (const field of ['flat', 'linear', 'weak', 'peak', 'off-peak', 'pulsing', 'turning', 'low-signal'] as const) {
    const p = { x: 0.5, y: 0.5 }; const exact = m21Field(field, p, 11.5)
    for (const axis of ['x', 'y'] as const) {
      const derivative = (m21Field(field, { ...p, [axis]: p[axis] + 1e-6 }, 11.5).concentration -
        m21Field(field, { ...p, [axis]: p[axis] - 1e-6 }, 11.5).concentration) / 2e-6
      expect(derivative).toBeCloseTo(exact.gradient[axis], 7)
    }
  }
  const n = M21_NUISANCES[0]!; const c = m21Calibrate(n, 999).calibration
  expect(m21Episode(n, 'linear', 1234, c)).toEqual(m21Episode(n, 'linear', 1234, c))
})
it.skipIf(process.env.M21_VERIFY !== '1')('verifies source hashes, replays all episodes, and independently checks counts and advancement gates', async () => {
  const read = async (p: string) => JSON.parse(await readFile(`${M21_ROOT}/${p}`, 'utf8'))
  const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
  const design = await read('design.json'); const checksums = await read('checksums.json')
  expect(checksums.complete).toBe(true); expect(design.sourceInventory).toHaveLength(91)
  for (const e of checksums.inventory) expect(hash(await readFile(`${M21_ROOT}/${e.path}`))).toBe(e.sha256)
  for (const e of design.sourceInventory) {
    expect(hash(await readFile(`${M21_ROOT}/source-snapshot/${e.path}`))).toBe(e.sha256)
    expect(hash(await readFile(e.path))).toBe(e.sha256)
  }
  const result = runM21(); expect(result).toEqual(await read('results.json')); expect(result.summary).toEqual(await read('summary.json'))
  expect(result.calibrations).toHaveLength(35); expect(result.episodes).toHaveLength(5600)
  expect(new Set(result.episodes.map((e) => e.seed)).size).toBe(5600)
  expect(result.episodes.every((e) => e.views.length === 4 && e.decisions.length === 3)).toBe(true)
  for (const c of result.summary.cells) {
    expect(c.episodes).toBe(100); expect(Object.values(c.reasons).reduce((s, n) => s + n, 0)).toBe(100)
    expect(c.wrong).toBeLessThanOrEqual(c.accepted)
  }
  const candidate = result.summary.cells.filter((c) => c.rule === 'rotation-consistent')
  const passes = candidate.every((c) => c.nullDirection ? c.accepted <= 5 :
    (c.accepted === 0 || c.wrong <= 0.05 * c.accepted) && (!['linear', 'off-peak'].includes(c.field) || c.accepted >= 50))
  expect(result.summary.advancesToFurtherComponentTest).toBe(passes)
})
