import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {resolve, basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {gzipSync} from 'node:zlib'
import {cpus, totalmem} from 'node:os'
import {SimulationEngine} from '../src/sim/engine'
import {SIPoseUncertaintyProbe} from './lib/si-pose-uncertainty-probe'
import {buildStage1iConfig, STAGE1I_FIELDS, stage1iSha256 as sha, stage1iStableJson as json, type Stage1iField} from './lib/stage1i-campaign-design'

const arg=(key:string,fallback?:string)=>{const i=process.argv.indexOf(`--${key}`);return i<0?fallback:process.argv[i+1]}
const output=resolve(arg('output','research/evidence/si_pose_aware_temporal_pilot_2026-09-16')!)
const workerArg=arg('worker'),workerCount=4
type Spec={index:number;field:Stage1iField;radiusMetres:number;geometry:'independent'|'common-centre-target';seed:number;kind:'baseline'|'position'}
const cases:Spec[]=STAGE1I_FIELDS.map((field,index)=>({index,field,radiusMetres:0,geometry:'independent',seed:810101,kind:'baseline'}))
for(const seed of [810101,810102,810103,810104])for(const radiusMetres of [.03,.05])for(const geometry of ['independent','common-centre-target'] as const)for(const field of STAGE1I_FIELDS)cases.push({index:cases.length,field,radiusMetres,geometry,seed,kind:'position'})
if(cases.length!==187)throw Error('Wrong case design')
const configs=Object.fromEntries(STAGE1I_FIELDS.map(field=>[field,buildStage1iConfig(field)]))
const configHashes=Object.fromEntries(Object.entries(configs).map(([field,config])=>[field,sha(json(config))]))
const writeNew=(path:string,data:string|Uint8Array)=>writeFile(path,data,{flag:'wx'})

function synthetic(field:Stage1iField,p:{x:number;y:number},domain:number){
 const x=(p.x-.5)*domain,y=(p.y-.5)*domain,r=Math.hypot(x,y)
 switch(field){case'peak':return .01+Math.exp(-(r*r)/(2*.3**2));case'offset-peak':return .01+Math.exp(-((x-.03)**2+(y+.02)**2)/(2*.3**2));case'ridge':return .01+Math.exp(-(x*x)/(2*.3**2));case'saddle':return Math.max(0,1-(x*x+y*y)/(2*.3**2)+2*x*y/.3**2);case'plateau':return r<=.3?1:.01+.99*Math.exp(-((r-.3)**2)/(2*.3**2));case'uniform':return 1;case'blank':return 0;case'clipped-peak':return 3*Math.exp(-(r*r)/(2*.3**2));default:throw Error('Not a synthetic field')}
}

function run(spec:Spec){
 const config=configs[spec.field]!,engine=new SimulationEngine(config),candidate=config.robotStartPositionOverride!
 const uncertainty={positionRadiusMetres:spec.radiusMetres,headingBoundRadians:0,registration:'observed' as const,perturbationSeed:spec.seed,positionErrorStructure:'independent' as const}
 const probe=new SIPoseUncertaintyProbe({...engine.environment,sensorNoise:.001},candidate,config.domainMeters,uncertainty)
 if(spec.geometry==='common-centre-target')for(let i=2;i<17;i+=2){
  probe.positionOffsetsMetres[i]={...probe.positionOffsetsMetres[0]!}
  probe.actualTargets[i]={...probe.actualTargets[0]!}
  probe.visits[i]!.target={...probe.actualTargets[0]!}
 }
 if(!spec.field.startsWith('si-'))engine.plume.concentrationAt=p=>synthetic(spec.field,p,config.domainMeters)
 const actualSamples:any[][]=Array.from({length:17},()=>[])
 engine.controller.step=input=>{
  const i=probe.index,v=probe.visits[i],before=v?.samples.length??0,decision=probe.step(input)
  if(v&&v.samples.length>before)actualSamples[i]!.push({time:input.time,position:{...input.position},heading:input.heading,measurementConcentration:input.measurement.concentration,localInletReadings:structuredClone(input.measurement.localInletReadings??[])})
  return decision
 }
 while(!engine.isCompleted())engine.step()
 const frame=engine.getFrame()
 if(!probe.result||probe.visits.some(v=>v.closedAt===null||v.samples.length<2)||frame.metrics.nativeDeclaration||frame.metrics.nativeAbstention)throw Error(`Case ${spec.index} incomplete or native terminal claim`)
 return {schemaVersion:'si-pose-aware-temporal-run-v1',spec,configSha256:configHashes[spec.field],nominalTargets:probe.nominalTargets,actualTargets:probe.actualTargets,positionOffsetsMetres:probe.positionOffsetsMetres,desiredHeadings:probe.desiredHeadings,headingOffsetsRadians:probe.headingOffsetsRadians,visits:probe.visits,actualSamples,result:probe.result,summary:{completedAt:probe.completedAt,pathLengthMeters:frame.metrics.pathLengthMeters,retainedSamples:probe.visits.reduce((n,v)=>n+v.samples.length,0),nativeDeclaration:frame.metrics.nativeDeclaration,nativeAbstention:frame.metrics.nativeAbstention}}
}

if(workerArg!==undefined){
 const worker=Number(workerArg)
 if(!Number.isInteger(worker)||worker<0||worker>=workerCount)throw Error('Invalid worker')
 const manifest=JSON.parse(await readFile(resolve(output,'manifest.json'),'utf8'))
 if(json(manifest.cases)!==json(cases)||json(manifest.configHashes)!==json(configHashes))throw Error('Worker design mismatch')
 const dir=resolve(output,`worker-${worker}`);await mkdir(dir)
 const startedAt=new Date().toISOString(),start=performance.now(),inventory:any[]=[]
 let maxRssBytes=0
 for(const spec of cases.filter(c=>c.index%workerCount===worker)){
  const record=run(spec),body=gzipSync(Buffer.from(json(record)),{level:6}),file=`run-${String(spec.index).padStart(4,'0')}.json.gz`
  await writeNew(resolve(dir,file),body);inventory.push({index:spec.index,file,sha256:sha(body),bytes:body.length})
  maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
  if(inventory.length%5===0)process.stdout.write(`worker ${worker}: ${inventory.length}/${cases.filter(c=>c.index%workerCount===worker).length}\n`)
 }
 await writeNew(resolve(dir,'complete.json'),json({complete:true,worker,pid:process.pid,startedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,maxRssBytes,inventory}))
}else{
 await mkdir(output)
 const sources:any[]=[]
 await mkdir(resolve(output,'source-snapshot'))
 const sourceFiles=['research/protocols/si_pose_aware_temporal_pilot_2026-09-16.md','scripts/lib/si_pose_temporal.py','scripts/test-stage1j-temporal.py','scripts/stage1j-temporal-pilot.ts','scripts/lib/si-clocked-integrity-probe.ts','scripts/lib/si-pose-uncertainty-probe.ts','scripts/lib/stage1i-campaign-design.ts','scripts/lib/si-research-config.ts',fileURLToPath(import.meta.url)]
 for(const file of sourceFiles){const body=await readFile(file),name=basename(file);await writeNew(resolve(output,'source-snapshot',name),body);sources.push({file,name,sha256:sha(body)})}
 const manifest={schemaVersion:'si-pose-aware-temporal-pilot-v1',createdAt:new Date().toISOString(),caseCount:cases.length,cases,configs,configHashes,sources,workerCount,host:{platform:process.platform,arch:process.arch,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),node:process.version}}
 await writeNew(resolve(output,'manifest.json'),json(manifest))
 const launchedAt=new Date().toISOString(),start=performance.now()
 const results=await Promise.allSettled(Array.from({length:workerCount},(_,worker)=>new Promise((accept,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--output',output,'--worker',String(worker)],{stdio:'inherit',env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}})
  process.stdout.write(`launched worker ${worker} PID ${child.pid}\n`)
  child.on('error',reject);child.on('exit',(code,signal)=>code===0?accept({worker,pid:child.pid,code}):reject(Error(`worker ${worker} code ${code}, signal ${signal}`)))
 })))
 const failures=results.filter(r=>r.status==='rejected').map(r=>String((r as PromiseRejectedResult).reason))
 await writeNew(resolve(output,'complete.json'),json({complete:failures.length===0,caseCount:cases.length,launchedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,workers:results,failures,manifestSha256:sha(json(manifest))}))
 if(failures.length)throw Error(failures.join('\n'))
 process.stdout.write(`COMPLETE ${cases.length} missions; ${(performance.now()-start)/1000}s\n`)
}
