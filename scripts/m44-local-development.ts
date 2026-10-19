import {mkdirSync,writeFileSync,readFileSync,copyFileSync,constants} from 'node:fs'
import {resolve,join,dirname} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {runM44Case,M44_ARMS} from './lib/m44-development'
import {M41_REFERENCE,type FieldKind} from './lib/m41-development'
const output=process.argv[2];if(!output)throw new Error('Supply new output directory')
const directory=resolve(output);mkdirSync(directory,{recursive:false})
type Row=ReturnType<typeof runM44Case>
const summarize=(rs:Row[])=>{
  const a=rs.filter(r=>r.check.accepted)
  return {rows:rs.length,initialAccepted:rs.filter(r=>r.baselineAccepted).length,accepted:a.length,
    wrong:a.filter(r=>r.endErrorDegrees!==null&&r.endErrorDegrees>45).length,
    noGradient:a.filter(r=>r.endErrorDegrees===null).length}
}
const rows:Row[]=[],fields:FieldKind[]=['linear','cubic-reversal','rotating-linear','uniform','zero']
for(const field of fields)for(const feature of [.1,.2])for(const tau of [M41_REFERENCE.tau,3])
  for(const dwell of [4,12])for(const noise of [0,.01])for(const fieldAngle of [0,Math.PI/8,Math.PI/4,Math.PI/2])
    for(const correlationTime of field==='rotating-linear'?[5,20,80]:[20])for(let seed=301;seed<=316;seed++)
      for(const arm of M44_ARMS)rows.push(runM44Case({field,feature,tau,dwell,noise,fieldAngle,correlationTime,seed},arm))
assert.equal(rows.length,35840)
const byArm=Object.fromEntries(M44_ARMS.map(arm=>[arm,summarize(rows.filter(r=>r.arm===arm))]))
const byField=Object.fromEntries(fields.map(field=>[field,Object.fromEntries(M44_ARMS.map(arm=>[arm,summarize(rows.filter(r=>r.arm===arm&&r.config.field===field))]))]))
const byNoise=[0,.01].map(noise=>({noise,arms:Object.fromEntries(M44_ARMS.map(arm=>[arm,summarize(rows.filter(r=>r.arm===arm&&r.config.noise===noise))]))}))
const groups=new Map<string,Row[]>()
for(const r of rows){const {seed,...config}=r.config,key=JSON.stringify({...config,arm:r.arm});
  const g=groups.get(key)??[];g.push(r);groups.set(key,g)}
const regimes=[...groups.values()].map(rs=>({arm:rs[0]!.arm,config:{...rs[0]!.config,seed:undefined},
  ratios:rs[0]!.ratios,...summarize(rs)}))
const convergence=['linear','cubic-reversal','rotating-linear'].flatMap(field=>['relative-directed','relative-orientation'].map(arm=>({field,arm,
  runs:[.05,.025,.0125].map(integrationStep=>{const r=runM44Case({field:field as FieldKind,integrationStep,tau:3,dwell:4},arm as typeof M44_ARMS[number]);
    return {integrationStep,accepted:r.check.accepted,error:r.check.maximumError,endAngle:r.endErrorDegrees}})})))
const report={version:'m44-development-v1',createdAt:new Date().toISOString(),developmentOnly:true,caseCount:rows.length,
  byArm,byField,byNoise,regimes,convergence,limitations:[
    'Manufactured fields, not transported methane or full GSL. Deterministic repeats are not independent replicates.',
    'Conditional on calibrated first-order response and independent known readout noise; not general plume confidence.',
    'Relative inlet reconstruction and relative gating are combined, not isolated ablations.',
    'Sparse spatial agreement cannot certify the true local gradient or source direction.',
  ]}
const artifacts={'trials.jsonl':rows.map(r=>JSON.stringify(r)).join('\n')+'\n','summary.json':JSON.stringify(report,null,2)+'\n'}
const hash=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex')
for(const [f,s]of Object.entries(artifacts))writeFileSync(join(directory,f),s,{flag:'wx'})
const files=['scripts/lib/m41-spatial-check.ts','scripts/lib/m41-development.ts','scripts/lib/gsl-dimensional-design.ts',
  'scripts/lib/m42-noise-probe.ts','scripts/lib/m43-transient-probe.ts','scripts/lib/m44-relative-check.ts','scripts/lib/m44-development.ts',
  'scripts/m44-relative-check.test.ts','scripts/m44-local-development.ts','scripts/m44-verify.ts',
  'research/protocols/m44_relative_input_development.md']
const sourceHashes:Record<string,string>={}
for(const f of files){const target=join(directory,'source-snapshot',f);mkdirSync(dirname(target),{recursive:true});
  copyFileSync(f,target,constants.COPYFILE_EXCL);sourceHashes[f]=hash(readFileSync(f))}
writeFileSync(join(directory,'manifest.json'),JSON.stringify({sourceHashes,
  artifactHashes:Object.fromEntries(Object.entries(artifacts).map(([f,s])=>[f,hash(s)]))},null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({directory,caseCount:rows.length,byArm,byField,byNoise,convergence},null,2))
