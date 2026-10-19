import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,join,basename} from 'node:path'
import {createHash} from 'node:crypto'

// Read-only, independent archive verification. Does not rerun the producer.
const dir=resolve(process.argv[2]??'research/results/m51-gaden-native-smoke-v1')
const json=f=>JSON.parse(readFileSync(join(dir,f),'utf8'))
const hash=f=>createHash('sha256').update(readFileSync(f)).digest('hex')
const manifest=json('manifest.json'), report=json('summary.json')
for(const [file,expected] of Object.entries(manifest.artifactHashes))
  assert.equal(hash(join(dir,file)),expected,`artifact hash: ${file}`)
for(const [file,expected] of Object.entries(manifest.sourceHashes)) {
  assert.equal(hash(resolve(file)),expected,`working source hash: ${file}`)
  assert.equal(hash(join(dir,basename(file))),expected,`archived source hash: ${file}`)
}
assert.equal(report.upstreamCommit,'1a20e35cd5f174ae9675a2ae3c796137a05c4ee5')
assert.equal(report.platform,'darwin');assert.equal(report.architecture,'arm64')
assert.equal(report.threadsPerProcess,1);assert.equal(report.workers.length,3)
assert.equal(new Set(report.workers.map(w=>w.pid)).size,3)
for(const worker of report.workers) {
  const records=readFileSync(join(dir,worker.name+'.log'),'utf8').split('\n')
    .filter(line=>line.startsWith('{')).map(line=>JSON.parse(line))
  assert.deepEqual(records.at(-1),worker.complete)
  assert.deepEqual(records.slice(0,-1),worker.samples)
  assert.equal(worker.exitCode,0);assert.ok(worker.end>=worker.start)
  assert.equal(worker.complete.complete,true);assert.equal(worker.complete.samples,90)
  assert.equal(worker.samples.length,90)
  assert.ok(worker.complete.wallSeconds>0)
  const coords=new Set()
  for(const row of worker.samples) {
    assert.ok(Number.isFinite(row.ppm)&&row.ppm>=0)
    assert.ok(Math.abs(row.time-Math.round(row.time))<1e-3)
    assert.ok(row.time>.99&&row.time<10.001)
    assert.ok([.4,.45,.6].some(x=>Math.abs(x-row.x)<1e-6))
    assert.ok([.05,.1,.2].some(z=>Math.abs(z-row.height)<1e-6))
    coords.add(`${Math.round(row.time)}:${row.x}:${row.height}`)
  }
  assert.equal(coords.size,90)
  assert.equal(Math.max(...worker.samples.map(r=>r.ppm)),worker.complete.maximumPpm)
  const absent=worker.mode==='absent'
  assert.equal(worker.complete.absent,absent)
  assert.equal(worker.complete.filaments,absent?0:50)
  if(absent)assert.ok(worker.samples.every(r=>r.ppm===0))
  else assert.ok(worker.complete.maximumPpm>0)
}
assert.deepEqual(report.workers[0].samples,report.workers[2].samples)
const firstTwo=report.workers.slice(0,2)
assert.equal(Math.min(...firstTwo.map(w=>w.end))-Math.max(...firstTwo.map(w=>w.start)),report.parallelOverlapMs)
assert.ok(report.parallelOverlapMs>=0)
console.log(JSON.stringify({verified:true,workers:3,samples:270,
  sourceHashes:Object.keys(manifest.sourceHashes).length,
  artifactHashes:Object.keys(manifest.artifactHashes).length,
  scope:'Archive integrity and compatibility only; neither methane physics nor CPU scaling validated'},null,2))
