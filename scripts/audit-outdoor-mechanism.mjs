#!/usr/bin/env node
// Independent saved-history reconstruction; no simulator/Python imports.
import assert from 'node:assert/strict'
import {readFileSync, writeFileSync, existsSync} from 'node:fs'
import {resolve, join} from 'node:path'
import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {performance} from 'node:perf_hooks'

const stages = ['midpointOpportunity', 'instantOne', 'instantThree', 'delayThree',
  'responseFixed', 'responseBackground', 'observed', 'blankObserved']
const alarmStages = stages.slice(1)
const edges = stages.slice(0, 6).map((s, i) => [s, stages[i + 1]]).concat([['blankObserved', 'observed']])
const categories = ['both', 'leftOnly', 'rightOnly', 'neither']
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'})
const near = (a, b, atol = 1e-9) => assert.ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= atol + 1e-12 * Math.abs(b), `${a} != ${b}`)
const settings = row => [row.wind, row.speed, row.sensor, row.rateKgPerSecond, row.k]
const key = row => JSON.stringify(settings(row))
const restrict = x => x === null ? 600 : x
const classify = (a, b) => a && b ? 'both' : a ? 'leftOnly' : b ? 'rightOnly' : 'neither'

function first(values, threshold, count = 3) {
  let consecutive = 0
  for (let i = 0; i < values.length; i++) {
    assert.ok(Number.isFinite(values[i]))
    consecutive = values[i] > threshold ? consecutive + 1 : 0
    if (consecutive === count) return i + 1
  }
  return null
}

function instrument(inlet, dt, s, noise) {
  const stride = s.sampleSeconds / dt, lag = s.delaySeconds / dt
  assert.equal(s.sampleSeconds, 1)
  assert.ok(Number.isInteger(stride) && stride >= 1 && Number.isInteger(lag) && lag >= 0)
  assert.equal(inlet.length % stride, 0)
  assert.equal(noise.length, inlet.length / stride)
  let state = 2
  const quiet = [], noisy = []
  for (let i = 0; i < inlet.length; i++) {
    const x = i < lag ? 2 : inlet[i - lag]
    const tau = x >= state ? s.riseSeconds : s.recoverySeconds
    state += (x - state) * -Math.expm1(-dt / tau)
    if ((i + 1) % stride === 0) {
      const j = quiet.length
      quiet.push(Math.min(s.saturationPpm, Math.max(0, state)))
      noisy.push(Math.min(s.saturationPpm, Math.max(0, state + s.noisePpm * noise[j])))
    }
  }
  return {quiet, noisy}
}

function sampled(inlet, dt, s, delayed) {
  const stride = s.sampleSeconds / dt, shift = delayed ? s.delaySeconds / dt : 0
  const output = []
  for (let endpoint = stride; endpoint <= inlet.length; endpoint += stride) {
    const index = endpoint - 1 - shift
    output.push(Math.max(0, Math.min(s.saturationPpm, index < 0 ? 2 : inlet[index])))
  }
  return output
}

function checkRecord(row, expected) {
  for (const field of ['traceIndex', 'world', 'wind', 'speed', 'resolution', 'sensor', 'rateKgPerSecond', 'k'])
    assert.equal(row[field], expected[field], field)
  near(row.maxExcessPpm, expected.maxExcessPpm)
  near(row.exposureSeconds, expected.exposureSeconds, 1e-12)
  near(row.thresholdExcessPpm, expected.thresholdExcessPpm, 1e-12)
  assert.deepEqual(row.decisions, expected.decisions)
  assert.deepEqual(row.alarmSeconds, expected.alarmSeconds)
}

