/** Read-only archive verification independent of the simulation runner. */
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import type { runM41Case } from './lib/m41-development'
type Row=ReturnType<typeof runM41Case>
const directory=resolve(process.argv[2]??'research/results/m41-spatial-prediction-development-v1')
const parse=(f:string)=>JSON.parse(readFileSync(join(directory,f),'utf8'))
const manifest=parse('manifest.json'), summary=parse('summary.json')
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex')
for(const [file,value] of Object.entries(manifest.artifactHashes))assert.equal(hash(join(directory,file)),value)
for(const [file,value] of Object.entries(manifest.sourceHashes))assert.equal(hash(join(directory,'source-snapshot',file)),value)
const rows:Row[]=readFileSync(join(directory,'trials.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
assert.equal(rows.length,6912);assert.equal(summary.caseCount,rows.length)
const groups=new Map<string,Row[]>()
for(const r of rows){
  const {arm,...config}=r.config
  const key=JSON.stringify(config), group=groups.get(key)??[]
  group.push(r);groups.set(key,group)
  assert.ok(Number.isFinite(r.elapsedSeconds)&&Number.isFinite(r.distanceMetres))
  assert.ok(Math.abs(r.ratios.spacingToFeature-r.config.spacing/r.config.feature)<1e-12)
  if(r.config.field!=='rotating-linear')assert.equal(r.ratios.memoryToCorrelation,null)
  if(r.check.accepted){assert.equal(r.baselineAccepted,true);assert.ok(r.check.maximumError!<=r.config.tolerance)}
  assert.ok(['directed-probe','stationary-check','random-probe'].includes(arm))
}
assert.equal(groups.size,2304)
for(const g of groups.values()){
  assert.equal(g.length,3);assert.equal(new Set(g.map(r=>r.config.arm)).size,3)
  assert.equal(new Set(g.map(r=>r.elapsedSeconds)).size,1)
  assert.equal(new Set(g.map(r=>r.readoutCount)).size,1)
  assert.equal(new Set(g.map(r=>JSON.stringify(r.initialDirection))).size,1)
  assert.equal(new Set(g.map(r=>r.baselineAccepted)).size,1)
  assert.equal(g.find(r=>r.config.arm==='stationary-check')!.distanceMetres,0)
}
for(const [arm,s] of Object.entries(summary.byArm) as [string,Record<string,number>][]){
  const rs=rows.filter(r=>r.config.arm===arm), accepted=rs.filter(r=>r.check.accepted)
  assert.equal(s.trials,rs.length)
  assert.equal(s.accepted,accepted.length)
  assert.equal(s.initialAccepted,rs.filter(r=>r.baselineAccepted).length)
  assert.equal(s.acceptedWrongAtEnd,accepted.filter(r=>r.endErrorDegrees!==null&&r.endErrorDegrees>45).length)
  assert.equal(s.acceptedWithoutTrueGradient,accepted.filter(r=>r.endErrorDegrees===null).length)
  assert.equal(s.initialWrongRejected,rs.filter(r=>r.baselineAccepted&&r.initialErrorDegrees!==null&&
    r.initialErrorDegrees>45&&!r.check.accepted).length)
}
console.log(JSON.stringify({verified:true,rows:rows.length,matchedGroups:groups.size,
  archivedSourceFiles:Object.keys(manifest.sourceHashes).length,
  note:'Integrity and count checks only; no claim of physical or statistical validation'},null,2))
