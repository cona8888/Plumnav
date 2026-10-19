import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import type {runM48Mission} from './lib/m48-mission'
type Row=ReturnType<typeof runM48Mission>
const dir=resolve(process.argv[2]??'research/results/m48-trajectory-pilot-v1')
const parse=(f:string)=>JSON.parse(readFileSync(join(dir,f),'utf8')),m=parse('manifest.json'),s=parse('summary.json')
const hash=(f:string)=>createHash('sha256').update(readFileSync(f)).digest('hex')
for(const [f,h]of Object.entries(m.artifactHashes))assert.equal(hash(join(dir,f)),h)
for(const [f,h]of Object.entries(m.sourceHashes))assert.equal(hash(join(dir,'source-snapshot',f)),h)
const rows:Row[]=readFileSync(join(dir,'missions.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x))
assert.equal(rows.length,72);assert.equal(s.caseCount,72)
const groups=new Map<string,Row[]>()
for(const r of rows){const k=JSON.stringify(r.case),g=groups.get(k)??[];g.push(r);groups.set(k,g)
  assert.ok(r.elapsedSeconds<=r.maximumSeconds+1e-8);assert.equal(r.readoutCount,r.trace.length*24)
  assert.ok(r.distanceMetres<=r.trace.length*.11+1e-8)
  assert.equal(r.success,r.declared!==null&&r.case.kind==='steady-release'&&r.localizationError!<=.015)
  assert.equal(r.falseDeclaration,r.declared!==null&&!r.success)
  if(r.declared)assert.deepEqual(r.declared,r.trace.at(-1)!.declared)
  else assert.ok(Math.abs(r.elapsedSeconds-251)<1e-8)
}
assert.equal(groups.size,24)
for(const g of groups.values()){
  assert.equal(g.length,3);assert.equal(new Set(g.map(r=>r.arm)).size,3)
  assert.equal(new Set(g.map(r=>r.maximumSeconds)).size,1)
}
const counts=(rs:Row[],v:any)=>{
  assert.equal(v.missions,rs.length);assert.equal(v.successes,rs.filter(r=>r.success).length)
  assert.equal(v.declarations,rs.filter(r=>r.declared).length);assert.equal(v.falseDeclarations,rs.filter(r=>r.falseDeclaration).length)
  assert.equal(v.stoppedSourceDeclarations,rs.filter(r=>r.stoppedSourceDeclaration).length)
  assert.ok(Math.abs(v.meanTime-rs.reduce((s,r)=>s+r.elapsedSeconds,0)/rs.length)<1e-9)
  assert.ok(Math.abs(v.meanDistance-rs.reduce((s,r)=>s+r.distanceMetres,0)/rs.length)<1e-9)
  assert.equal(v.cueAccepted,rs.reduce((s,r)=>s+r.trace.filter(t=>t.cueAccepted).length,0))
  assert.equal(v.cueChecks,rs.reduce((s,r)=>s+r.trace.length,0))
  assert.equal(v.plumeContacts,rs.reduce((s,r)=>s+r.plumeContacts,0))
}
for(const [a,v]of Object.entries(s.byArm))counts(rows.filter(r=>r.arm===a),v)
for(const [k,arms]of Object.entries(s.byKind))for(const [a,v]of Object.entries(arms as object))
  counts(rows.filter(r=>r.arm===a&&r.case.kind===k),v)
console.log(JSON.stringify({verified:true,missions:rows.length,matchedGroups:groups.size,archivedSources:Object.keys(m.sourceHashes).length}))
