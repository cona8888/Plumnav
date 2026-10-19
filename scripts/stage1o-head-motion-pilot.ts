import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {gzipSync} from 'node:zlib'
import {cpus,totalmem} from 'node:os'
import {headCases,headConfig,HEAD_MODES,runHeadInspection,refineHeadHistory} from './lib/si-head-motion'
import {stage1iSha256 as sha,stage1iStableJson as json} from './lib/stage1i-campaign-design'

const arg=(key:string,fallback?:string)=>{const i=process.argv.indexOf(`--${key}`);return i<0?fallback:process.argv[i+1]}
const output=resolve(arg('output','research/evidence/si_head_motion_pilot_2026-09-16')!),workerArg=arg('worker'),workerCount=4
const cases=headCases(),configs=cases.map(headConfig),configHashes=configs.map(c=>sha(json(c)))
const owner=(i:number)=>(i+Math.floor(i/24))%4
const refine=(s:typeof cases[number])=>s.replicate===0&&[3,5].includes(s.mode)&&(['peak','ridge','si-continuous'].includes(s.field)||(s.field==='si-pulse'&&s.phaseSeconds===5))
const writeNew=(path:string,data:string|Uint8Array)=>writeFile(path,data,{flag:'wx'})
if(workerArg!==undefined){
 const worker=Number(workerArg);if(!Number.isInteger(worker)||worker<0||worker>=workerCount)throw Error('Invalid worker')
 const manifest=JSON.parse(await readFile(resolve(output,'manifest.json'),'utf8'))
 if(json(manifest.cases)!==json(cases)||json(manifest.configHashes)!==json(configHashes))throw Error('Design mismatch')
 const dir=resolve(output,`worker-${worker}`);await mkdir(dir)
 const startedAt=new Date().toISOString(),start=performance.now(),inventory:any[]=[];let maxRssBytes=0,references=0,refinements=0
 for(const spec of cases.filter(s=>owner(s.index)===worker)){
  const record=runHeadInspection(spec)
  let zeroMotionReference:any=null
  if(spec.mode===0){
   const reference=runHeadInspection(spec,true)
   for(const key of ['visits','actualSamples','result','summary'] as const)if(json(record[key])!==json(reference[key]))throw Error(`Zero-motion mismatch ${spec.index}: ${key}`)
   const {trace:_,...retainedReference}=reference;zeroMotionReference=retainedReference;references++
  }
  const refined=refine(spec)?[.03125,.015625].map(dt=>refineHeadHistory(record,dt)):[];refinements+=refined.length
  const body=gzipSync(Buffer.from(JSON.stringify({...record,zeroMotionReference,refinements:refined})),{level:6}),file=`run-${String(spec.index).padStart(4,'0')}.json.gz`
  await writeNew(resolve(dir,file),body);inventory.push({index:spec.index,file,sha256:sha(body),bytes:body.length})
  maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
  if(inventory.length%8===0)process.stdout.write(`worker ${worker}: ${inventory.length}/48\n`)
 }
 await writeNew(resolve(dir,'complete.json'),json({complete:true,worker,pid:process.pid,startedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,maxRssBytes,unwrappedReferences:references,prescribedPathRefinements:refinements,inventory}))
}else{
 await mkdir(output);await mkdir(resolve(output,'source-snapshot'));const sources:any[]=[]
 for(const file of ['research/protocols/si_head_motion_v1_2026-09-16.md','scripts/lib/si-head-motion.ts','scripts/stage1o-head-motion-pilot.ts','scripts/analyze-stage1o.py','scripts/lib/si_head_motion_audit.py','scripts/lib/si_v4_decision_audit.py','scripts/test-stage1o-head-motion.ts','scripts/test-stage1o-audit.py','scripts/lib/si_bounded_pose.py','scripts/lib/si_bounded_pose_v4.py','scripts/lib/si_reported_pose.py','scripts/lib/si_pose_temporal.py','scripts/lib/si_stationary_dwell.py','scripts/analyze-stage1k.py','scripts/audit-stage1i-decisions.py','scripts/audit-stage1n-candidate.py','scripts/lib/si-clocked-integrity-probe.ts','scripts/lib/si-pose-uncertainty-probe.ts','scripts/lib/stage1i-campaign-design.ts','src/sim/engine.ts','src/sim/localInletSampling.ts','src/sim/physicalAtmosphere.ts','src/sim/halfspaceTransport.ts',fileURLToPath(import.meta.url)]){
  const body=await readFile(file),name=basename(file);await writeNew(resolve(output,'source-snapshot',name),body);sources.push({file,name,sha256:sha(body)})
 }
 const manifest={schemaVersion:'si-head-motion-pilot-v1',createdAt:new Date().toISOString(),caseCount:192,cases,modes:HEAD_MODES,configs,configHashes,sources,workerCount,unwrappedReferences:32,prescribedPathRefinements:16,host:{platform:process.platform,arch:process.arch,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),node:process.version}}
 await writeNew(resolve(output,'manifest.json'),json(manifest));const launchedAt=new Date().toISOString(),start=performance.now()
 const results=await Promise.allSettled(Array.from({length:workerCount},(_,worker)=>new Promise((accept,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--output',output,'--worker',String(worker)],{stdio:'inherit',env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}})
  process.stdout.write(`launched worker ${worker} PID ${child.pid}\n`);child.on('error',reject)
  child.on('exit',(code,signal)=>code===0?accept({worker,pid:child.pid,code}):reject(Error(`worker ${worker}: code ${code}, signal ${signal}`)))
 })))
 const failures=results.filter(r=>r.status==='rejected').map(r=>String((r as PromiseRejectedResult).reason))
 await writeNew(resolve(output,'complete.json'),json({complete:failures.length===0,caseCount:192,launchedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,workers:results,failures,manifestSha256:sha(json(manifest))}))
 if(failures.length)throw Error(failures.join('\n'))
 process.stdout.write(`COMPLETE 192 primary + 32 reference inspections and 16 path refinements; ${(performance.now()-start)/1000}s\n`)
}
