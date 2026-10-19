import assert from 'node:assert/strict'
import {BUDGET, budgetSpecs, duration, budgetSensors, scoreBudgets, makeBudgetTrace} from './lib/outdoor-budget'
import {lawnmowerPlatform, normalNoise, sensorReadings} from './lib/outdoor-detectability'

assert.equal(duration(.5), 2016); assert.equal(duration(1), 1026)
for (const speed of [.5, 1]) {
  const p = lawnmowerPlatform(speed), t = duration(speed)
  assert.deepEqual(p.poseAt(t), {x: 5, y: 95, z: .05}); assert.equal(p.distanceAt(t), 990)
  assert.equal(p.distanceAt(600), speed === .5 ? 295 : 580)
  assert.equal(p.distanceAt(t-1), 990-speed)
  assert.equal(p.distanceAt(90/speed+1), 90)
}
assert.throws(() => duration(2)); assert.throws(() => makeBudgetTrace({world: 2000, wind: .5, speed: 1, resolution: 0}))
const specs = budgetSpecs()
assert.equal(specs.length, 24); assert.equal(specs.filter(s => s.resolution === 0).length, 16)
assert.equal(new Set(specs.map(s => JSON.stringify(s))).size, 24)
assert.ok(specs.filter(s => s.resolution > 0).every(s => s.world === 200))
const allWorlds = [0,1,2,3,...Array.from({length:128},(_,i)=>1000+i),...BUDGET.pilotWorlds,...Array.from({length:128},(_,i)=>2000+i)]
const seeds = allWorlds.flatMap(w => [927001+17*w, 1927001+17*w])
assert.equal(new Set(seeds).size, seeds.length)
for (const world of BUDGET.pilotWorlds)
  assert.deepEqual(normalNoise(world, 2016).slice(0, 600), normalNoise(world, 600))
for (const s of budgetSensors()) {
  const input = Array.from({length: 2016*4}, (_, i) => 2 + (i > 2380 && i < 2440 ? 5 : 0))
  const noise = normalNoise(200, 2016), full = sensorReadings(input, .25, s, noise, 2)
  assert.deepEqual(full.slice(0,600), sensorReadings(input.slice(0,2400), .25, s, noise.slice(0,600), 2))
  assert.notEqual(full[600], sensorReadings(input.slice(2400), .25, s, noise.slice(600), 2)[0])
  const step = sensorReadings(Array(40).fill(4), .25, s, Array(10).fill(0), 2)
  assert.equal(step[0], 2)
  for (let i=1;i<10;i++) assert.ok(Math.abs(step[i]!-(4-2*Math.exp(-i/s.riseSeconds)))<1e-13)
}
let readings = Array(1026).fill(2); readings.fill(4, 600, 603)
assert.deepEqual(scoreBudgets(readings,1026,1).map(x=>x.alarmSeconds), [null,603])
readings.fill(4, 597, 600)
assert.deepEqual(scoreBudgets(readings,1026,1).map(x=>x.alarmSeconds), [600,600])
assert.deepEqual(scoreBudgets(Array(1026).fill(3),1026,1).map(x=>x.alarmSeconds), [null,null])
assert.throws(()=>scoreBudgets([2],1026,1))
console.log('PASS: endpoint/turn geometry; exact prefix clocks; persistent sensor memory; analytic delay/response; strict paired budget scoring; 24-case inventory; reserved-world guard; disjoint outdoor seed sets.')
