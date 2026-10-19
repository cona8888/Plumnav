import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {gzipSync} from 'node:zlib'
import {cpus,totalmem} from 'node:os'
import {SimulationEngine} from '../src/sim/engine'
import {validateSimulationConfig} from '../src/sim/config'
import {tubeTransportSeconds} from '../src/sim/physicalDesign'
import {SIPoseUncertaintyProbe} from './lib/si-pose-uncertainty-probe'
import {buildStage1iConfig,STAGE1I_FIELDS,stage1iSha256 as sha,stage1iStableJson as json,type Stage1iField} from './lib/stage1i-campaign-design'

const arg=(key:string,fallback?:string)=>{const i=process.argv.indexOf(`--${key}`);return i<0?fallback:process.argv[i+1]}
const output=resolve(arg('output','research/evidence/si_stationary_dwell_pilot_2026-09-16')!),workerArg=arg('worker'),workerCount=4
type Spec={index:number;field:Stage1iField;phaseSeconds:number;radiusMetres:number;response:'nominal'|'slow';noiseC0:number;replicate:number;seed:number;worldSeed:number;panel:'core'|'noise-stress'}
const cases:Spec[]=[]
const add=(field:Stage1iField,phaseSeconds:number,radiusMetres:number,response:Spec['response'],noiseC0:number,replicate:number,panel:Spec['panel'])=>cases.push({index:cases.length,field,phaseSeconds,radiusMetres,response,noiseC0,replicate,seed:920101+replicate,worldSeed:98101+replicate,panel})
for(const field of STAGE1I_FIELDS)for(const phase of field==='si-pulse'?[0,5,10,15]:[0])for(const radius of [0,.05])for(const response of ['nominal','slow'] as const)for(const noise of [0,.001])for(const rep of radius===0&&noise===0?[0]:[0,1,2,3])add(field,phase,radius,response,noise,rep,'core')
for(const field of ['peak','offset-peak','si-continuous','si-pulse','uniform','blank'] as Stage1iField[])for(const rep of [0,1,2,3])add(field,0,.05,'nominal',.02,rep,'noise-stress')
if(cases.length!==388)throw Error('Wrong case count')

function buildConfig(spec:Spec){
 const c=buildStage1iConfig(spec.field),p=c.localInletSampling!,atmosphere=c.physicalAtmosphere!
 c.seed=spec.worldSeed;c.durationSeconds=900;c.checkpointSeconds=[900]
 c.sensorNoise=spec.noiseC0;atmosphere.measurement.noiseKgPerCubicMetre=spec.noiseC0*atmosphere.measurement.concentrationScaleKgPerCubicMetre
 if(atmosphere.pulse)atmosphere.pulse.phaseSeconds=spec.phaseSeconds
 const factor=spec.response==='slow'?4:1
 p.riseTimeConstantSeconds*=factor;p.recoveryTimeConstantSeconds*=factor;c.sensorLag=p.riseTimeConstantSeconds
 p.inspection.settlingSeconds=tubeTransportSeconds(p.tubeLengthMetres,p.tubeInnerDiameterMetres,p.flowLitresPerMinutePerChannel)-Math.log(.05)*Math.max(p.riseTimeConstantSeconds,p.recoveryTimeConstantSeconds)+p.averagingSeconds
 p.inspection.dwellSeconds=Math.ceil(p.inspection.settlingSeconds)+4
 p.inspection.maximumPairSeparationSeconds=2*p.inspection.dwellSeconds+2*p.inspection.offsetNormalized/c.robotSpeed
 c.activeSniffCycleSeconds=p.inspection.dwellSeconds
 validateSimulationConfig(c);return c
}
const configs=cases.map(buildConfig),configHashes=configs.map(c=>sha(json(c)))
const writeNew=(path:string,data:string|Uint8Array)=>writeFile(path,data,{flag:'wx'})
function synthetic(field:Stage1iField,p:{x:number;y:number},domain:number){
 const x=(p.x-.5)*domain,y=(p.y-.5)*domain,r=Math.hypot(x,y)
 switch(field){case'peak':return .01+Math.exp(-(r*r)/(2*.3**2));case'offset-peak':return .01+Math.exp(-((x-.03)**2+(y+.02)**2)/(2*.3**2));case'ridge':return .01+Math.exp(-(x*x)/(2*.3**2));case'saddle':return Math.max(0,1-(x*x+y*y)/(2*.3**2)+2*x*y/.3**2);case'plateau':return r<=.3?1:.01+.99*Math.exp(-((r-.3)**2)/(2*.3**2));case'uniform':return 1;case'blank':return 0;case'clipped-peak':return 3*Math.exp(-(r*r)/(2*.3**2));default:throw Error('Not synthetic')}
}
function run(spec:Spec){
 const config=configs[spec.index]!,engine=new SimulationEngine(config)
 const probe=new SIPoseUncertaintyProbe({...engine.environment,sensorNoise:.001},config.robotStartPositionOverride!,config.domainMeters,{positionRadiusMetres:spec.radiusMetres,headingBoundRadians:0,registration:'observed',perturbationSeed:spec.seed,positionErrorStructure:'independent'})
 if(!spec.field.startsWith('si-'))engine.plume.concentrationAt=p=>synthetic(spec.field,p,config.domainMeters)
 const actualSamples:any[][]=Array.from({length:17},()=>[])
 engine.controller.step=input=>{const i=probe.index,v=probe.visits[i],before=v?.samples.length??0,decision=probe.step(input)
  if(v&&v.samples.length>before)actualSamples[i]!.push({time:input.time,position:{...input.position},heading:input.heading,measurementConcentration:input.measurement.concentration,localInletReadings:structuredClone(input.measurement.localInletReadings??[])})
  return decision}
 while(!engine.isCompleted()&&!probe.result)engine.step()
 const frame=engine.getFrame()
 if(!probe.result||probe.visits.some(v=>v.closedAt===null||v.samples.length!==5)||frame.metrics.nativeDeclaration||frame.metrics.nativeAbstention)throw Error(`Incomplete inspection ${spec.index}`)
 return {schemaVersion:'si-stationary-dwell-run-v1',spec,configSha256:configHashes[spec.index],nominalTargets:probe.nominalTargets,actualTargets:probe.actualTargets,positionOffsetsMetres:probe.positionOffsetsMetres,desiredHeadings:probe.desiredHeadings,headingOffsetsRadians:probe.headingOffsetsRadians,visits:probe.visits,actualSamples,result:probe.result,summary:{completedAt:probe.completedAt,stopReason:'inspection-complete',pathLengthMeters:frame.metrics.pathLengthMeters,retainedSamples:probe.visits.reduce((n,v)=>n+v.samples.length,0),nativeDeclaration:frame.metrics.nativeDeclaration,nativeAbstention:frame.metrics.nativeAbstention}}
}

