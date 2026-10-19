import {mkdirSync,writeFileSync,readFileSync,copyFileSync,constants} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {runM48Mission,M48_ARMS} from './lib/m48-mission'
import {makeTransportField} from './lib/m47-transport'
const output=process.argv[2];if(!output)throw new Error('Supply new output directory')
const dir=resolve(output);mkdirSync(dir,{recursive:false});const started=performance.now()
type Row=ReturnType<typeof runM48Mission>&{confirmation:'peak'|'revisit'}
const rows:Row[]=[]
for(const kind of ['steady-release','interrupted-release','absent'] as const)for(const y of [0,.15])
  for(const noise of [0,.003])for(const seed of [801,802])for(const arm of M48_ARMS)for(const confirmation of ['peak','revisit'] as const)
    rows.push({...runM48Mission({kind,start:{x:.6,y},noise,seed},arm,{confirmation}),confirmation})
assert.equal(rows.length,144)
const old=readFileSync('research/results/m48-trajectory-pilot-v1/missions.jsonl','utf8').trim().split('\n').map(x=>JSON.parse(x))
for(const r of old){const replay=runM48Mission(r.case,r.arm)
  for(const k of ['trace','declared','localizationError','success','falseDeclaration','elapsedSeconds','distanceMetres','readoutCount','plumeContacts'] as const)
    assert.deepEqual(JSON.parse(JSON.stringify(replay[k])),r[k],`M48 replay mismatch ${k}`)}
const summaryRows=[]
for(const kind of ['steady-release','interrupted-release','absent'])for(const arm of M48_ARMS)for(const confirmation of ['peak','revisit']){
  const rs=rows.filter(r=>r.case.kind===kind&&r.arm===arm&&r.confirmation===confirmation)
  summaryRows.push({kind,arm,confirmation,missions:rs.length,successes:rs.filter(r=>r.success).length,
    declarations:rs.filter(r=>r.declared).length,falseDeclarations:rs.filter(r=>r.falseDeclaration).length,
    confirmationAttempts:rs.reduce((s,r)=>s+r.confirmations.length,0),budgetDenied:rs.reduce((s,r)=>s+r.confirmations.filter(c=>c.reason==='insufficient-budget').length,0),
    meanTime:rs.reduce((s,r)=>s+r.elapsedSeconds,0)/rs.length,meanDistance:rs.reduce((s,r)=>s+r.distanceMetres,0)/rs.length})
}
// Evaluator-only peak/source mismatch audit. Not supplied to mission policies.
const peakAudit=[]
for(const wind of [.01,.02,.05])for(const diffusivity of [.0002,.0005,.002])for(const releaseStep of [1,.5]){
  const field=makeTransportField('steady-release',{wind:{x:wind,y:0},diffusivity},releaseStep,302)
  const f=(x:number)=>field.evaluate({x,y:0},250).concentration
  let best=-.1,bestValue=-Infinity
  for(let i=0;i<=300;i++){const x=-.1+i*.001,v=f(x);if(v>bestValue){best=x;bestValue=v}}
  let lo=best-.001,hi=best+.001
  for(let i=0;i<40;i++){const a=lo+(hi-lo)/3,b=hi-(hi-lo)/3;if(f(a)>f(b))hi=b;else lo=a}
  const x=(lo+hi)/2
  peakAudit.push({wind,diffusivity,releaseStep,peakX:x,peakValue:f(x),sourceValue:f(0),
    displacementFromSource:Math.abs(x),exceedsLocalizationTolerance:Math.abs(x)>.015,
    interior:best>-.1&&best<.2})
}
const report={version:'m49-revisit-and-peak-audit-v1',createdAt:new Date().toISOString(),missions:rows.length,
  m48ReplayCount:old.length,summaryRows,peakAudit,wallSeconds:(performance.now()-started)/1000,
  scope:'Local development: revisit persistence plus evaluator-only source/peak mismatch audit'}
const artifacts={'missions.jsonl':rows.map(r=>JSON.stringify(r)).join('\n')+'\n','summary.json':JSON.stringify(report,null,2)+'\n'}
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex')
for(const [f,v]of Object.entries(artifacts))writeFileSync(join(dir,f),v,{flag:'wx'})
const files=['scripts/lib/m41-spatial-check.ts','scripts/lib/m41-development.ts','scripts/lib/gsl-dimensional-design.ts',
  'scripts/lib/m42-noise-probe.ts','scripts/lib/m43-transient-probe.ts','scripts/lib/m44-relative-check.ts',
  'scripts/lib/m47-transport.ts','scripts/lib/m48-mission.ts','scripts/m49-revisit.test.ts','scripts/m49-local-validation.ts',
  'scripts/m49-verify.ts','research/protocols/m49_revisit_confirmation.md']
const sourceHashes:Record<string,string>={}
for(const f of files){const target=join(dir,'source-snapshot',f);mkdirSync(dirname(target),{recursive:true});
  copyFileSync(f,target,constants.COPYFILE_EXCL);sourceHashes[f]=hash(readFileSync(f))}
writeFileSync(join(dir,'manifest.json'),JSON.stringify({sourceHashes,
  artifactHashes:Object.fromEntries(Object.entries(artifacts).map(([f,v])=>[f,hash(v)]))},null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify(report,null,2))
