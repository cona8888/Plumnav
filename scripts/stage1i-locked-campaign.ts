import {mkdir,writeFile,rename} from 'node:fs/promises'
import {resolve} from 'node:path'
import {gzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {SIPoseUncertaintyProbe} from './lib/si-pose-uncertainty-probe'
import {buildStage1iCases,buildStage1iConfig,buildStage1iManifest,stage1iSha256,stage1iStableJson,STAGE1I_SMOKE_INDICES,type Stage1iCase,type Stage1iField} from './lib/stage1i-campaign-design'

const arg=(name:string,fallback?:string)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1]}
const mode=arg('mode','smoke') as 'smoke'|'production',shardIndex=Number(arg('shard-index','0')),shardCount=Number(arg('shard-count','1')),output=resolve(arg('output','stage1i-output')!)
if(!['smoke','production'].includes(mode)||!Number.isInteger(shardIndex)||!Number.isInteger(shardCount)||shardCount<1||shardIndex<0||shardIndex>=shardCount)throw Error('Invalid Stage 1i arguments')
const all=buildStage1iCases(),allowed=new Set(mode==='smoke'?STAGE1I_SMOKE_INDICES:all.map(c=>c.index)),cases=all.filter(c=>allowed.has(c.index)&&c.index%shardCount===shardIndex)
const worker=resolve(output,`worker-${shardIndex}`),blockSize=25
await mkdir(worker,{recursive:true})
const atomic=async(file:string,data:string|Uint8Array)=>{const target=resolve(worker,file),partial=`${target}.partial`;await writeFile(partial,data);await rename(partial,target)}
const manifest={...buildStage1iManifest(),mode,shardIndex,shardCount,assignedCaseIndices:cases.map(c=>c.index)}
await atomic('manifest.json',stage1iStableJson(manifest))

const synthetic=(field:Stage1iField,p:{x:number;y:number},domain:number)=>{const x=(p.x-.5)*domain,y=(p.y-.5)*domain,r=Math.hypot(x,y)
 switch(field){case'peak':return .01+Math.exp(-(r*r)/(2*.3**2));case'offset-peak':return .01+Math.exp(-((x-.03)**2+(y+.02)**2)/(2*.3**2));case'ridge':return .01+Math.exp(-(x*x)/(2*.3**2));case'saddle':return Math.max(0,1-(x*x+y*y)/(2*.3**2)+2*x*y/.3**2);case'plateau':return r<=.3?1:.01+.99*Math.exp(-((r-.3)**2)/(2*.3**2));case'uniform':return 1;case'blank':return 0;case'clipped-peak':return 3*Math.exp(-(r*r)/(2*.3**2));default:throw Error(`Not a synthetic field: ${field}`)} }

async function runCase(spec:Stage1iCase){
 const config=buildStage1iConfig(spec.field),engine=new SimulationEngine(config),candidate=config.robotStartPositionOverride!,probe=new SIPoseUncertaintyProbe({...engine.environment,sensorNoise:.001},candidate,config.domainMeters,spec.uncertainty)
 if(!spec.field.startsWith('si-'))engine.plume.concentrationAt=p=>synthetic(spec.field,p,config.domainMeters)
 const actualSamples:Array<Array<any>>=Array.from({length:17},()=>[])
 engine.controller.step=input=>{const visitIndex=probe.index,visit=probe.visits[visitIndex],before=visit?.samples.length??0,decision=probe.step(input)
  if(visit&&visit.samples.length>before)actualSamples[visitIndex]!.push({time:input.time,position:{...input.position},heading:input.heading,measurementConcentration:input.measurement.concentration,localInletReadings:structuredClone(input.measurement.localInletReadings??[])})
  return decision}
 while(!engine.isCompleted())engine.step()
 const frame=engine.getFrame(),result=probe.result??{status:'incomplete',reason:'incomplete-circuit',medians:null,coefficients:null,rmse:null,eigenMax:null,peak:null}
 const magnitudes=probe.positionOffsetsMetres.map(v=>Math.hypot(v.x,v.y))
 return {schemaVersion:'si-pose-registration-run-v1',spec,configSha256:stage1iSha256(stage1iStableJson(config)),nominalTargets:probe.nominalTargets,actualTargets:probe.actualTargets,positionOffsetsMetres:probe.positionOffsetsMetres,headingOffsetsRadians:probe.headingOffsetsRadians,desiredHeadings:probe.desiredHeadings,visits:probe.visits,actualSamples,result,summary:{index:spec.index,field:spec.field,kind:spec.kind,replicate:spec.replicate,...spec.uncertainty,status:result.status,reason:result.reason,completedAt:probe.completedAt,pathLengthMeters:frame.metrics.pathLengthMeters,retainedSamples:probe.visits.reduce((n,v)=>n+v.samples.length,0),clippedRetained:probe.visits.reduce((n,v)=>n+v.samples.filter(s=>s.clipped).length,0),maximumTargetOffsetMetres:Math.max(...magnitudes),rmsTargetOffsetMetres:Math.sqrt(magnitudes.reduce((n,v)=>n+v*v,0)/magnitudes.length),nativeDeclaration:frame.metrics.nativeDeclaration,nativeAbstention:frame.metrics.nativeAbstention}}
}

const inventory:Array<{file:string;sha256:string;bytes:number;caseIndices:number[]}>=[],startedAt=new Date().toISOString();let completed=0
for(let start=0;start<cases.length;start+=blockSize){const records=[];for(const spec of cases.slice(start,start+blockSize)){records.push(await runCase(spec));completed++;if(completed%10===0||completed===cases.length)process.stdout.write(`worker ${shardIndex}: ${completed}/${cases.length}\n`)}
 const raw=Buffer.from(stage1iStableJson({schemaVersion:'si-pose-registration-block-v1',records})),body=gzipSync(raw,{level:9}),file=`block-${String(start/blockSize).padStart(5,'0')}.json.gz`;await atomic(file,body);inventory.push({file,sha256:stage1iSha256(body),bytes:body.byteLength,caseIndices:records.map(r=>r.spec.index)})
 await atomic('progress.json',stage1iStableJson({complete:false,mode,shardIndex,shardCount,completed,expected:cases.length,inventory,updatedAt:new Date().toISOString()}))}
await atomic('complete.json',stage1iStableJson({complete:true,mode,shardIndex,shardCount,completed,expected:cases.length,startedAt,finishedAt:new Date().toISOString(),manifestSha256:manifest.manifestSha256,inventory}))
