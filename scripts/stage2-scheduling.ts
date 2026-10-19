import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {gzipSync} from 'node:zlib'
import {cpus,totalmem} from 'node:os'
import {VerifierBridge} from './lib/si-integration'
import {schedulingCases,schedulingConfig} from './lib/si-scheduling-design'
import {runScheduling,replayScheduling} from './lib/si-scheduling-integration'
import {stage1iSha256 as sha,stage1iStableJson as json} from './lib/stage1i-campaign-design'
const arg=(key:string,fallback?:string)=>{const i=process.argv.indexOf(`--${key}`);return i<0?fallback:process.argv[i+1]}
const output=resolve(arg('output','research/evidence/si_encounter_scheduling_2026-09-17')!),workerArg=arg('worker'),cases=schedulingCases(),configs=cases.map(schedulingConfig)
const writeNew=(path:string,data:string|Uint8Array)=>writeFile(path,data,{flag:'wx'})
if(workerArg!==undefined){
 const worker=Number(workerArg);if(!Number.isInteger(worker)||worker<0||worker>=4)throw Error('Invalid worker')
 const m=JSON.parse(await readFile(resolve(output,'manifest.json'),'utf8'))
 if(json(m.cases)!==json(cases)||json(m.configs)!==json(configs))throw Error('Frozen design mismatch')
 const dir=resolve(output,`worker-${worker}`);await mkdir(dir)
 const startedAt=new Date().toISOString(),start=performance.now(),inventory:any[]=[];let maxRssBytes=0
 const bridge=new VerifierBridge()
 try{
  for(const s of cases.filter(s=>s.index%4===worker)){
   const record=await runScheduling(s,bridge),body=gzipSync(JSON.stringify(record)),file=`case-${String(s.index).padStart(3,'0')}.json.gz`
   await writeNew(resolve(dir,file),body);const replay=replayScheduling(record)
   inventory.push({index:s.index,file,sha256:sha(body),bytes:body.length,traceRows:record.trace.length,summary:record.summary,replay});maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
   if(inventory.length%5===0)process.stdout.write(`worker ${worker}: ${inventory.length}/60 missions complete\n`)
  }
 }finally{bridge.close()}
 await writeNew(resolve(dir,'complete.json'),json({complete:true,worker,pid:process.pid,startedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,maxRssBytes,inventory}))
}else{
 const acceptedRoot='research/results/si_event_fresh_audit_v2_2026-09-16',priorRoot='research/evidence/si_event_fresh_v2_2026-09-16'
 const body=await readFile(`${acceptedRoot}/analysis.json`),accepted=JSON.parse(body.toString()),done=JSON.parse(await readFile(`${acceptedRoot}/complete.json`,'utf8'))
 if(!done.complete||done.analysisSha256!==sha(body)||!['integrityPassed','coupledResolutionPassed','absentControlPassed','absentBitIdentical'].every(k=>accepted[k]))throw Error('Prior acceptance invalid')
 const priorBody=await readFile(`${priorRoot}/manifest.json`),prior=JSON.parse(priorBody.toString())
 if(sha(priorBody)!==accepted.manifestSha256)throw Error('Prior manifest mismatch')
 for(const s of [...prior.sources,...accepted.auditSources])if(sha(await readFile(s.file))!==s.sha256)throw Error(`Prior frozen source changed: ${s.file}`)
 const dev=JSON.parse(await readFile('research/evidence/si_scheduling_development_v2_2026-09-17/complete.json','utf8'))
 if(!dev.complete||dev.referenceEquivalent!==3||!dev.blankBitIdentical)throw Error('Development preflight missing')
 await mkdir(output);await mkdir(resolve(output,'source-snapshot'));const sources:any[]=[]
 const meta=JSON.parse(await readFile('outputs/stage2-scheduling.meta.json','utf8'))
 const files=[...prior.sources.map((s:any)=>s.file),...Object.keys(meta.inputs),'scripts/lib/si_scheduling_audit.py','scripts/lib/si_scheduling_statistics.py','scripts/analyze-stage2-scheduling.py','scripts/test-stage2-scheduling.ts','scripts/test-stage2-scheduling.py','research/protocols/si_encounter_scheduling_v1_2026-09-17.md',fileURLToPath(import.meta.url)]
 for(const [i,file] of [...new Set<string>(files)].entries()){
  const data=await readFile(file),name=`${String(i).padStart(3,'0')}-${file.split('/').at(-1)}`;await writeNew(resolve(output,'source-snapshot',name),data);sources.push({file,name,sha256:sha(data)})
 }
 const manifest={schemaVersion:'si-encounter-scheduling-pilot-v1',createdAt:new Date().toISOString(),caseCount:240,primaryCount:192,independentWorlds:16,workerCount:4,cases,configs,configHashes:configs.map(c=>sha(json(c))),sources,prerequisiteAnalysisSha256:sha(body),host:{platform:process.platform,arch:process.arch,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),node:process.version}}
 await writeNew(resolve(output,'manifest.json'),json(manifest));const launchedAt=new Date().toISOString(),start=performance.now()
 const workers=await Promise.allSettled(Array.from({length:4},(_,worker)=>new Promise((accept,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--output',output,'--worker',String(worker)],{stdio:'inherit',env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}})
  process.stdout.write(`launched worker ${worker} PID ${child.pid}\n`);child.on('error',reject);child.on('exit',(code,signal)=>code===0?accept({worker,pid:child.pid,code}):reject(Error(`worker ${worker}: code ${code}, signal ${signal}`)))
 })))
 const failures=workers.filter(r=>r.status==='rejected').map(r=>String((r as PromiseRejectedResult).reason))
 await writeNew(resolve(output,'complete.json'),json({complete:!failures.length,caseCount:240,launchedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,workers,failures,manifestSha256:sha(json(manifest))}))
 if(failures.length)throw Error(failures.join('\n'))
 process.stdout.write(`COMPLETE 240 missions; ${(performance.now()-start)/1000}s\n`)
}
