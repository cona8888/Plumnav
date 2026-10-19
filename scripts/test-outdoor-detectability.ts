import assert from 'node:assert/strict'
import {HalfspaceTransport} from '../src/sim/halfspaceTransport'
import {DESIGN, firstAlarm, lawnmowerPlatform, normalNoise, pilotSpecs, ppmFactor,
  randomStream, sensorModels, sensorReadings, worldSettings} from './lib/outdoor-detectability'
let checks = 0
function test(name: string, fn: () => void) {fn(); checks++; console.log(`PASS ${name}`)}
test('SI methane conversion and invalid units', () => {
  assert.ok(Math.abs(ppmFactor(298.15, 101325) * 1e-6 - 1.525274544675014) < 1e-12)
  assert.throws(() => ppmFactor(0, 101325)); assert.throws(() => ppmFactor(298.15, NaN))
})
test('mass, reflecting ground, linearity and absent transport', () => {
  const base = {source: {x: 2, y: 3, z: 0.025}, wind: {x: 0.5, y: 0},
    diffusivity: 0.2, sigma: 0.25, rateKgPerSecond: 1e-5, panelSeconds: 0.25}
  const field = new HalfspaceTransport(base), p = {x: 6, y: 4, z: 0}
  assert.ok(Math.abs(field.integratedMassAt(10) - 1e-4) < 1e-16)
  assert.equal(field.evaluate(p, 10).gradient.z, 0)
  const double = new HalfspaceTransport({...base, rateKgPerSecond: 2e-5})
  assert.equal(double.evaluate(p, 10).concentration, 2 * field.evaluate(p, 10).concentration)
  assert.equal(new HalfspaceTransport({...base, rateKgPerSecond: 0}).evaluate(p, 10).concentration, 0)
})
test('route speed, SI extent, turns and no teleport', () => {
  const route = lawnmowerPlatform(1)
  assert.equal(route.routeLengthMetres, 990)
  assert.deepEqual(route.poseAt(0), {x: 5, y: 5, z: 0.05})
  assert.deepEqual(route.poseAt(91), {x: 95, y: 5, z: 0.05})
  assert.deepEqual(route.poseAt(93), {x: 95, y: 6, z: 0.05})
  assert.equal(route.distanceAt(93), 91)
  assert.deepEqual(route.poseAt(10000), {x: 5, y: 95, z: 0.05})
  for (let t = 0; t < 600; t += 0.25) {
    const a = route.poseAt(t), b = route.poseAt(t + 0.25)
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= 0.250000001)
  }
  assert.throws(() => lawnmowerPlatform(0)); assert.throws(() => route.poseAt(-1))
})
test('analytic first-order rise, recovery and transport delay', () => {
  const model = {...sensorModels()[0]!, delaySeconds: 0, noisePpm: 0, riseSeconds: 2, recoverySeconds: 4}
  const rise = sensorReadings(Array(16).fill(12), 0.25, model, [0, 0, 0, 0], 2)
  assert.ok(Math.abs(rise[3]! - (12 - 10 * Math.exp(-2))) < 1e-12)
  const fall = sensorReadings(Array(16).fill(2), 0.25, model, [0, 0, 0, 0], 12)
  assert.ok(Math.abs(fall[3]! - (2 + 10 * Math.exp(-1))) < 1e-12)
  const delayed = sensorReadings(Array(16).fill(12), 0.25, {...model, delaySeconds: 1}, [0, 0, 0, 0], 2)
  assert.equal(delayed[0], 2); assert.ok(Math.abs(delayed[3]! - rise[2]!) < 1e-12)
})
test('fixed physical output clock under refinement and persistent memory', () => {
  const model = sensorModels()[0]!, noise = [0.1, -0.3, 1, 0.2]
  const a = sensorReadings(Array(16).fill(4), 0.25, model, noise, 2)
  const b = sensorReadings(Array(32).fill(4), 0.125, model, noise, 2)
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]!) < 1e-12))
  const pulse = sensorReadings([...Array(8).fill(4), ...Array(8).fill(2)], 0.25, {...model, noisePpm: 0, delaySeconds: 0}, [0, 0, 0, 0], 2)
  assert.ok(pulse[3]! > 2)
})
test('saturation, negative clipping, invalid clocks and inputs', () => {
  const model = {...sensorModels()[0]!, delaySeconds: 0, saturationPpm: 3}
  assert.equal(sensorReadings([100, 100, 100, 100], 0.25, model, [0], 2)[0], 3)
  assert.equal(sensorReadings([2, 2, 2, 2], 0.25, model, [-1000], 2)[0], 0)
  assert.throws(() => sensorReadings([2], 0.3, model, [0], 2))
  assert.throws(() => sensorReadings([NaN, 2, 2, 2], 0.25, model, [0], 2))
  assert.throws(() => sensorReadings([2, 2, 2, 2], 0.25, model, [], 2))
})
test('alarm requires three strict consecutive readings and reports decision time', () => {
  const c = {referencePpm: 2, thresholdExcessPpm: 1, consecutiveSamples: 3}
  assert.equal(firstAlarm([3, 4, 4, 4], 1, c), 4)
  assert.equal(firstAlarm([4, 4, 2, 4, 4], 1, c), null)
  assert.throws(() => firstAlarm([NaN], 1, c))
})
test('deterministic paired worlds, distinct streams, reserved test split', () => {
  assert.deepEqual(normalNoise(0, 20), normalNoise(0, 20))
  assert.notDeepEqual(normalNoise(0, 20), normalNoise(1, 20))
  for (const id of [...DESIGN.pilotWorlds, 1000, 1127]) {
    const w = worldSettings(id)
    assert.ok(w.source.x >= 10 && w.source.x <= 90 && w.source.y >= 10 && w.source.y <= 90)
  }
  const a = randomStream(1), b = randomStream(1)
  for (let i = 0; i < 100; i++) assert.equal(a(), b())
  assert.ok(DESIGN.pilotWorlds.every(w => w < DESIGN.reservedTestWorldRange[0]))
})
test('prospective pilot counts and no hidden controller access', () => {
  const specs = pilotSpecs()
  assert.equal(specs.length, 24); assert.equal(specs.filter(s => s.resolution === 0).length, 16)
  assert.equal(sensorModels().length, 6)
  assert.equal(16 * DESIGN.ratesKgPerSecond.length * sensorModels().length * DESIGN.thresholdMultipliers.length, 1152)
  assert.equal(firstAlarm.length, 3)
  assert.ok(specs.every(s => DESIGN.pilotWorlds.includes(s.world as 0 | 1 | 2 | 3)))
})
console.log(JSON.stringify({passed: true, checks, stage2iModified: false}))
