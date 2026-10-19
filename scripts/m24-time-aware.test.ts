import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { timeAwareDecision, m24Angle, m24Episode, runM24, M24_DYNAMICS } from './lib/m24-time-aware'
import { m21Calibrate, M21_NUISANCES } from './lib/m21-direction-study'
import { M24_ROOT } from './m24-time-aware'
const c = { slopes: [1, 1, 1, 1], offsets: [0, 0, 0, 0], rawVariance: 1e-5, correctedVariance: 1e-5 }
it('forecasts a causal constant angular trend and enforces bandwidth/history gates', () => {
  const make = (time: number, angle: number) => ({ time, heading: 0, values: [0.5 + 0.1 * Math.cos(angle), 0.5 - 0.1 * Math.sin(angle), 0.5 - 0.1 * Math.cos(angle), 0.5 + 0.1 * Math.sin(angle)] })
  const views = [8.5, 9.5, 10.5, 11.5].map((t) => make(t, 0.4 * (t - 0.25)))
  const d = timeAwareDecision(views, c, 11.5, 0.5)
  expect(d.reason).toBe('time-aware-direction'); expect(Math.atan2(d.direction!.y, d.direction!.x)).toBeCloseTo(Math.atan2(Math.sin(0.4 * 11.5), Math.cos(0.4 * 11.5)), 10)
  expect(timeAwareDecision(views, c, 11.5, 2).reason).toBe('sensor-bandwidth')
  expect(timeAwareDecision(views, c, 10, 0.5).reason).toBe('invalid-or-stale-history')
})
it('defines continuous dynamics and deterministic production-sensor replay', () => {
  for (const d of M24_DYNAMICS) for (const phase of [0, 1]) {
    expect(Number.isFinite(m24Angle(d, phase, 8))).toBe(true); expect(Number.isFinite(m24Angle(d, phase, 11.5))).toBe(true)
  }
  const n = M21_NUISANCES[0]!, cal = m21Calibrate(n, 919).calibration
  expect(m24Episode(n, M24_DYNAMICS[1]!, 0.3, 0.7, 929, cal)).toEqual(m24Episode(n, M24_DYNAMICS[1]!, 0.3, 0.7, 929, cal))
})
it.skipIf(process.env.M24_VERIFY !== '1')('verifies source hashes, exact replay, balance, angles, actions and gates', async () => {
  const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
  const read = async (p: string) => JSON.parse(await readFile(`${M24_ROOT}/${p}`, 'utf8'))
  const design = await read('design.json'), inventory = await read('checksums.json')
  expect(design.sourceInventory).toHaveLength(105); expect(inventory.complete).toBe(true)
  for (const e of inventory.inventory) expect(hash(await readFile(`${M24_ROOT}/${e.path}`))).toBe(e.sha256)
  for (const e of design.sourceInventory) { expect(hash(await readFile(`${M24_ROOT}/source-snapshot/${e.path}`))).toBe(e.sha256); expect(hash(await readFile(e.path))).toBe(e.sha256) }
  const r = runM24(); expect(JSON.stringify(r) + '\n').toBe(await readFile(`${M24_ROOT}/results.json`, 'utf8')); expect(JSON.stringify(r.summary) + '\n').toBe(await readFile(`${M24_ROOT}/summary.json`, 'utf8'))
  expect(r.calibrations).toHaveLength(14); expect(r.episodes).toHaveLength(49280); expect(new Set(r.episodes.map((e) => e.seed)).size).toBe(49280)
  let count = 0
  for (const e of r.episodes) for (const d of e.decisions) { count++; expect(d.action.kind).toBe(d.direction ? 'follow' : 'explore'); expect(d.action.executedDistance).toBe(0)
    if (d.direction) { const a = Math.atan2(d.direction.y, d.direction.x) - Math.atan2(e.truth.y, e.truth.x); expect(d.angleError).toBeCloseTo(Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) * 180 / Math.PI, 9) } else expect(d.angleError).toBeNull() }
  expect(count).toBe(147840); expect(r.summary.aggregates.every((a) => a.episodes === 640)).toBe(true); expect(r.summary.staticCells.every((c) => c.episodes === 10)).toBe(true)
  const supported = r.summary.aggregates.filter((a) => a.arm === 'time-aware' && a.responseSeconds <= 0.75 && (a.accepted < 320 || a.wrong > .05 * a.accepted || a.medianError === null || a.medianError > 30))
  const unsupported = r.summary.aggregates.filter((a) => a.arm === 'time-aware' && a.responseSeconds > .75 && (a.accepted > 32 || a.bandwidthAbstentions !== 640))
  expect(r.summary.supportedFailures).toEqual(supported); expect(r.summary.unsupportedFailures).toEqual(unsupported)
  expect(r.summary.advancesToExecutedActionTest).toBe(!supported.length && !unsupported.length && !r.summary.staticFailures.length)
})
