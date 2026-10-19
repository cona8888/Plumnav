import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {gzipSync} from 'node:zlib'
import {cpus,totalmem} from 'node:os'
import {runHeadInspection,headConfig} from './lib/si-head-motion'
import {scaleMemoryCases,scaleMemoryConfig,scaleMemoryGroups,baseSpec,runScaleMemoryHistory,MESHES} from './lib/si-scale-memory'
import {stage1iSha256 as sha,stage1iStableJson as json} from './lib/stage1i-campaign-design'
const arg=(key:string,fallback?:string)=>{const i=process.argv.indexOf(`--${key}`);return i<0?fallback:process.argv[i+1]}
const output=resolve(arg('output','research/evidence/si_scale_memory_pilot_2026-09-16')!),workerArg=arg('worker'),cases=scaleMemoryCases()
const configs=cases.map(scaleMemoryConfig),configHashes=configs.map(c=>sha(json(c))),writeNew=(path:string,data:string|Uint8Array)=>writeFile(path,data,{flag:'wx'})
if(workerArg!==undefined){
 const worker=Number(workerArg);if(!Number.isInteger(worker)||worker<0||worker>=4)throw Error('Invalid worker')
 const m=JSON.parse(await readFile(resolve(output,'manifest.json'),'utf8'))
 if(json(m.cases)!==json(cases)||json(m.configHashes)!==json(configHashes))throw Error('Frozen configuration mismatch')
 const dir=resolve(output,`worker-${worker}`);await mkdir(dir)
 const startedAt=new Date().toISOString(),start=performance.now(),inventory:any[]=[];let maxRssBytes=0
 for(const s of cases.filter(s=>s.index%4===worker)){
  const base=runHeadInspection(baseSpec(s)),body=gzipSync(JSON.stringify(base)),file=`base-${String(s.index).padStart(3,'0')}.json.gz`
  await writeNew(resolve(dir,file),body);const item:any={index:s.index,file,sha256:sha(body),bytes:body.length,histories:[]}
  for(const dt of MESHES){
   const history=runScaleMemoryHistory(base,s,dt),content=gzipSync(JSON.stringify(history)),name=`case-${String(s.index).padStart(3,'0')}-dt-${dt}.json.gz`
   await writeNew(resolve(dir,name),content);item.histories.push({referenceDt:dt,file:name,sha256:sha(content),bytes:content.length,traceRows:history.trace.length});maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
  }
  inventory.push(item);process.stdout.write(`worker ${worker}: ${inventory.length}/16 settings (${inventory.length*3}/48 histories)\n`)
 }
 await writeNew(resolve(dir,'complete.json'),json({complete:true,worker,pid:process.pid,startedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,maxRssBytes,inventory}))
}else{
 await mkdir(output);await mkdir(resolve(output,'source-snapshot'));const sources:any[]=[]
 const prior=JSON.parse(await readFile('research/evidence/si_fine_resolution_pilot_2026-09-16/manifest.json','utf8'))
 for(const s of prior.sources)if(sha(await readFile(s.file))!==s.sha256)throw Error(`Prior frozen source changed: ${s.file}`)
 const files=[...prior.sources.map((s:any)=>s.file),'scripts/lib/si_stationary_head_contract.py','scripts/test-stationary-head-contract.py','scripts/lib/si-scale-memory.ts','scripts/stage2-scale-memory.ts','scripts/analyze-stage2-scale-memory.py','scripts/test-stage2-scale-memory.ts','scripts/test-stage2-scale-memory.py','research/protocols/si_scale_memory_v1_2026-09-16.md',fileURLToPath(import.meta.url)]
 for(const file of [...new Set<string>(files)]){const body=await readFile(file),name=basename(file);await writeNew(resolve(output,'source-snapshot',name),body);sources.push({file,name,sha256:sha(body)})}
 const m={schemaVersion:'si-scale-memory-pilot-v1',createdAt:new Date().toISOString(),caseCount:64,historyCount:192,workerCount:4,cases,configs,configHashes,baseConfigs:cases.map(s=>headConfig(baseSpec(s))),groups:cases.map((s,i)=>scaleMemoryGroups(configs[i]!,s)),sources,referenceMeshes:MESHES,reportingSeedBase:1800101,host:{platform:process.platform,arch:process.arch,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),node:process.version}}
 await writeNew(resolve(output,'manifest.json'),json(m));const launchedAt=new Date().toISOString(),start=performance.now()
 const workers=await Promise.allSettled(Array.from({length:4},(_,worker)=>new Promise((accept,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--output',output,'--worker',String(worker)],{stdio:'inherit',env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}})
  process.stdout.write(`launched worker ${worker} PID ${child.pid}\n`);child.on('error',reject);child.on('exit',(code,signal)=>code===0?accept({worker,pid:child.pid,code}):reject(Error(`worker ${worker}: code ${code}, signal ${signal}`)))
 })))
 const failures=workers.filter(r=>r.status==='rejected').map(r=>String((r as PromiseRejectedResult).reason))
 await writeNew(resolve(output,'complete.json'),json({complete:!failures.length,caseCount:64,historyCount:192,launchedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,workers,failures,manifestSha256:sha(json(m))}))
 if(failures.length)throw Error(failures.join('\n'));process.stdout.write(`COMPLETE 64 settings, 192 response histories; ${(performance.now()-start)/1000}s\n`)
}
