import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { executeM25Action, m25Maps, runM25 } from './lib/m25-executed-action'
import { M25_ROOT } from './m25-executed-action'
it('executes finite normalized motion through existing safe-direction geometry', () => {
  for (const map of m25Maps()) for (const direction of [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: -1 }]) {
    const r = executeM25Action(map, direction)
    expect(r.blockedEndpoint).toBe(false); expect(r.distance).toBeGreaterThan(0); expect(r.distance).toBeLessThanOrEqual(0.0100000001)
    expect(r.path.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && !map.environment.isBlocked(p))).toBe(true)
  }
})
it.skipIf(process.env.M25_VERIFY !== '1')('verifies sources, M24 dependency, exact replay, all actions, costs and gates', async () => {
  const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex'), read = async (p: string) => JSON.parse(await readFile(`${M25_ROOT}/${p}`, 'utf8'))
  const design = await read('design.json'), inventory = await read('checksums.json')
  expect(design.sourceInventory).toHaveLength(109); expect(inventory.complete).toBe(true)
  for (const e of inventory.inventory) expect(hash(await readFile(`${M25_ROOT}/${e.path}`))).toBe(e.sha256)
  for (const e of design.sourceInventory) { expect(hash(await readFile(`${M25_ROOT}/source-snapshot/${e.path}`))).toBe(e.sha256); expect(hash(await readFile(e.path))).toBe(e.sha256) }
  for (const e of design.m24Evidence) expect(hash(await readFile(`research/evidence/m24_time_aware_2026-09-09/${e.path}`))).toBe(e.sha256)
  const archive = JSON.parse(await readFile('research/evidence/m24_time_aware_2026-09-09/results.json', 'utf8')), result = runM25(archive)
  expect(JSON.stringify(result) + '\n').toBe(await readFile(`${M25_ROOT}/results.json`, 'utf8')); expect(result.actions).toBe(591360); expect(result.aggregates).toHaveLength(924)
  expect(result.mapManifest).toHaveLength(4); expect(result.mapManifest.map((m) => m.id)).toEqual(['open', 'complexity-2', 'complexity-4', 'complexity-6'])
  for (const c of result.aggregates) { expect(c.actions).toBe(640); expect(c.follows + c.explores).toBe(640); expect(c.fullDistance).toBeLessThanOrEqual(640); expect(c.positiveFollowGain).toBeLessThanOrEqual(c.follows); expect(c.blockedEndpoints).toBe(0) }
  const f = result.failures
  expect(result.advancesToReacquisitionTest).toBe(!f.safety.length && !f.distance.length && !f.gainCells.length && !f.slowFollow.length && f.overallGain >= 0.95)
})
