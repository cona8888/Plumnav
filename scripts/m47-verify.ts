import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import type {runM47Case} from './lib/m47-development'
type Row=ReturnType<typeof runM47Case>
const dir=resolve(process.argv[2]??'research/results/m47-transport-pilot-v1')
const parse=(f:string)=>JSON.parse(readFileSync(join(dir,f),'utf8')),m=parse('manifest.json'),s=parse('summary.json')
const hash=(f:string)=>createHash('sha256').update(readFileSync(f)).digest('hex')
for(const [f,h]of Object.entries(m.artifactHashes))assert.equal(hash(join(dir,f)),h)
for(const [f,h]of Object.entries(m.sourceHashes))assert.equal(hash(join(dir,'source-snapshot',f)),h)
const rows:Row[]=readFileSync(join(dir,'trials.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x))
assert.equal(rows.length,1152);assert.equal(s.caseCount,rows.length)
const groups=new Map<string,Row[]>()
for(const r of rows){const k=JSON.stringify(r.case),g=groups.get(k)??[];g.push(r);groups.set(k,g)}
assert.equal(groups.size,288)
for(const g of groups.values()){
  assert.equal(g.length,4);assert.equal(new Set(g.map(r=>r.arm)).size,4)
  for(const r of g){assert.equal(r.elapsedSeconds,24.1);assert.equal(r.readoutCount,24)
    assert.ok(Number.isFinite(r.finalConcentration)&&r.finalConcentration>=0)}
  assert.equal(g.find(r=>r.arm==='m46-bounded-stationary')!.distanceMetres,0)
}
for(const name of ['byArm','byKind','byNoise','regimes']){
  const keys=Object.keys(s[name][0].key),index=new Map<string,Row[]>(),seen=new Set<string>()
  for(const r of rows){const k=JSON.stringify(Object.fromEntries(keys.map(k=>[k,k==='arm'?r.arm:r.case[k as keyof typeof r.case]]))),g=index.get(k)??[];
    g.push(r);index.set(k,g)}
  let total=0
  for(const v of s[name]){
    const k=JSON.stringify(v.key);assert.ok(!seen.has(k));seen.add(k);const rs=index.get(k);assert.ok(rs)
    total+=rs.length;const a=rs.filter(r=>r.check.accepted)
    assert.equal(v.rows,rs.length);assert.equal(v.accepted,a.length);assert.equal(v.abstained,rs.length-a.length)
    assert.equal(v.gradientWrong,a.filter(r=>r.endErrorDegrees!==null&&r.endErrorDegrees>45).length)
    assert.equal(v.gradientUndefined,a.filter(r=>r.endErrorDegrees===null).length)
    assert.equal(v.sourceBearingWrong,a.filter(r=>r.sourceBearingError!==null&&r.sourceBearingError>45).length)
    assert.equal(v.sourceBearingUndefined,a.filter(r=>r.sourceBearingError===null).length)
    if(name==='regimes')assert.equal(rs.length,2)
  }
  assert.equal(total,rows.length);assert.equal(seen.size,index.size)
}
assert.equal(s.regimes.length,576)
console.log(JSON.stringify({verified:true,rows:rows.length,matchedGroups:groups.size,regimes:s.regimes.length,archivedSources:Object.keys(m.sourceHashes).length}))
