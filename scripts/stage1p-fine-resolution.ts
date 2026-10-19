import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {gzipSync} from 'node:zlib'
import {cpus,totalmem} from 'node:os'
import {headConfig,runHeadInspection,refineHeadHistory,type HeadSpec} from './lib/si-head-motion'
import {stage1iSha256 as sha,stage1iStableJson as json} from './lib/stage1i-campaign-design'

const cases:HeadSpec[]=[]
for(const field of ['peak','ridge','si-continuous','si-pulse'] as const)for(const mode of [3,5])for(let replicate=0;replicate<4;replicate++)
 cases.push({index:cases.length,field,phaseSeconds:field==='si-pulse'?5:0,radiusMetres:.05,response:'nominal',noiseC0:.001,replicate,seed:970101+replicate,worldSeed:101301+replicate,panel:'head-motion',mode})
const meshes=[1/64,1/128,1/256],configs=cases.map(headConfig),configHashes=configs.map(c=>sha(json(c)))
const arg=(key:string,fallback?:string)=>{const i=process.argv.indexOf(`--${key}`);return i<0?fallback:process.argv[i+1]}
const output=resolve(arg('output','research/evidence/si_fine_resolution_pilot_2026-09-16')!),workerArg=arg('worker')
const writeNew=(path:string,data:string|Uint8Array)=>writeFile(path,data,{flag:'wx'})
if(workerArg!==undefined){
 const worker=Number(workerArg);if(!Number.isInteger(worker)||worker<0||worker>=4)throw Error('Invalid worker')
 const m=JSON.parse(await readFile(resolve(output,'manifest.json'),'utf8'))
 if(json(m.cases)!==json(cases)||json(m.configHashes)!==json(configHashes)||json(m.meshes)!==json(meshes))throw Error('Design mismatch')
 const dir=resolve(output,`worker-${worker}`);await mkdir(dir)
 const startedAt=new Date().toISOString(),start=performance.now(),inventory:any[]=[];let maxRssBytes=0
 for(const spec of cases.filter(s=>s.index%4===worker)){
  const record=runHeadInspection(spec),file=`run-${String(spec.index).padStart(3,'0')}.json.gz`,body=gzipSync(JSON.stringify(record))
  await writeNew(resolve(dir,file),body)
  const entry:any={index:spec.index,file,sha256:sha(body),bytes:body.length,refinements:[]}
  for(const dt of meshes){
   const fine=refineHeadHistory(record,dt),name=`run-${String(spec.index).padStart(3,'0')}-dt-${dt}.json.gz`,b=gzipSync(JSON.stringify(fine))
   await writeNew(resolve(dir,name),b);entry.refinements.push({dt,file:name,sha256:sha(b),bytes:b.length,traceRows:fine.trace.length})
   maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
  }
  inventory.push(entry);process.stdout.write(`worker ${worker}: ${inventory.length}/8 paths, ${inventory.length*3}/24 replays\n`)
 }
 await writeNew(resolve(dir,'complete.json'),json({complete:true,worker,pid:process.pid,startedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,maxRssBytes,inventory}))
}else{
 await mkdir(output);await mkdir(resolve(output,'source-snapshot'));const sources:any[]=[]
 const prior=JSON.parse(await readFile('research/evidence/si_head_motion_pilot_2026-09-16/manifest.json','utf8'))
 for(const s of prior.sources)if(sha(await readFile(s.file))!==s.sha256)throw Error(`Frozen Stage 1o source changed: ${s.file}`)
 const sourceFiles=[...prior.sources.map((s:any)=>s.file),'scripts/analyze-stage1o.py','research/protocols/si_fine_resolution_v1_2026-09-16.md','scripts/stage1p-fine-resolution.ts','scripts/analyze-stage1p.py','scripts/test-stage1p.py',fileURLToPath(import.meta.url)]
 for(const file of [...new Set<string>(sourceFiles)]){
  const body=await readFile(file),name=basename(file);await writeNew(resolve(output,'source-snapshot',name),body);sources.push({file,name,sha256:sha(body)})
 }
 const manifest={schemaVersion:'si-fine-resolution-pilot-v1',createdAt:new Date().toISOString(),caseCount:32,replayCount:96,workerCount:4,cases,meshes,configs,configHashes,sources,reportingSeedBase:1700101,previousStageManifestSha256:sha(await readFile('research/evidence/si_head_motion_pilot_2026-09-16/manifest.json')),host:{platform:process.platform,arch:process.arch,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),node:process.version}}
 await writeNew(resolve(output,'manifest.json'),json(manifest));const launchedAt=new Date().toISOString(),start=performance.now()
 const workers=await Promise.allSettled(Array.from({length:4},(_,worker)=>new Promise((accept,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--output',output,'--worker',String(worker)],{stdio:'inherit',env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}})
  process.stdout.write(`launched worker ${worker} PID ${child.pid}\n`);child.on('error',reject)
  child.on('exit',(code,signal)=>code===0?accept({worker,pid:child.pid,code}):reject(Error(`worker ${worker}: code ${code}, signal ${signal}`)))
 })))
 const failures=workers.filter(r=>r.status==='rejected').map(r=>String((r as PromiseRejectedResult).reason))
 await writeNew(resolve(output,'complete.json'),json({complete:!failures.length,caseCount:32,replayCount:96,launchedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,workers,failures,manifestSha256:sha(json(manifest))}))
 if(failures.length)throw Error(failures.join('\n'))
 process.stdout.write(`COMPLETE 32 fresh paths + 96 prescribed-path refinements; ${(performance.now()-start)/1000}s\n`)
}
