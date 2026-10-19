import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {gunzipSync,gzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {add,scale} from '../src/sim/math'
import {quadSniffChannelDirections} from '../src/sim/quadSniff'
import type {SimulationConfig,Vec2} from '../src/sim/types'

const root=resolve(process.argv[2]??'research/evidence/si_pulse_interface_isolation_2026-09-15')
const parent=resolve('research/evidence/si_precision_arrival_2026-09-15')
const protocol='research/protocols/si_pulse_interface_isolation_2026-09-15.md'
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const parentComplete=await readFile(resolve(parent,'complete.json'))
const parentRun=JSON.parse(gunzipSync(await readFile(resolve(parent,'run-65.json.gz'))).toString())
if(parentRun.spec.field!=='si-pulse'||parentRun.spec.noiseMode!=='zero'||parentRun.spec.dt!==.0625)throw Error('Unexpected parent fixture')
const base=parentRun.config as SimulationConfig,candidate=base.robotStartPositionOverride!,h=base.localInletSampling!.inspection.offsetNormalized
const poses=[candidate,...Array.from({length:8},(_,i)=>({x:candidate.x+h*Math.cos(i*Math.PI/4),y:candidate.y+h*Math.sin(i*Math.PI/4)}))]
const dts=[.25,.125,.0625,.015625],cases=poses.flatMap((position,pose)=>dts.map(dt=>({pose,position,dt})))
await mkdir(root)
const inventory:any[]=[],sources:any[]=[]
async function retain(file:string,data:unknown,zip=false){const raw=Buffer.from(JSON.stringify(data)+'\n'),b=zip?gzipSync(raw):raw;await writeFile(resolve(root,file),b,{flag:'wx'});inventory.push({file,sha256:sha(b)})}
async function snapshot(file:string){const b=await readFile(file),dest=resolve(root,'source-snapshot',file);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const f=`${dir}/${e.name}`;if(e.isDirectory())await walk(f);else if(f.endsWith('.ts'))await snapshot(f)}}
await walk('src/sim');for(const f of ['scripts/si-pulse-interface-isolation.ts',protocol])await snapshot(f)
await retain('manifest.json',{version:'si-pulse-interface-isolation-v1',protocol,parent:'research/evidence/si_precision_arrival_2026-09-15',parentCompleteSha256:sha(parentComplete),parentRunIndex:65,sourceSnapshot:sources,cases,durationSeconds:120,warmupSeconds:40,referenceDt:.015625,windowStarts:[40,52,64,76,88,100],windowSeconds:12,tolerances:{engineReplayC0:1e-9,clockForcingC0:1e-12,windowMedianC0:.003},scope:'Fixed-pose, zero-noise mechanism isolation. Fine timestep is a numerical reference, not physical truth.'})
const rows:any[]=[],started=Date.now();let maxRssBytes=0
for(const [index,spec] of cases.entries()){
 const config=structuredClone(base);config.fixedDt=spec.dt;config.durationSeconds=120;config.checkpointSeconds=[120];config.robotStartPositionOverride={...spec.position};config.robotStartHeadingDegrees=0;config.stopOnNativeDeclaration=false
 const engine=new SimulationEngine(config),ticks:any[]=[]
 const directions=quadSniffChannelDirections({x:1,y:0}),radius=config.localInletSampling!.opposingInletSpacingMetres/(2*config.domainMeters)
 engine.controller.step=input=>{
  if(Math.hypot(input.position.x-spec.position.x,input.position.y-spec.position.y)>1e-15||Math.abs(input.heading)>1e-15)throw Error('Fixed-pose fixture moved')
  const trueInlets=directions.map(d=>engine.plume.concentrationAt(add(input.position,scale(d.direction,radius)),input.time))
  ticks.push({time:input.time,trueInlets,...(input.measurement.valid?{readout:input.measurement.localInletReadings!.map(x=>x.concentration)}:{})})
  return {direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase:'SI FIXED-POSE PULSE'}
 }
 while(!engine.isCompleted())engine.step()
 const valid=ticks.filter(t=>t.readout),row={index,pose:spec.pose,position:spec.position,dt:spec.dt,ticks:ticks.length,readouts:valid.length,maximumTrueInletC0:Math.max(...ticks.flatMap(t=>t.trueInlets)),maximumReadoutC0:Math.max(...valid.flatMap(t=>t.readout))}
 await retain(`run-${index}.json.gz`,{spec,config,ticks,row},true);rows.push(row);maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
 if(index%4===3)process.stdout.write(`${index+1}/${cases.length}\n`)
}
await retain('summary.json',{rows,elapsedSeconds:(Date.now()-started)/1000,maxRssBytes})
await writeFile(resolve(root,'complete.json'),JSON.stringify({complete:true,cases:rows.length,inventory})+'\n',{flag:'wx'})
