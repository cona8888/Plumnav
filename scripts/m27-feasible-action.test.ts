import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { executeM27Action, runM27 } from './lib/m27-feasible-action'
import { m26Maps } from './lib/m26-action-horizon'
import { M27_ROOT } from './m27-feasible-action'
it('projects actions onto clearance-safe locally feasible motion', () => {
  for (const map of m26Maps()) for (const d of [{ x: 1, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 1 }]) {
    const r = executeM27Action(map, d); expect(r.blockedEndpoint).toBe(false); expect(r.distance).toBeGreaterThan(0); expect(r.path.every((p) => !map.environment.isBlocked(p))).toBe(true)
  }
})
it.skipIf(process.env.M27_VERIFY !== '1')('verifies frozen evidence, exact replay and gates', async () => {
  const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex'), read = async (p: string) => JSON.parse(await readFile(`${M27_ROOT}/${p}`, 'utf8'))
  const design = await read('design.json'), checks = await read('checksums.json'); expect(checks.complete).toBe(true)
  for (const e of checks.inventory) expect(hash(await readFile(`${M27_ROOT}/${e.path}`))).toBe(e.sha256)
  for (const e of design.sourceInventory) { expect(hash(await readFile(`${M27_ROOT}/source-snapshot/${e.path}`))).toBe(e.sha256); expect(hash(await readFile(e.path))).toBe(e.sha256) }
  const result = runM27(); expect(JSON.stringify(result) + '\n').toBe(await readFile(`${M27_ROOT}/results.json`, 'utf8')); expect(result.episodes).toBe(49280); expect(result.actions).toBe(394240); expect(result.aggregates).toHaveLength(616)
  const f = result.failures; expect(result.advancesToReacquisitionTest).toBe(!f.safety.length && !f.distance.length && !f.gainCells.length && !f.slowFollow.length && f.overallGain >= 0.95)
})
