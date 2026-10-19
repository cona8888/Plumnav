import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {gzipSync} from 'node:zlib'
import {cpus,totalmem} from 'node:os'
import {VerifierBridge,integrationConfig} from './lib/si-integration'
import {turnCases,type TurnSpec} from './lib/si-turn-design'
import {runTurnIntegration,replayTurnIntegration} from './lib/si-turn-integration'
import {stage1iSha256 as sha,stage1iStableJson as json} from './lib/stage1i-campaign-design'
const arg=(key:string,fallback?:string)=>{const i=process.argv.indexOf(`--${key}`);return i<0?fallback:process.argv[i+1]}
const panel=arg('panel','turn-diagnostic') as TurnSpec['panel'],cases=turnCases(panel),configs=cases.map(integrationConfig)
const output=resolve(arg('output',`research/evidence/si_${panel.replaceAll('-','_')}_2026-09-17`)!);const workerArg=arg('worker')
const writeNew=(path:string,data:string|Uint8Array)=>writeFile(path,data,{flag:'wx'})
if(workerArg!==undefined){
 const worker=Number(workerArg);if(!Number.isInteger(worker)||worker<0||worker>=4)throw Error('Invalid worker')
 const m=JSON.parse(await readFile(resolve(output,'manifest.json'),'utf8'))
 if(json(m.cases)!==json(cases)||json(m.configs)!==json(configs))throw Error('Frozen design mismatch')
 const dir=resolve(output,`worker-${worker}`);await mkdir(dir)
 const startedAt=new Date().toISOString(),start=performance.now(),inventory:any[]=[];let maxRssBytes=0
 const bridge=new VerifierBridge(),assigned=cases.filter(s=>s.index%4===worker)
 try{
  for(const s of assigned){
   const record=await runTurnIntegration(s,bridge),body=gzipSync(JSON.stringify(record)),file=`case-${String(s.index).padStart(3,'0')}.json.gz`
   await writeNew(resolve(dir,file),body);const replay=replayTurnIntegration(record)
   inventory.push({index:s.index,file,sha256:sha(body),bytes:body.length,traceRows:record.trace.length,summary:record.summary,replay});maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
   process.stdout.write(`worker ${worker}: ${inventory.length}/${assigned.length} missions complete\n`)
  }
 }finally{bridge.close()}
 await writeNew(resolve(dir,'complete.json'),json({complete:true,worker,pid:process.pid,startedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,maxRssBytes,inventory}))
}else{
 const priorRoot='research/evidence/si_encounter_scheduling_2026-09-17',priorBody=await readFile(`${priorRoot}/manifest.json`),prior=JSON.parse(priorBody.toString())
 const ab=await readFile('research/results/si_encounter_scheduling_2026-09-17/analysis.json'),analysis=JSON.parse(ab.toString()),done=JSON.parse(await readFile('research/results/si_encounter_scheduling_2026-09-17/complete.json','utf8'))
 if(!done.complete||!analysis.integrityPassed||done.analysisSha256!==sha(ab)||analysis.manifestSha256!==sha(priorBody)||analysis.performance!==null)throw Error('Preserved predecessor evidence invalid')
 for(const s of prior.sources)if(sha(await readFile(s.file))!==s.sha256)throw Error(`Old frozen source changed: ${s.file}`)
 const dev=JSON.parse(await readFile('research/evidence/si_turn_development_2026-09-17/complete.json','utf8'))
 if(!dev.complete||!dev.blankBitIdentical||dev.ordinary!==28||dev.reversals!==16)throw Error('Development preflight missing')
 let diagnosticAnalysisSha256:string|null=null
 if(panel==='turn-fresh'){
  const diagnostic='research/results/si_turn_diagnostic_2026-09-17',body=await readFile(`${diagnostic}/analysis.json`),a=JSON.parse(body.toString()),d=JSON.parse(await readFile(`${diagnostic}/complete.json`,'utf8'))
  if(!d.complete||d.analysisSha256!==sha(body)||!['integrityPassed','coupledResolutionPassed','absentControlPassed','absentBitIdentical'].every(k=>a[k]))throw Error('Diagnostic gate has not passed')
  diagnosticAnalysisSha256=sha(body)
  const dm=JSON.parse(await readFile('research/evidence/si_turn_diagnostic_2026-09-17/manifest.json','utf8'))
  for(const s of dm.sources)if(sha(await readFile(s.file))!==s.sha256)throw Error(`Frozen diagnostic source changed: ${s.file}`)
  if(json(dm.designs['turn-fresh'])!==json(cases))throw Error('Fresh design not prospectively frozen')
 }
 await mkdir(output);await mkdir(resolve(output,'source-snapshot'));const sources:any[]=[]
 const meta=JSON.parse(await readFile('outputs/stage2-turn.meta.json','utf8'))
 const files=[...prior.sources.map((s:any)=>s.file),...Object.keys(meta.inputs),'scripts/lib/si_turn_motion_audit.py','scripts/lib/si_turn_integration_audit.py','scripts/lib/si_turn_audit.py','scripts/analyze-stage2-turn.py','scripts/test-stage2-turn.ts','scripts/test-stage2-turn.py','research/protocols/si_antipodal_turn_v1_2026-09-17.md',fileURLToPath(import.meta.url)]
 for(const [i,file] of [...new Set<string>(files)].entries()){
  const data=await readFile(file),name=`${String(i).padStart(3,'0')}-${file.split('/').at(-1)}`;await writeNew(resolve(output,'source-snapshot',name),data);sources.push({file,name,sha256:sha(data)})
 }
 const manifest={schemaVersion:'si-antipodal-turn-pilot-v1',panel,createdAt:new Date().toISOString(),caseCount:cases.length,workerCount:4,cases,configs,configHashes:configs.map(c=>sha(json(c))),designs:{'turn-diagnostic':turnCases('turn-diagnostic'),'turn-fresh':turnCases('turn-fresh')},sources,preservedPriorManifestSha256:sha(priorBody),diagnosticAnalysisSha256,host:{platform:process.platform,arch:process.arch,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),node:process.version}}
 await writeNew(resolve(output,'manifest.json'),json(manifest));const launchedAt=new Date().toISOString(),start=performance.now()
 const workers=await Promise.allSettled(Array.from({length:4},(_,worker)=>new Promise((accept,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--panel',panel,'--output',output,'--worker',String(worker)],{stdio:'inherit',env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}})
  process.stdout.write(`launched worker ${worker} PID ${child.pid}\n`);child.on('error',reject);child.on('exit',(code,signal)=>code===0?accept({worker,pid:child.pid,code}):reject(Error(`worker ${worker}: code ${code}, signal ${signal}`)))
 })))
 const failures=workers.filter(r=>r.status==='rejected').map(r=>String((r as PromiseRejectedResult).reason))
 await writeNew(resolve(output,'complete.json'),json({complete:!failures.length,caseCount:cases.length,launchedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,workers,failures,manifestSha256:sha(json(manifest))}))
 if(failures.length)throw Error(failures.join('\n'))
 process.stdout.write(`COMPLETE ${cases.length} missions; ${(performance.now()-start)/1000}s\n`)
}
