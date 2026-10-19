import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {gzipSync,gunzipSync} from 'node:zlib'
import {cpus,totalmem} from 'node:os'
import {VerifierBridge,integrationConfig} from './lib/si-integration'
import {fineSchedulingCases,WITNESS_WORLDS,STUDY} from './lib/si-fine-scheduling-design'
import {runLinearIntegration,replayLinearIntegration} from './lib/si-linear-integration'
import {stage1iSha256 as sha,stage1iStableJson as json} from './lib/stage1i-campaign-design'
const arg=(key:string,fallback?:string)=>{const i=process.argv.indexOf(`--${key}`);return i<0?fallback:process.argv[i+1]}
const mode=arg('mode','preflight') as 'preflight'|'campaign',cases=fineSchedulingCases(mode),configs=cases.map(integrationConfig)
const output=resolve(`research/evidence/si_fine_scheduling_${mode}_2026-09-17`),workerArg=arg('worker')
const priorRoot='research/evidence/si_linear_fresh_2026-09-17'
const writeNew=(path:string,data:string|Uint8Array)=>writeFile(path,data,{flag:'wx'})
if(workerArg!==undefined){
 const worker=Number(workerArg);if(!Number.isInteger(worker)||worker<0||worker>=4)throw Error('Invalid worker')
 const m=JSON.parse(await readFile(resolve(output,'manifest.json'),'utf8'))
 if(json(m.cases)!==json(cases)||json(m.configs)!==json(configs))throw Error('Frozen case/config mismatch')
 const dir=resolve(output,`worker-${worker}`);await mkdir(dir)
 const startedAt=new Date().toISOString(),start=performance.now(),inventory:any[]=[];let maxRssBytes=0
 const bridge=new VerifierBridge(),assigned=cases.filter(s=>s.index%4===worker)
 try{
  for(const s of assigned){
   const caseStart=performance.now(),record=await runLinearIntegration(s,bridge),simulationSeconds=(performance.now()-caseStart)/1000
   const replay=replayLinearIntegration(record);let compatibility:any=null
   if(mode==='preflight'){
    const info=JSON.parse(await readFile(`${priorRoot}/worker-${s.index%4}/complete.json`,'utf8')),item=info.inventory.find((i:any)=>i.index===s.index)
    if(!item)throw Error('Missing accepted reference inventory')
    const referenceFile=`${priorRoot}/worker-${s.index%4}/${item.file}`,oldBytes=await readFile(referenceFile)
    if(sha(oldBytes)!==item.sha256)throw Error('Reference raw hash mismatch')
    const old=JSON.parse(gunzipSync(oldBytes).toString()),newSpec=record.spec,newRpc=record.summary.rpcMilliseconds
    record.spec=old.spec;record.summary.rpcMilliseconds=0;old.summary.rpcMilliseconds=0
    const normalizedSha256=sha(JSON.stringify(record))
    if(normalizedSha256!==sha(JSON.stringify(old)))throw Error('Full accepted reference history changed')
    record.spec=newSpec;record.summary.rpcMilliseconds=newRpc
    compatibility={passed:true,referenceFile,referenceSha256:item.sha256,normalizedSha256,excludedFields:['spec.studyId','spec.caseRole','summary.rpcMilliseconds']}
   }
   const body=gzipSync(JSON.stringify(record)),file=`case-${String(s.index).padStart(3,'0')}.json.gz`
   await writeNew(resolve(dir,file),body);maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
   inventory.push({index:s.index,file,sha256:sha(body),bytes:body.length,traceRows:record.trace.length,summary:record.summary,replay,compatibility,simulationSeconds,elapsedSeconds:(performance.now()-caseStart)/1000})
   process.stdout.write(`worker ${worker}: ${inventory.length}/${assigned.length} complete\n`)
  }
 }finally{bridge.close()}
 await writeNew(resolve(dir,'complete.json'),json({complete:true,worker,pid:process.pid,startedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,maxRssBytes,inventory}))
}else{
 const priorBytes=await readFile(`${priorRoot}/manifest.json`),prior=JSON.parse(priorBytes.toString())
 const ab=await readFile('research/results/si_linear_fresh_2026-09-17/analysis.json'),a=JSON.parse(ab.toString()),d=JSON.parse(await readFile('research/results/si_linear_fresh_2026-09-17/complete.json','utf8'))
 if(!d.complete||d.analysisSha256!==sha(ab)||a.manifestSha256!==sha(priorBytes)||!['integrityPassed','coupledResolutionPassed','absentControlPassed','absentBitIdentical'].every(k=>a[k])||a.performance!==null)throw Error('Accepted backend gate invalid')
 for(const s of prior.sources)if(sha(await readFile(s.file))!==s.sha256)throw Error(`Frozen source changed: ${s.file}`)
 let preflightAnalysisSha256:string|null=null
 if(mode==='campaign'){
  const path='research/results/si_fine_scheduling_preflight_2026-09-17',body=await readFile(`${path}/analysis.json`),pa=JSON.parse(body.toString()),pd=JSON.parse(await readFile(`${path}/complete.json`,'utf8'))
  if(!pd.complete||pd.analysisSha256!==sha(body)||!pa.integrityPassed||!pa.compatibilityPassed)throw Error('Compatibility/audit gate not passed')
  preflightAnalysisSha256=sha(body)
  const pm=JSON.parse(await readFile('research/evidence/si_fine_scheduling_preflight_2026-09-17/manifest.json','utf8'))
  if(json(pm.campaignCases)!==json(cases))throw Error('Campaign was not prospectively frozen')
  for(const s of pm.sources)if(sha(await readFile(s.file))!==s.sha256)throw Error(`Frozen preflight source changed: ${s.file}`)
 }
 await mkdir(output);await mkdir(resolve(output,'source-snapshot'));const sources:any[]=[]
 const meta=JSON.parse(await readFile('outputs/stage2-fine-scheduling.meta.json','utf8'))
 const files=[...prior.sources.map((s:any)=>s.file),...Object.keys(meta.inputs),'scripts/lib/si_fine_scheduling_statistics.py','scripts/analyze-stage2-fine-scheduling.py','scripts/test-stage2-fine-scheduling.ts','scripts/test-stage2-fine-scheduling.py','research/protocols/si_fine_scheduling_v1_2026-09-17.md',fileURLToPath(import.meta.url)]
 for(const [i,file] of [...new Set<string>(files)].entries()){
  const data=await readFile(file),name=`${String(i).padStart(3,'0')}-${file.split('/').at(-1)}`;await writeNew(resolve(output,'source-snapshot',name),data);sources.push({file,name,sha256:sha(data)})
 }
 const manifest={schemaVersion:'si-fine-scheduling-campaign-v1',studyId:STUDY,mode,createdAt:new Date().toISOString(),caseCount:cases.length,primaryCount:mode==='campaign'?192:0,workerCount:4,witnessWorlds:WITNESS_WORLDS,cases,configs,configHashes:configs.map(c=>sha(json(c))),campaignCases:fineSchedulingCases('campaign'),sources,priorManifestSha256:sha(priorBytes),priorAnalysisSha256:sha(ab),preflightAnalysisSha256,maximumWorkerSeconds:mode==='campaign'?7200:600,host:{platform:process.platform,arch:process.arch,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),node:process.version}}
 await writeNew(resolve(output,'manifest.json'),json(manifest));const launchedAt=new Date().toISOString(),start=performance.now()
 const workers=await Promise.allSettled(Array.from({length:4},(_,worker)=>new Promise((accept,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--mode',mode,'--worker',String(worker)],{stdio:'inherit',env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}})
  const timer=setTimeout(()=>child.kill('SIGTERM'),manifest.maximumWorkerSeconds*1000)
  process.stdout.write(`launched worker ${worker} PID ${child.pid}\n`)
  child.on('error',e=>{clearTimeout(timer);reject(e)})
  child.on('exit',(code,signal)=>{clearTimeout(timer);code===0?accept({worker,pid:child.pid,code}):reject(Error(`worker ${worker}: code ${code}, signal ${signal}`))})
 })))
 const failures=workers.filter(r=>r.status==='rejected').map(r=>String((r as PromiseRejectedResult).reason))
 await writeNew(resolve(output,'complete.json'),json({complete:!failures.length,caseCount:cases.length,launchedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,workers,failures,manifestSha256:sha(json(manifest))}))
 if(failures.length)throw Error(failures.join('\n'))
 process.stdout.write(`COMPLETE ${cases.length} ${mode} missions; ${(performance.now()-start)/1000}s\n`)
}