function reconstruct(trace, index, saved) {
  const dt = trace.resolution.dt, noise = trace.noise
  const blanks = new Map(trace.measurements.filter(m => m.rateKgPerSecond === 0).map(m => [m.sensor.id, m]))
  let position = 0, maxError = 0
  for (const m of trace.measurements) {
    const s = m.sensor, scale = m.rateKgPerSecond / 1e-5
    const excess = trace.inlet.map(r => r.referenceExcessPpm * scale)
    const fixed = excess.map(x => 2 + x)
    const actual = excess.map((x, i) => x + trace.inlet[i].backgroundPpm)
    const direct = sampled(fixed, dt, s, false), delayed = sampled(fixed, dt, s, true)
    const fixedResponse = instrument(fixed, dt, s, noise).quiet
    const bg = instrument(actual, dt, s, noise)
    assert.equal(bg.noisy.length, m.readings.length)
    for (let j = 0; j < m.readings.length; j++) {
      near(bg.noisy[j], m.readings[j]); maxError = Math.max(maxError, Math.abs(bg.noisy[j] - m.readings[j]))
    }
    for (const outcome of m.outcomes) {
      const h = outcome.k * s.noisePpm, threshold = 2 + h
      const times = {instantOne: first(direct, threshold, 1), instantThree: first(direct, threshold),
        delayThree: first(delayed, threshold), responseFixed: first(fixedResponse, threshold),
        responseBackground: first(bg.quiet, threshold), observed: first(bg.noisy, threshold),
        blankObserved: first(blanks.get(s.id).readings, threshold)}
      assert.equal(times.observed, outcome.alarmSeconds)
      const above = excess.filter(x => x > h).length
      const expected = {traceIndex: index, ...trace.spec, sensor: s.id, rateKgPerSecond: m.rateKgPerSecond,
        k: outcome.k, thresholdExcessPpm: h, maxExcessPpm: Math.max(...excess), exposureSeconds: above * dt,
        decisions: {midpointOpportunity: above > 0, ...Object.fromEntries(alarmStages.map(s => [s, times[s] !== null]))},
        alarmSeconds: times}
      checkRecord(saved[position++], expected)
    }
  }
  assert.equal(position, 72)
  assert.equal(saved.length, position)
  return maxError
}

function checkSummaries(records, summaries) {
  const grouped = new Map()
  for (const row of records.filter(r => r.resolution === 0)) {
    const id = key(row)
    if (!grouped.has(id)) grouped.set(id, [])
    grouped.get(id).push(row)
  }
  assert.equal(grouped.size, 288); assert.equal(summaries.length, 288)
  const seen = new Set()
  for (const group of summaries) {
    const id = key(group); assert.ok(!seen.has(id)); seen.add(id)
    const rows = grouped.get(id).sort((a, b) => a.world - b.world)
    assert.equal(rows.length, 128); assert.equal(group.n, 128)
    assert.deepEqual(rows.map(r => r.world), Array.from({length: 128}, (_, i) => i + 1000))
    for (const s of stages) {
      const ids = rows.filter(r => r.decisions[s]).map(r => r.world)
      assert.deepEqual(group.stages[s].worlds, ids); assert.equal(group.stages[s].positive, ids.length)
      if (s !== 'midpointOpportunity') near(group.stages[s].restrictedMeanSeconds,
        rows.reduce((n, r) => n + restrict(r.alarmSeconds[s]), 0) / 128, 1e-12)
    }
    assert.equal(group.transitions.length, edges.length)
    for (let i = 0; i < edges.length; i++) {
      const [a, b] = edges[i], t = group.transitions[i]
      assert.equal(t.left, a); assert.equal(t.right, b)
      for (const c of categories) {
        const ids = rows.filter(r => classify(r.decisions[a], r.decisions[b]) === c).map(r => r.world)
        assert.deepEqual(t[c].worlds, ids); assert.equal(t[c].count, ids.length)
      }
    }
    const misses = rows.filter(r => !r.decisions.observed)
    assert.equal(group.observedMisses, misses.length)
    assert.equal(group.missesWithoutMidpointOpportunity, misses.filter(r => !r.decisions.midpointOpportunity).length)
    assert.equal(group.missesWithMidpointOpportunity, misses.filter(r => r.decisions.midpointOpportunity).length)
    assert.equal(group.observedWithoutMidpointOpportunity,
      rows.filter(r => r.decisions.observed && !r.decisions.midpointOpportunity).length)
  }
}

function canonical(object) {
  if (Array.isArray(object)) return '[' + object.map(canonical).join(',') + ']'
  if (object && typeof object === 'object') return '{' + Object.keys(object).sort().map(k => JSON.stringify(k) + ':' + canonical(object[k])).join(',') + '}'
  return JSON.stringify(object)
}

