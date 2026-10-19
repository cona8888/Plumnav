import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import type {runM44Case} from './lib/m44-development'
type Row=ReturnType<typeof runM44Case>
const directory=resolve(process.argv[2]??'research/results/m44-relative-input-development-v1')
const parse=(f:string)=>JSON.parse(readFileSync(join(directory,f),'utf8')),m=parse('manifest.json'),s=parse('summary.json')
const hash=(f:string)=>createHash('sha256').update(readFileSync(f)).digest('hex')
for(const [f,h]of Object.entries(m.artifactHashes))assert.equal(hash(join(directory,f)),h)
for(const [f,h]of Object.entries(m.sourceHashes))assert.equal(hash(join(directory,'source-snapshot',f)),h)
const rows:Row[]=readFileSync(join(directory,'trials.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x))
assert.equal(rows.length,35840);assert.equal(s.caseCount,rows.length)
const groups=new Map<string,Row[]>()
for(const r of rows){const k=JSON.stringify(r.config),g=groups.get(k)??[];g.push(r);groups.set(k,g)}
assert.equal(groups.size,7168)
for(const g of groups.values()){
  assert.equal(g.length,5);assert.equal(new Set(g.map(r=>r.arm)).size,5)
  assert.equal(new Set(g.map(r=>r.elapsedSeconds)).size,1);assert.equal(new Set(g.map(r=>r.readoutCount)).size,1)
  assert.equal(new Set(g.map(r=>r.baselineAccepted)).size,1)
  assert.equal(new Set(g.map(r=>JSON.stringify(r.initialDirection))).size,1)
  assert.equal(g.find(r=>r.arm==='relative-stationary')!.distanceMetres,0)
  for(const r of g.filter(r=>r.arm!=='absolute-directed'&&r.check.accepted)){
    assert.ok((r.diagnostics!.upperMismatch as number)<=r.check.threshold)
    assert.ok((r.diagnostics!.trainingUpper as number)<=r.check.threshold)
  }
}
const counts=(rs:Row[],v:Record<string,number>)=>{
  const a=rs.filter(r=>r.check.accepted)
  assert.equal(v.rows,rs.length);assert.equal(v.accepted,a.length)
  assert.equal(v.initialAccepted,rs.filter(r=>r.baselineAccepted).length)
  assert.equal(v.wrong,a.filter(r=>r.endErrorDegrees!==null&&r.endErrorDegrees>45).length)
  assert.equal(v.noGradient,a.filter(r=>r.endErrorDegrees===null).length)
}
for(const [arm,v]of Object.entries(s.byArm))counts(rows.filter(r=>r.arm===arm),v as Record<string,number>)
for(const [field,arms]of Object.entries(s.byField))for(const [arm,v]of Object.entries(arms as Record<string,Record<string,number>>))
  counts(rows.filter(r=>r.arm===arm&&r.config.field===field),v)
for(const n of s.byNoise)for(const [arm,v]of Object.entries(n.arms))counts(rows.filter(r=>r.arm===arm&&r.config.noise===n.noise),v as Record<string,number>)
const key=(r:{arm:string;config:Row['config']})=>JSON.stringify([r.arm,r.config.field,r.config.feature,r.config.tau,
  r.config.dwell,r.config.noise,r.config.fieldAngle,r.config.correlationTime])
const regimes=new Map<string,Row[]>()
for(const r of rows){const k=key(r),g=regimes.get(k)??[];g.push(r);regimes.set(k,g)}
assert.equal(s.regimes.length,2240);const seen=new Set<string>()
for(const v of s.regimes){const k=key(v);assert.ok(!seen.has(k));seen.add(k);const rs=regimes.get(k);assert.ok(rs);
  assert.equal(rs.length,16);counts(rs,v)}
assert.equal(seen.size,regimes.size)
console.log(JSON.stringify({verified:true,rows:rows.length,matchedGroups:groups.size,regimes:regimes.size,archivedSources:Object.keys(m.sourceHashes).length}))
