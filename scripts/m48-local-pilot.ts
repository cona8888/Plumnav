import {mkdirSync,writeFileSync,readFileSync,copyFileSync,constants} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {runM48Mission,M48_ARMS} from './lib/m48-mission'
const output=process.argv[2];if(!output)throw new Error('Supply new output directory')
const dir=resolve(output);mkdirSync(dir,{recursive:false})
type Row=ReturnType<typeof runM48Mission>
const rows:Row[]=[]
for(const kind of ['steady-release','interrupted-release','absent'] as const)for(const y of [0,.15])
  for(const noise of [0,.003])for(const seed of [701,702])for(const arm of M48_ARMS)
    rows.push(runM48Mission({kind,start:{x:.6,y},noise,seed},arm))
assert.equal(rows.length,72)
const summarize=(rs:Row[])=>({missions:rs.length,successes:rs.filter(r=>r.success).length,
  declarations:rs.filter(r=>r.declared).length,falseDeclarations:rs.filter(r=>r.falseDeclaration).length,
  stoppedSourceDeclarations:rs.filter(r=>r.stoppedSourceDeclaration).length,
  meanTime:rs.reduce((s,r)=>s+r.elapsedSeconds,0)/rs.length,
  meanDistance:rs.reduce((s,r)=>s+r.distanceMetres,0)/rs.length,
  cueAccepted:rs.reduce((s,r)=>s+r.trace.filter(t=>t.cueAccepted).length,0),
  cueChecks:rs.reduce((s,r)=>s+r.trace.length,0),
  plumeContacts:rs.reduce((s,r)=>s+r.plumeContacts,0)})
const byArm=Object.fromEntries(M48_ARMS.map(a=>[a,summarize(rows.filter(r=>r.arm===a))]))
const byKind=Object.fromEntries(['steady-release','interrupted-release','absent'].map(k=>[k,
  Object.fromEntries(M48_ARMS.map(a=>[a,summarize(rows.filter(r=>r.arm===a&&r.case.kind===k))]))]))
const refinement=M48_ARMS.map(arm=>({arm,runs:[{integrationStep:.1,releaseStep:1},
  {integrationStep:.05,releaseStep:1},{integrationStep:.05,releaseStep:.5}].map(steps=>{
  const r=runM48Mission({kind:'steady-release',start:{x:.6,y:.15},noise:0,seed:701,...steps},arm)
  return {...steps,success:r.success,declared:r.declared,error:r.localizationError,time:r.elapsedSeconds,distance:r.distanceMetres}})}))
const report={version:'m48-trajectory-pilot-v1',createdAt:new Date().toISOString(),caseCount:rows.length,byArm,byKind,refinement,
  scope:'Controlled navigation heuristic pilot, not established-algorithm or outdoor validation'}
const artifacts={'missions.jsonl':rows.map(r=>JSON.stringify(r)).join('\n')+'\n','summary.json':JSON.stringify(report,null,2)+'\n'}
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex')
for(const [f,v]of Object.entries(artifacts))writeFileSync(join(dir,f),v,{flag:'wx'})
const files=['scripts/lib/m41-spatial-check.ts','scripts/lib/m41-development.ts','scripts/lib/gsl-dimensional-design.ts',
  'scripts/lib/m42-noise-probe.ts','scripts/lib/m43-transient-probe.ts','scripts/lib/m44-relative-check.ts',
  'scripts/lib/m47-transport.ts','scripts/lib/m48-mission.ts','scripts/m48-mission.test.ts','scripts/m48-local-pilot.ts',
  'scripts/m48-verify.ts','research/protocols/m48_trajectory_pilot.md']
const sourceHashes:Record<string,string>={}
for(const f of files){const target=join(dir,'source-snapshot',f);mkdirSync(dirname(target),{recursive:true});
  copyFileSync(f,target,constants.COPYFILE_EXCL);sourceHashes[f]=hash(readFileSync(f))}
writeFileSync(join(dir,'manifest.json'),JSON.stringify({sourceHashes,
  artifactHashes:Object.fromEntries(Object.entries(artifacts).map(([f,v])=>[f,hash(v)]))},null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({byArm,byKind,refinement},null,2))