function checkRefinement(records, reports) {
  const triples = new Map()
  for (const r of records.filter(r => [1000, 1042, 1085, 1127].includes(r.world))) {
    const id = JSON.stringify([r.world, ...settings(r)])
    if (!triples.has(id)) triples.set(id, new Map())
    assert.ok(!triples.get(id).has(r.resolution)); triples.get(id).set(r.resolution, r)
  }
  assert.equal(triples.size, 1152); assert.equal(reports.length, 2)
  for (let low = 0; low < 2; low++) {
    const changes = [], times = []; let maximum = 0
    for (const triple of triples.values()) {
      assert.equal(triple.size, 3)
      const a = triple.get(low), b = triple.get(low + 1)
      const identity = {world: a.world, wind: a.wind, speed: a.speed, sensor: a.sensor, rateKgPerSecond: a.rateKgPerSecond, k: a.k}
      for (const s of stages) if (a.decisions[s] !== b.decisions[s]) changes.push({...identity, stage: s, low: a.decisions[s], high: b.decisions[s]})
      for (const s of alarmStages) {
        const t0 = restrict(a.alarmSeconds[s]), t1 = restrict(b.alarmSeconds[s])
        maximum = Math.max(maximum, Math.abs(t0 - t1))
        if (t0 !== t1) times.push({...identity, stage: s, lowRestrictedSeconds: t0, highRestrictedSeconds: t1})
      }
    }
    const r = reports[low]
    assert.equal(r.lowResolution, low); assert.equal(r.highResolution, low + 1); assert.equal(r.comparedSettings, 1152)
    assert.deepEqual(r.decisionChanges.map(canonical).sort(), changes.map(canonical).sort())
    assert.deepEqual(r.restrictedTimeChanges.map(canonical).sort(), times.map(canonical).sort())
    assert.equal(r.maxRestrictedTimeDifferenceSeconds, maximum)
  }
}

function provenance(root) {
  const m = read(join(root, 'manifest.json')), input = m.inputDirectory
  const closure = read(join(input, 'closure.json')), upstream = read(join(input, 'manifest.json'))
  assert.equal(m.schemaVersion, 'outdoor-mechanism-posthoc-v1')
  assert.equal(m.postHoc, true); assert.equal(m.newIndependentWorlds, 0); assert.equal(m.newTransportSimulations, 0)
  assert.equal(m.awsLaunched, false); assert.equal(closure.accepted, true)
  const pins = {manifest: '4b26f5e096d1a1e88e75fb9164b3a24a737ddda069832c366108d66e26158b9a',
    audit: 'd7893718edf257496a9b12d0c140a72c27d5b775729bdab8029de6874d2406b1',
    report: 'c93253e10202b67207654235bc2ea00c94cd1cc7020ff65113c6e48e4d039f6f'}
  assert.deepEqual(m.inputPins, pins)
  for (const [name, expected] of Object.entries(pins)) {
    assert.equal(sha(join(input, name === 'report' ? 'report.md' : `${name}.json`)), expected)
    assert.equal(closure[name + 'Sha256'], expected)
  }
  assert.equal(sha(join(input, 'closure.json')), m.inputClosureSha256)
  const complete = read(join(input, 'execution-complete.json'))
  assert.equal(sha(join(input, 'execution-complete.json')), m.inputExecutionSha256)
  assert.equal(m.inputExecutionSha256, read(join(input, 'audit.json')).executionReceiptSha256)
  assert.equal(complete.files.length, 544); assert.equal(upstream.specs.length, 544)
  for (const r of [...m.sourceHashes, ...upstream.sourceHashes]) assert.equal(sha(r.file), r.sha256)
  for (const r of m.sourceHashes) assert.equal(sha(join(root, 'source-snapshot', r.file)), r.sha256)
  for (const r of upstream.sourceHashes) assert.equal(sha(join(input, 'source-snapshot', r.file)), r.sha256)
  const frozen = upstream.pilot.manifest.frozenStage2i
  assert.equal(frozen.hashes.length, 141); assert.equal(sha(frozen.bundle), frozen.bundleSha256)
  for (const r of frozen.hashes) assert.equal(sha(r.file), r.sha256)
  for (let i = 0; i < complete.files.length; i++) {
    const r = complete.files[i]; assert.equal(r.index, i); assert.equal(r.file, `trace-${String(i).padStart(3, '0')}.json.gz`)
    assert.equal(sha(join(input, r.file)), r.sha256)
  }
  return {m, input, upstream, complete}
}