if(workerArg!==undefined){
 const worker=Number(workerArg);if(!Number.isInteger(worker)||worker<0||worker>=workerCount)throw Error('Invalid worker')
 const manifest=JSON.parse(await readFile(resolve(output,'manifest.json'),'utf8'))
 if(json(manifest.cases)!==json(cases)||json(manifest.configHashes)!==json(configHashes))throw Error('Design mismatch')
 const dir=resolve(output,`worker-${worker}`);await mkdir(dir)
 const startedAt=new Date().toISOString(),start=performance.now(),inventory:any[]=[];let maxRssBytes=0
 for(const spec of cases.filter(c=>c.index%workerCount===worker)){
  const record=run(spec),body=gzipSync(Buffer.from(json(record)),{level:6}),file=`run-${String(spec.index).padStart(4,'0')}.json.gz`
  await writeNew(resolve(dir,file),body);inventory.push({index:spec.index,file,sha256:sha(body),bytes:body.length})
  maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
  if(inventory.length%10===0)process.stdout.write(`worker ${worker}: ${inventory.length}/97\n`)
 }
 await writeNew(resolve(dir,'complete.json'),json({complete:true,worker,pid:process.pid,startedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,maxRssBytes,inventory}))
}else{
 await mkdir(output);await mkdir(resolve(output,'source-snapshot'))
 const sources:any[]=[]
 for(const file of ['research/protocols/si_stationary_dwell_pilot_2026-09-16.md','scripts/lib/si_stationary_dwell.py','scripts/lib/si_pose_temporal.py','scripts/test-stage1k-dwell.py','scripts/stage1k-dwell-pilot.ts','scripts/analyze-stage1k.py','scripts/audit-stage1i-decisions.py','scripts/lib/si-clocked-integrity-probe.ts','scripts/lib/si-pose-uncertainty-probe.ts','scripts/lib/stage1i-campaign-design.ts',fileURLToPath(import.meta.url)]){
  const body=await readFile(file),name=basename(file);await writeNew(resolve(output,'source-snapshot',name),body);sources.push({file,name,sha256:sha(body)})
 }
 const manifest={schemaVersion:'si-stationary-dwell-pilot-v1',createdAt:new Date().toISOString(),caseCount:cases.length,cases,configs,configHashes,sources,workerCount,host:{platform:process.platform,arch:process.arch,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),node:process.version}}
 await writeNew(resolve(output,'manifest.json'),json(manifest))
 const launchedAt=new Date().toISOString(),start=performance.now()
 const results=await Promise.allSettled(Array.from({length:workerCount},(_,worker)=>new Promise((accept,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--output',output,'--worker',String(worker)],{stdio:'inherit',env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}})
  process.stdout.write(`launched worker ${worker} PID ${child.pid}\n`);child.on('error',reject)
  child.on('exit',(code,signal)=>code===0?accept({worker,pid:child.pid,code}):reject(Error(`worker ${worker}: code ${code}, signal ${signal}`)))
 })))
 const failures=results.filter(r=>r.status==='rejected').map(r=>String((r as PromiseRejectedResult).reason))
 await writeNew(resolve(output,'complete.json'),json({complete:failures.length===0,caseCount:cases.length,launchedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,workers:results,failures,manifestSha256:sha(json(manifest))}))
 if(failures.length)throw Error(failures.join('\n'))
 process.stdout.write(`COMPLETE ${cases.length} missions; ${(performance.now()-start)/1000}s\n`)
}
