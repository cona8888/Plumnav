import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {gzipSync} from 'node:zlib'
import {cpus,totalmem} from 'node:os'
import {integrationCases,integrationConfig,runIntegration,replayIntegration,VerifierBridge} from './lib/si-integration'
import {stage1iSha256 as sha,stage1iStableJson as json} from './lib/stage1i-campaign-design'
const arg=(key:string,fallback?:string)=>{const i=process.argv.indexOf(`--${key}`);return i<0?fallback:process.argv[i+1]}
const output=resolve(arg('output','research/evidence/si_acquisition_integration_pilot_2026-09-16')!),workerArg=arg('worker'),cases=integrationCases(),configs=cases.map(integrationConfig)
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
   const record=await runIntegration(s,bridge),body=gzipSync(JSON.stringify(record)),file=`case-${String(s.index).padStart(3,'0')}.json.gz`
   await writeNew(resolve(dir,file),body)
   const replay=replayIntegration(record)
   inventory.push({index:s.index,file,sha256:sha(body),bytes:body.length,traceRows:record.trace.length,summary:record.summary,replay});maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
   process.stdout.write(`worker ${worker}: ${inventory.length}/9 missions, case ${s.index}, ${record.summary.stage}\n`)
  }
 }finally{bridge.close()}
 await writeNew(resolve(dir,'complete.json'),json({complete:true,worker,pid:process.pid,startedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,maxRssBytes,inventory}))
}else{
 await mkdir(output);await mkdir(resolve(output,'source-snapshot'));const sources:any[]=[]
 const prior=JSON.parse(await readFile('research/evidence/si_scale_memory_pilot_2026-09-16/manifest.json','utf8'))
 for(const s of prior.sources)if(sha(await readFile(s.file))!==s.sha256)throw Error(`Prior frozen source changed: ${s.file}`)
 const meta=JSON.parse(await readFile('outputs/stage2-integration.meta.json','utf8'))
 const files=[...prior.sources.map((s:any)=>s.file),...Object.keys(meta.inputs),'scripts/si-integration-bridge.py','scripts/lib/si_integration_audit.py','scripts/analyze-stage2-integration.py','scripts/test-stage2-integration.ts','scripts/test-stage2-integration.py','research/protocols/si_acquisition_integration_v1_2026-09-16.md',fileURLToPath(import.meta.url)]
 for(const [i,file] of [...new Set<string>(files)].entries()){
  const body=await readFile(file),name=`${String(i).padStart(3,'0')}-${file.split('/').at(-1)}`;await writeNew(resolve(output,'source-snapshot',name),body);sources.push({file,name,sha256:sha(body)})
 }
 const manifest={schemaVersion:'si-acquisition-integration-pilot-v1',createdAt:new Date().toISOString(),caseCount:36,primaryCount:18,workerCount:4,cases,configs,configHashes:configs.map(c=>sha(json(c))),sources,host:{platform:process.platform,arch:process.arch,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),node:process.version}}
 await writeNew(resolve(output,'manifest.json'),json(manifest));const launchedAt=new Date().toISOString(),start=performance.now()
 const workers=await Promise.allSettled(Array.from({length:4},(_,worker)=>new Promise((accept,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--output',output,'--worker',String(worker)],{stdio:'inherit',env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}})
  process.stdout.write(`launched worker ${worker} PID ${child.pid}\n`);child.on('error',reject);child.on('exit',(code,signal)=>code===0?accept({worker,pid:child.pid,code}):reject(Error(`worker ${worker}: code ${code}, signal ${signal}`)))
 })))
 const failures=workers.filter(r=>r.status==='rejected').map(r=>String((r as PromiseRejectedResult).reason))
 await writeNew(resolve(output,'complete.json'),json({complete:!failures.length,caseCount:36,launchedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,workers,failures,manifestSha256:sha(json(manifest))}))
 if(failures.length)throw Error(failures.join('\n'))
 process.stdout.write(`COMPLETE 36 missions; ${(performance.now()-start)/1000}s\n`)
}
