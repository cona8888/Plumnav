import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import type {runM45Case} from './lib/m45-window-development'
type Row=ReturnType<typeof runM45Case>&{stage:string}
const directory=resolve(process.argv[2]??'research/results/m45-full-window-development-v1')
const parse=(f:string)=>JSON.parse(readFileSync(join(directory,f),'utf8')),m=parse('manifest.json'),s=parse('summary.json')
const hash=(f:string)=>createHash('sha256').update(readFileSync(f)).digest('hex')
for(const [f,h]of Object.entries(m.artifactHashes))assert.equal(hash(join(directory,f)),h)
for(const [f,h]of Object.entries(m.sourceHashes))assert.equal(hash(join(directory,'source-snapshot',f)),h)
const rows:Row[]=readFileSync(join(directory,'trials.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x))
assert.equal(rows.length,30976);assert.equal(s.caseCount,rows.length)
assert.equal(rows.filter(r=>r.stage==='main').length,28672)
assert.equal(rows.filter(r=>r.stage==='stress').length,2304)
const groups=new Map<string,Row[]>()
for(const r of rows){const k=JSON.stringify([r.stage,r.config,r.stress]),g=groups.get(k)??[];g.push(r);groups.set(k,g)}
assert.equal(groups.size,7744)
for(const g of groups.values()){
  assert.equal(g.length,4);assert.equal(new Set(g.map(r=>r.arm)).size,4)
  assert.equal(new Set(g.map(r=>r.elapsedSeconds)).size,1);assert.equal(new Set(g.map(r=>r.readoutCount)).size,1)
  assert.equal(g.find(r=>r.arm==='full-stationary')!.distanceMetres,0)
  for(const r of g){assert.equal(r.initialCount,r.arm==='four-directed'?4:r.config.dwell)
    assert.equal(r.terminalCount,r.initialCount)}
  if(g[0]!.config.dwell===4)assert.deepEqual(g.find(r=>r.arm==='four-directed')!.check,g.find(r=>r.arm==='full-directed')!.check)
}
const counts=(rs:Row[],v:Record<string,number>)=>{
  assert.equal(v.rows,rs.length);assert.equal(v.accepted,rs.filter(r=>r.check.accepted).length)
  assert.equal(v.wrong,rs.filter(r=>r.check.accepted&&r.endErrorDegrees!==null&&r.endErrorDegrees>45).length)
  assert.equal(v.noGradient,rs.filter(r=>r.check.accepted&&r.endErrorDegrees===null).length)
}
for(const name of ['byArm','byNoiseDwell','byField','byStress','regimes']){
  let total=0;const seen=new Set<string>()
  const keys=Object.keys(s[name][0].key)
  const index=new Map<string,Row[]>()
  for(const r of rows){
    const key=JSON.stringify(Object.fromEntries(keys.map(k=>[k,k==='stage'?r.stage:k==='arm'?r.arm:
      k==='tauFactor'?r.stress.tauFactor:k==='rho'?r.stress.rho:r.config[k as keyof typeof r.config]])))
    const g=index.get(key)??[];g.push(r);index.set(key,g)
  }
  for(const v of s[name]){
    const key=JSON.stringify(v.key);assert.ok(!seen.has(key));seen.add(key)
    const rs=index.get(key);assert.ok(rs)
    counts(rs,v);total+=rs.length
    if(name==='regimes')assert.equal(rs.length,8)
  }
  assert.equal(total,rows.length)
  assert.equal(seen.size,index.size)
}
assert.equal(s.regimes.length,3872)
console.log(JSON.stringify({verified:true,rows:rows.length,matchedGroups:groups.size,regimes:s.regimes.length,archivedSources:Object.keys(m.sourceHashes).length}))
