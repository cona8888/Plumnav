import {mkdirSync,writeFileSync,readFileSync,copyFileSync,constants} from 'node:fs'
import {resolve,join,dirname} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {runM43Case,M43_ARMS} from './lib/m43-development'
import {M41_REFERENCE,type FieldKind} from './lib/m41-development'
const output=process.argv[2];if(!output)throw new Error('Supply new output directory')
const directory=resolve(output);mkdirSync(directory,{recursive:false})
type Row=ReturnType<typeof runM43Case>
const summarize=(rs:Row[])=>{
  const accepted=rs.filter(r=>r.check.accepted),scorable=accepted.filter(r=>r.endErrorDegrees!==null)
  return {rows:rs.length,initialAccepted:rs.filter(r=>r.baselineAccepted).length,
    accepted:accepted.length,acceptedScorable:scorable.length,
    wrong:scorable.filter(r=>r.endErrorDegrees!>45).length,noGradient:accepted.length-scorable.length,
    meanTime:rs.reduce((s,r)=>s+r.elapsedSeconds,0)/rs.length,
    meanDistance:rs.reduce((s,r)=>s+r.distanceMetres,0)/rs.length}
}
const rows:Row[]=[],fields:FieldKind[]=['linear','cubic-reversal','rotating-linear','uniform','zero']
for(const field of fields)for(const feature of [.1,.2])for(const tau of [M41_REFERENCE.tau,3])
  for(const dwell of [4,12])for(const noise of [0,.01])for(const fieldAngle of [0,Math.PI/8,Math.PI/4,Math.PI/2])
    for(const correlationTime of field==='rotating-linear'?[5,20,80]:[20])for(let seed=201;seed<=216;seed++)
      for(const arm of M43_ARMS)rows.push(runM43Case({field,feature,tau,dwell,noise,fieldAngle,correlationTime,seed},arm))
assert.equal(rows.length,43008)
const byArm=Object.fromEntries(M43_ARMS.map(arm=>[arm,summarize(rows.filter(r=>r.arm===arm))]))
const byField=Object.fromEntries(fields.map(f=>[f,Object.fromEntries(M43_ARMS.map(arm=>[arm,summarize(rows.filter(r=>r.arm===arm&&r.config.field===f))]))]))
const groups=new Map<string,Row[]>()
for(const r of rows){const {seed,...config}=r.config,key=JSON.stringify({...config,arm:r.arm});
  const g=groups.get(key)??[];g.push(r);groups.set(key,g)}
const regimes=[...groups.values()].map(rs=>({arm:rs[0]!.arm,config:{...rs[0]!.config,seed:undefined},
  ratios:rs[0]!.ratios,...summarize(rs)}))
const linearTiming=M43_ARMS.flatMap(arm=>[M41_REFERENCE.tau,3].flatMap(tau=>[4,12].map(dwell=>({
  arm,tau,dwell,...summarize(rows.filter(r=>r.arm===arm&&r.config.field==='linear'&&r.config.tau===tau&&r.config.dwell===dwell))}))))
const convergence=['linear','cubic-reversal','rotating-linear'].flatMap(field=>['lag-directed','lag-orientation'].map(arm=>({field,arm,
  runs:[.05,.025,.0125].map(integrationStep=>{const r=runM43Case({field:field as FieldKind,integrationStep,tau:3,dwell:4},arm as typeof M43_ARMS[number]);
    return {integrationStep,accepted:r.check.accepted,error:r.check.maximumError,endAngle:r.endErrorDegrees}})})))
const report={version:'m43-development-v1',createdAt:new Date().toISOString(),developmentOnly:true,caseCount:rows.length,
  byArm,byField,regimes,linearTiming,convergence,limitations:[
    'Manufactured-field diagnostics, not transported methane or full GSL; repeated deterministic rows are not independent evidence.',
    'Assumes calibrated tau and independent readout noise, fixed-pose constant input during initial fitting and completed tube transition.',
    'Only intercept readout uncertainty is propagated; model mismatch, drift, correlation and sequential testing remain uncalibrated.',
    'Rotated alternatives are finite cubic modes; geometry-based probe selection need not outperform a fixed direction.',
    'Initial and final local-gradient accuracy are not source-bearing accuracy; acceptance and errors must be reported together.',
  ]}
const artifacts={'trials.jsonl':rows.map(r=>JSON.stringify(r)).join('\n')+'\n','summary.json':JSON.stringify(report,null,2)+'\n'}
const hash=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex')
for(const [f,s]of Object.entries(artifacts))writeFileSync(join(directory,f),s,{flag:'wx'})
const files=['scripts/lib/m41-spatial-check.ts','scripts/lib/m41-development.ts','scripts/lib/gsl-dimensional-design.ts',
  'scripts/lib/m42-noise-probe.ts','scripts/lib/m43-transient-probe.ts','scripts/lib/m43-development.ts',
  'scripts/m43-transient-probe.test.ts','scripts/m43-local-development.ts','scripts/m43-verify.ts',
  'research/protocols/m43_transient_spatial_development.md']
const sourceHashes:Record<string,string>={}
for(const f of files){const target=join(directory,'source-snapshot',f);mkdirSync(dirname(target),{recursive:true});
  copyFileSync(f,target,constants.COPYFILE_EXCL);sourceHashes[f]=hash(readFileSync(f))}
writeFileSync(join(directory,'manifest.json'),JSON.stringify({sourceHashes,
  artifactHashes:Object.fromEntries(Object.entries(artifacts).map(([f,s])=>[f,hash(s)]))},null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({directory,caseCount:rows.length,byArm,byField,linearTiming,convergence},null,2))