function selfTest() {
  const s = {sampleSeconds: 1, delaySeconds: 1, riseSeconds: .5, recoverySeconds: 1, noisePpm: .2, saturationPpm: 10000}
  const step = instrument(Array(40).fill(4), .25, s, Array(10).fill(0)).quiet
  near(step[0], 2); step.slice(1).forEach((x, i) => near(x, 4 - 2 * Math.exp(-(i + 1) / .5), 1e-14))
  assert.equal(first([3, 3, 3], 3), null); assert.equal(first([2, 4, 4, 4], 3), 4)
  const x = [...Array(4).fill(5), ...Array(36).fill(2)]
  const ss = {...s, delaySeconds: 0, riseSeconds: .01, recoverySeconds: 10}
  assert.equal(first(sampled(x, .25, ss, false), 3), null)
  assert.equal(first(instrument(x, .25, ss, Array(10).fill(0)).quiet, 3), 3)
  const clipped = instrument(Array(16).fill(10), .25, {...s, delaySeconds: 0, noisePpm: 1, saturationPpm: 3}, Array(4).fill(-5))
  assert.deepEqual(clipped.noisy, [3, 3, 3, 3])
  const expected = {traceIndex: 0, world: 1000, wind: .5, speed: 1, resolution: 0, sensor: 'fixture',
    rateKgPerSecond: .0001, k: 5, maxExcessPpm: 1, thresholdExcessPpm: 1, exposureSeconds: 2,
    decisions: {a: true}, alarmSeconds: {a: 5}}
  checkRecord(expected, expected)
  for (const mutation of [{world: 1001}, {decisions: {a: false}}, {alarmSeconds: {a: null}}, {exposureSeconds: 1}])
    assert.throws(() => checkRecord({...expected, ...mutation}, expected))
  console.log('Independent checker self-tests passed: analytic step, strict threshold, non-nesting, clipping, four corruption rejections.')
}

function main(root) {
  assert.ok(!existsSync(join(root, 'closure.json')), 'Output already closed')
  const start = performance.now(), {input, upstream, complete} = provenance(root)
  const rows = JSON.parse(gunzipSync(readFileSync(join(root, 'diagnostics.json.gz')))), summary = read(join(root, 'summary.json'))
  assert.equal(rows.length, 39168); assert.equal(summary.allRecords, rows.length)
  assert.equal(summary.primaryRecords, 36864); assert.equal(summary.primaryHistories, 512)
  assert.equal(summary.rawHistories, 544); assert.equal(summary.independentWorldsPerSetting, 128)
  assert.equal(summary.postHoc, true); assert.equal(summary.newIndependentWorlds, 0)
  let maxError = 0
  for (let i = 0; i < 544; i++) {
    const trace = JSON.parse(gunzipSync(readFileSync(join(input, complete.files[i].file))))
    assert.deepEqual(trace.spec, upstream.specs[i])
    maxError = Math.max(maxError, reconstruct(trace, i, rows.slice(i * 72, (i + 1) * 72)))
    if ((i + 1) % 64 === 0) console.log(`independently checked ${i + 1}/544 histories`)
  }
  checkSummaries(rows, summary.groups); checkRefinement(rows, summary.refinement)
  provenance(root)
  const audit = {schemaVersion: 'outdoor-mechanism-check-v1', accepted: true, postHoc: true,
    checkedAt: new Date().toISOString(), histories: 544, records: rows.length, groups: 288,
    refinementTriplets: 16, independentWorldsPerSetting: 128, newIndependentWorlds: 0,
    maxObservedReadingErrorPpm: maxError, originalScientificFilesUnchanged: 141,
    campaignSourcesUnchanged: upstream.sourceHashes.length, seconds: (performance.now() - start) / 1000,
    physicalValidation: false, independentCounterfactualImplementation: true,
    manifestSha256: sha(join(root, 'manifest.json')), diagnosticsSha256: sha(join(root, 'diagnostics.json.gz')),
    summarySha256: sha(join(root, 'summary.json')), reportSha256: sha(join(root, 'report.md'))}
  write(join(root, 'audit.json'), audit)
  write(join(root, 'closure.json'), {accepted: true, postHoc: true, scientificInterpretation: 'exploratory-model-conditional-reanalysis',
    auditSha256: sha(join(root, 'audit.json')), ...Object.fromEntries(['manifestSha256', 'diagnosticsSha256', 'summarySha256', 'reportSha256'].map(k => [k, audit[k]])),
    physicalValidation: false, newIndependentWorlds: 0, awsLaunched: false})
  console.log(JSON.stringify(audit))
}

if (process.argv.includes('--self-test')) selfTest()
else {
  assert.equal(process.argv[2], '--input', 'Use --self-test or --input DIRECTORY')
  main(resolve(process.argv[3]))
}
