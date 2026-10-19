import {mkdirSync,writeFileSync,readFileSync,copyFileSync,constants} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {runM47Case,M47_ARMS,type M47Case} from './lib/m47-development'
const output=process.argv[2];if(!output)throw new Error('Supply new output directory')
const dir=resolve(output);mkdirSync(dir,{recursive:false})
type Row=ReturnType<typeof runM47Case>
const rows:Row[]=[]
for(const kind of ['steady-release','interrupted-release','absent'] as const)for(const [x,y] of [[.2,0],[.6,0],[.6,.15]])
  for(const wind of [.02,.05])for(const noise of [0,.003])for(const warmStart of [false,true])
    for(const rho of [0,.7])for(const seed of [601,602])for(const arm of M47_ARMS)
      rows.push(runM47Case({kind,x:x!,y:y!,wind,diffusivity:.0005,noise,warmStart,rho,seed},arm))
assert.equal(rows.length,1152)
const summarize=(rs:Row[])=>{
  const a=rs.filter(r=>r.check.accepted)
  return {rows:rs.length,accepted:a.length,abstained:rs.length-a.length,
    gradientWrong:a.filter(r=>r.endErrorDegrees!==null&&r.endErrorDegrees>45).length,
    gradientUndefined:a.filter(r=>r.endErrorDegrees===null).length,
    sourceBearingWrong:a.filter(r=>r.sourceBearingError!==null&&r.sourceBearingError>45).length,
    sourceBearingUndefined:a.filter(r=>r.sourceBearingError===null).length}
}
const aggregate=(key:(r:Row)=>unknown)=>{
  const groups=new Map<string,Row[]>()
  for(const r of rows){const k=JSON.stringify(key(r)),g=groups.get(k)??[];g.push(r);groups.set(k,g)}
  return [...groups].map(([k,g])=>({key:JSON.parse(k),...summarize(g)}))
}
const byArm=aggregate(r=>({arm:r.arm})),byKind=aggregate(r=>({arm:r.arm,kind:r.case.kind})),
  byNoise=aggregate(r=>({arm:r.arm,noise:r.case.noise,rho:r.case.rho})),
  regimes=aggregate(r=>{const {seed,...c}=r.case;return {arm:r.arm,...c}})
const refinement=['steady-release','interrupted-release'].flatMap(kind=>M47_ARMS.map(arm=>({kind,arm,
  runs:[{integrationStep:.05,releaseStep:1},{integrationStep:.025,releaseStep:1},{integrationStep:.0125,releaseStep:1},
    {integrationStep:.025,releaseStep:.5},{integrationStep:.025,releaseStep:.25}].map(steps=>{
    const r=runM47Case({kind:kind as M47Case['kind'],x:.6,y:.15,wind:.02,diffusivity:.0005,noise:0,
      warmStart:false,rho:0,seed:601,...steps},arm)
    return {...steps,accepted:r.check.accepted,gradientError:r.endErrorDegrees,sourceError:r.sourceBearingError,
      concentration:r.finalConcentration}})})))
const summary={version:'m47-transport-pilot-v1',createdAt:new Date().toISOString(),caseCount:rows.length,
  byArm,byKind,byNoise,regimes,refinement,scope:'Analytical infinite-plane transport transfer, not full GSL or physical validation'}
const artifacts={'trials.jsonl':rows.map(r=>JSON.stringify(r)).join('\n')+'\n','summary.json':JSON.stringify(summary,null,2)+'\n'}
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex')
for(const [f,v]of Object.entries(artifacts))writeFileSync(join(dir,f),v,{flag:'wx'})
const files=['scripts/lib/m41-development.ts','scripts/lib/m41-spatial-check.ts','scripts/lib/gsl-dimensional-design.ts',
  'scripts/lib/m42-noise-probe.ts','scripts/lib/m43-transient-probe.ts','scripts/lib/m44-relative-check.ts',
  'scripts/lib/m45-window-development.ts','scripts/lib/m46-calibration-envelope.ts','scripts/lib/m47-transport.ts',
  'scripts/lib/m47-development.ts','scripts/m47-transport.test.ts','scripts/m47-local-pilot.ts','scripts/m47-verify.ts',
  'research/protocols/m47_transport_transfer_pilot.md']
const sourceHashes:Record<string,string>={}
for(const f of files){const target=join(dir,'source-snapshot',f);mkdirSync(dirname(target),{recursive:true});
  copyFileSync(f,target,constants.COPYFILE_EXCL);sourceHashes[f]=hash(readFileSync(f))}
writeFileSync(join(dir,'manifest.json'),JSON.stringify({sourceHashes,
  artifactHashes:Object.fromEntries(Object.entries(artifacts).map(([f,v])=>[f,hash(v)]))},null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({caseCount:rows.length,byArm,byKind,byNoise,refinement},null,2))
