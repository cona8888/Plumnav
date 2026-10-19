import {mkdirSync,writeFileSync,readFileSync,copyFileSync,constants} from 'node:fs'
import {resolve,join,dirname} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {runM46Case,M46_ARMS} from './lib/m46-development'
import {M41_REFERENCE,type FieldKind} from './lib/m41-development'
const output=process.argv[2];if(!output)throw new Error('Supply new output directory')
const directory=resolve(output);mkdirSync(directory,{recursive:false})
type Row=ReturnType<typeof runM46Case>&{stage:string}
const rows:Row[]=[]
for(const field of ['linear','cubic-reversal','rotating-linear','uniform','zero'] as const)
  for(const tau of [M41_REFERENCE.tau,3])for(const fieldAngle of [0,Math.PI/8])
    for(const noise of [0,.003,.01])for(const tauFactor of [.8,1,1.2])for(const rho of [0,.7])
      for(const warmStart of [false,true])for(let seed=501;seed<=504;seed++)for(const arm of M46_ARMS)
        rows.push({...runM46Case({field,tau,fieldAngle,noise,seed,dwell:12},arm,{tauFactor,rho,warmStart}),stage:'development'})
assert.equal(rows.length,11520)
const summarize=(rs:Row[])=>({rows:rs.length,accepted:rs.filter(r=>r.check.accepted).length,
  wrong:rs.filter(r=>r.check.accepted&&r.endErrorDegrees!==null&&r.endErrorDegrees>45).length,
  noGradient:rs.filter(r=>r.check.accepted&&r.endErrorDegrees===null).length})
const aggregate=(key:(r:Row)=>unknown)=>{
  const groups=new Map<string,Row[]>()
  for(const r of rows){const k=JSON.stringify(key(r)),g=groups.get(k)??[];g.push(r);groups.set(k,g)}
  return [...groups].map(([k,g])=>({key:JSON.parse(k),...summarize(g)}))
}
const byArm=aggregate(r=>({stage:r.stage,arm:r.arm}))
const byNoiseDwell=aggregate(r=>({stage:r.stage,arm:r.arm,noise:r.config.noise,warmStart:r.stress.warmStart}))
const byField=aggregate(r=>({stage:r.stage,arm:r.arm,field:r.config.field}))
const byStress=aggregate(r=>({stage:r.stage,arm:r.arm,...r.stress}))
const regimes=aggregate(r=>{const {seed,...config}=r.config;return {stage:r.stage,...config,arm:r.arm,...r.stress}})
const convergence=['linear','cubic-reversal','rotating-linear'].map(field=>({field,
  runs:[.05,.025,.0125].map(integrationStep=>{const r=runM46Case({field:field as FieldKind,tau:3,dwell:12,integrationStep},'bounded-directed');
    return {integrationStep,accepted:r.check.accepted,error:r.check.maximumError,angle:r.endErrorDegrees}})}))
const report={version:'m46-development-v1',createdAt:new Date().toISOString(),developmentOnly:true,caseCount:rows.length,
  byArm,byNoiseDwell,byField,byStress,regimes,convergence}
const artifacts={'trials.jsonl':rows.map(r=>JSON.stringify(r)).join('\n')+'\n','summary.json':JSON.stringify(report,null,2)+'\n'}
const hash=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex')
for(const [f,s]of Object.entries(artifacts))writeFileSync(join(directory,f),s,{flag:'wx'})
const files=['scripts/lib/m41-spatial-check.ts','scripts/lib/m41-development.ts','scripts/lib/gsl-dimensional-design.ts',
  'scripts/lib/m42-noise-probe.ts','scripts/lib/m43-transient-probe.ts','scripts/lib/m44-relative-check.ts',
  'scripts/lib/m45-window-development.ts','scripts/lib/m46-calibration-envelope.ts','scripts/lib/m46-development.ts',
  'scripts/m46-calibration.test.ts','scripts/m46-local-development.ts','scripts/m46-verify.ts',
  'research/protocols/m46_calibration_envelope_development.md']
const sourceHashes:Record<string,string>={}
for(const f of files){const target=join(directory,'source-snapshot',f);mkdirSync(dirname(target),{recursive:true});
  copyFileSync(f,target,constants.COPYFILE_EXCL);sourceHashes[f]=hash(readFileSync(f))}
writeFileSync(join(directory,'manifest.json'),JSON.stringify({sourceHashes,
  artifactHashes:Object.fromEntries(Object.entries(artifacts).map(([f,s])=>[f,hash(s)]))},null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({directory,caseCount:rows.length,byArm,byNoiseDwell,byStress,convergence},null,2))
