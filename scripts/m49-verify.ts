import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
const dir=resolve(process.argv[2]??'research/results/m49-revisit-validation-v1')
const parse=(f:string)=>JSON.parse(readFileSync(join(dir,f),'utf8')),m=parse('manifest.json'),s=parse('summary.json')
const hash=(f:string)=>createHash('sha256').update(readFileSync(f)).digest('hex')
for(const [f,h]of Object.entries(m.artifactHashes))assert.equal(hash(join(dir,f)),h)
for(const [f,h]of Object.entries(m.sourceHashes))assert.equal(hash(join(dir,'source-snapshot',f)),h)
const rows=readFileSync(join(dir,'missions.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x))
assert.equal(rows.length,144);assert.equal(s.missions,144)
const groups=new Map<string,any[]>()
for(const r of rows){const k=JSON.stringify(r.case),g=groups.get(k)??[];g.push(r);groups.set(k,g)
  assert.ok(r.elapsedSeconds<=251+1e-8);assert.ok(r.readoutCount<=240);assert.ok(r.distanceMetres<=1.1+1e-8)
  const visits=r.confirmations.filter((c:any)=>c.reason!=='insufficient-budget').length
  assert.equal(r.readoutCount,24*(r.trace.length+visits))
  assert.equal(r.success,r.declared!==null&&r.case.kind==='steady-release'&&r.localizationError<=.015)
  assert.equal(r.falseDeclaration,r.declared!==null&&!r.success)
  if(r.confirmation==='revisit'&&r.declared)assert.ok(r.confirmations.some((c:any)=>c.accepted&&JSON.stringify(c.candidate)===JSON.stringify(r.declared)))
}
assert.equal(groups.size,24)
for(const g of groups.values()){assert.equal(g.length,6);assert.equal(new Set(g.map(r=>r.arm+r.confirmation)).size,6)}
for(const v of s.summaryRows){const rs=rows.filter(r=>r.case.kind===v.kind&&r.arm===v.arm&&r.confirmation===v.confirmation)
  assert.equal(v.missions,rs.length);assert.equal(v.successes,rs.filter(r=>r.success).length)
  assert.equal(v.declarations,rs.filter(r=>r.declared).length);assert.equal(v.falseDeclarations,rs.filter(r=>r.falseDeclaration).length)
  assert.equal(v.confirmationAttempts,rs.reduce((s,r)=>s+r.confirmations.length,0))
  assert.equal(v.budgetDenied,rs.reduce((s,r)=>s+r.confirmations.filter((c:any)=>c.reason==='insufficient-budget').length,0))
  assert.ok(Math.abs(v.meanTime-rs.reduce((s,r)=>s+r.elapsedSeconds,0)/rs.length)<1e-8)
  assert.ok(Math.abs(v.meanDistance-rs.reduce((s,r)=>s+r.distanceMetres,0)/rs.length)<1e-8)
}
assert.equal(s.peakAudit.length,18)
for(const a of s.peakAudit){assert.ok(a.interior);assert.ok(a.peakValue>=a.sourceValue)
  assert.equal(a.exceedsLocalizationTolerance,Math.abs(a.peakX)>.015)}
console.log(JSON.stringify({verified:true,missions:144,matchedGroups:24,peakAuditCases:18,archivedSources:Object.keys(m.sourceHashes).length}))
