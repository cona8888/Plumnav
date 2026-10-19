/** Read-only independent count/budget/source verification. */
import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import type {runM42Case} from './lib/m42-development'
type Row=ReturnType<typeof runM42Case>
const directory=resolve(process.argv[2]??'research/results/m42-noise-probe-development-v2')
const parse=(f:string)=>JSON.parse(readFileSync(join(directory,f),'utf8'))
const manifest=parse('manifest.json'),summary=parse('summary.json')
const hash=(f:string)=>createHash('sha256').update(readFileSync(f)).digest('hex')
for(const [f,h]of Object.entries(manifest.artifactHashes))assert.equal(hash(join(directory,f)),h)
for(const [f,h]of Object.entries(manifest.sourceHashes))assert.equal(hash(join(directory,'source-snapshot',f)),h)
const readRows=(f:string):Row[]=>readFileSync(join(directory,f),'utf8').trim().split('\n').map(s=>JSON.parse(s))
const rows=readRows('trials.jsonl'),stress=readRows('noise-stress.jsonl')
assert.equal(rows.length,43008);assert.equal(stress.length,8000)
const groups=new Map<string,Row[]>()
for(const r of rows){const key=JSON.stringify(r.config),g=groups.get(key)??[];g.push(r);groups.set(key,g)}
assert.equal(groups.size,7168)
for(const g of groups.values()){
  assert.equal(g.length,6);assert.equal(new Set(g.map(r=>r.arm)).size,6)
  assert.equal(new Set(g.map(r=>r.elapsedSeconds)).size,1);assert.equal(new Set(g.map(r=>r.readoutCount)).size,1)
  const gated=g.filter(r=>r.arm!=='fixed-directed')
  assert.equal(new Set(gated.map(r=>JSON.stringify(r.gate))).size,1)
  assert.equal(new Set(gated.map(r=>r.baselineAccepted)).size,1)
  assert.equal(g.find(r=>r.arm==='gated-stationary')!.distanceMetres,0)
}
const verifyCounts=(rs:Row[],s:Record<string,number>)=>{
  const a=rs.filter(r=>r.check.accepted)
  assert.equal(s.rows,rs.length);assert.equal(s.accepted,a.length)
  assert.equal(s.initialAccepted,rs.filter(r=>r.baselineAccepted).length)
  assert.equal(s.acceptedScorable,a.filter(r=>r.endErrorDegrees!==null).length)
  assert.equal(s.acceptedWrongAtEnd,a.filter(r=>r.endErrorDegrees!==null&&r.endErrorDegrees>45).length)
  assert.equal(s.acceptedWithoutGradient,a.filter(r=>r.endErrorDegrees===null).length)
}
for(const [arm,s]of Object.entries(summary.byArm))verifyCounts(rows.filter(r=>r.arm===arm),s as Record<string,number>)
for(const [field,arms]of Object.entries(summary.byField))for(const [arm,s]of Object.entries(arms as Record<string,Record<string,number>>))
  verifyCounts(rows.filter(r=>r.config.field===field&&r.arm===arm),s)
const regimeKey=(r:{arm:string;config:Row['config']})=>JSON.stringify([r.arm,r.config.field,r.config.feature,
  r.config.tau,r.config.dwell,r.config.noise,r.config.fieldAngle,r.config.correlationTime])
const regimeGroups=new Map<string,Row[]>()
for(const r of rows){const k=regimeKey(r),g=regimeGroups.get(k)??[];g.push(r);regimeGroups.set(k,g)}
assert.equal(summary.regimes.length,2688)
const seen=new Set<string>()
for(const s of summary.regimes){const key=regimeKey(s);assert.ok(!seen.has(key));seen.add(key)
  const rs=regimeGroups.get(key);assert.ok(rs);assert.equal(rs.length,16);verifyCounts(rs,s)
}
assert.equal(seen.size,regimeGroups.size)
for(const s of summary.stressSummary)verifyCounts(stress.filter(r=>r.arm===s.arm&&r.config.field===s.field&&r.calibrationFactor===s.calibrationFactor),s)
assert.equal(summary.headingAudit.quadrants.length,4)
console.log(JSON.stringify({verified:true,rows:rows.length,stressRows:stress.length,matchedGroups:groups.size,
  historicalReplays:summary.historicalM41RowsReplayed,archivedSources:Object.keys(manifest.sourceHashes).length},null,2))
