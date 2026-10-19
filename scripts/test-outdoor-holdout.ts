import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {DESIGN} from './lib/outdoor-detectability'
import {HOLDOUT, holdoutSpecs} from './lib/outdoor-holdout-design'
const rows = holdoutSpecs('campaign'), smoke = holdoutSpecs('smoke')
assert.equal(rows.length, 544)
assert.equal(rows.filter(s => s.resolution === 0).length, 512)
assert.equal(new Set(rows.map(s => JSON.stringify(s))).size, 544)
assert.equal(new Set(rows.map(s => s.world)).size, 128)
assert.deepEqual([...new Set(rows.filter(s => s.resolution > 0).map(s => s.world))], [1000, 1042, 1085, 1127])
for (let w = 1000; w <= 1127; w++) {
  const subset = rows.filter(s => s.world === w)
  assert.equal(subset.length, HOLDOUT.witnessWorlds.includes(w as 1000) ? 12 : 4)
  assert.equal(subset.filter(s => s.resolution === 0).length, 4)
}
assert.equal(smoke.length, 4)
assert.ok(smoke.every(s => s.world === 0 && s.resolution === 0))
assert.ok(rows.every(s => !DESIGN.pilotWorlds.includes(s.world as 0)))
assert.throws(() => holdoutSpecs('unknown' as 'smoke'))
const pilot = JSON.parse(readFileSync('research/results/outdoor_detectability_pilot_v2_2026-09-22/manifest.json', 'utf8'))
assert.deepEqual(DESIGN, pilot.design)
for (const row of [...pilot.sourceHashes, ...pilot.frozenStage2i.hashes])
  assert.equal(createHash('sha256').update(readFileSync(row.file)).digest('hex'), row.sha256, row.file)
assert.equal(HOLDOUT.primaryOutcomes, 512 * 4 * 6 * 3)
assert.deepEqual(HOLDOUT.bootstrap.intervalQuantiles, [0.0125, 0.9875])
console.log('PASS: exact 544-case design, 128 unused test worlds, 16 triplets, source/pilot preservation, 4-case compatibility smoke, reporting constants')
