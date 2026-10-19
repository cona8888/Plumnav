import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { executeM26Action, m26Maps, runM26 } from './lib/m26-action-horizon'
import { M26_ROOT } from './m26-action-horizon'

it('selects genuine obstacle-adjacent starts and executes clearance-safe actions', () => {
  const maps = m26Maps(); expect(maps).toHaveLength(4)
  expect(maps.filter((m) => m.complexity > 0).every((m) => m.localAvoidanceChallenge)).toBe(true)
  for (const map of maps) for (const direction of [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: -1 }]) {
    const r = executeM26Action(map, direction); expect(r.blockedEndpoint).toBe(false); expect(r.distance).toBeGreaterThan(0)
    expect(r.path.every((p) => !map.environment.isBlocked(p))).toBe(true)
  }
})

it.skipIf(process.env.M26_VERIFY !== '1')('verifies frozen sources, exact fresh replay, counts and gates', async () => {
  const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex'), read = async (p: string) => JSON.parse(await readFile(`${M26_ROOT}/${p}`, 'utf8'))
  const design = await read('design.json'), checks = await read('checksums.json')
  expect(checks.complete).toBe(true)
  for (const e of checks.inventory) expect(hash(await readFile(`${M26_ROOT}/${e.path}`))).toBe(e.sha256)
  for (const e of design.sourceInventory) { expect(hash(await readFile(`${M26_ROOT}/source-snapshot/${e.path}`))).toBe(e.sha256); expect(hash(await readFile(e.path))).toBe(e.sha256) }
  const result = runM26(); expect(JSON.stringify(result) + '\n').toBe(await readFile(`${M26_ROOT}/results.json`, 'utf8'))
  expect(result.episodes).toBe(49280); expect(result.actions).toBe(591360); expect(result.aggregates).toHaveLength(924)
  expect(result.mapManifest.filter((m) => m.complexity > 0).every((m) => m.localAvoidanceChallenge)).toBe(true)
  for (const c of result.aggregates) { expect(c.actions).toBe(640); expect(c.follows + c.explores).toBe(640); expect(c.blockedEndpoints).toBe(0) }
  const f = result.failures
  expect(result.advancesToReacquisitionTest).toBe(!f.safety.length && !f.distance.length && !f.gainCells.length && !f.slowFollow.length && f.overallGain >= 0.95 && f.challengeFraction >= 0.01)
})
