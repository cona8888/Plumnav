import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {gzipSync,gunzipSync} from 'node:zlib'
import {fileURLToPath} from 'node:url'
import {SimulationEngine} from '../src/sim/engine'
import {SeededRandom} from '../src/sim/rng'
import {LocalInletChannel} from '../src/sim/localInletSampling'
import {estimateQuadGradient} from '../src/sim/algorithms/quadSoilSniff'
import {EventInstrument} from './lib/si-event-integration'
import {LinearInletChannel} from './lib/si-linear-inlet'
import {LinearInstrument} from './lib/si-linear-instrument'
import {makeMotionSegment,sampleMotion,type MotionSegment} from './lib/si-turn-motion'
import {stage1iSha256 as sha,stage1iStableJson as json} from './lib/stage1i-campaign-design'
const root='research/evidence/si_turn_fresh_2026-09-17',output='research/evidence/si_linear_fixed_2026-09-17',dir=`${root}/worker-3`
const inventory=JSON.parse(await readFile(`${dir}/complete.json`,'utf8')).inventory,item=inventory.find((i:any)=>i.index===59),raw=await readFile(`${dir}/${item.file}`);assert.equal(sha(raw),item.sha256)
const record=JSON.parse(gunzipSync(raw).toString()),config=record.config,prior=JSON.parse(await readFile(`${root}/manifest.json`,'utf8')),meta=JSON.parse(await readFile('outputs/stage2-linear-fixed.meta.json','utf8'))
for(const s of prior.sources)assert.equal(sha(await readFile(s.file)),s.sha256,s.file)
await mkdir(output);await mkdir(`${output}/source-snapshot`);const sources:any[]=[]
const files=[...prior.sources.map((s:any)=>s.file),...Object.keys(meta.inputs),'scripts/lib/si_linear_response_audit.py','scripts/test-stage2-linear.ts','scripts/test-stage2-linear.py','scripts/analyze-stage2-linear-fixed.py','research/protocols/si_linear_response_v1_2026-09-17.md',fileURLToPath(import.meta.url)]
for(const [i,file]of [...new Set<string>(files)].entries()){
 const b=await readFile(file),name=`${String(i).padStart(3,'0')}-${file.split('/').at(-1)}`;await writeFile(`${output}/source-snapshot/${name}`,b,{flag:'wx'});sources.push({file,name,sha256:sha(b)})
}
const manifest={createdAt:new Date().toISOString(),canonicalRawFile:`${dir}/${item.file}`,canonicalRawSha256:sha(raw),sources,meshes:[1/64,1/128,1/256],syntheticSeed:345991}
await writeFile(`${output}/manifest.json`,json(manifest),{flag:'wx'});const histories:any[]=[],start=performance.now()
const initial={position:{x:.5,y:.5},heading:.31,distance:0},decision={direction:{x:0,y:1},speedScale:1,estimate:null,confidence:0,phase:'MANUFACTURED'}
const first=makeMotionSegment(initial,decision,0,7.3,.01,Math.PI/4,.04),second=makeMotionSegment(sampleMotion(first,7.3),{...decision,direction:{x:0,y:0}},7.3,3.4,.01,Math.PI/4,.04),third=makeMotionSegment(sampleMotion(second,10.7),{...decision,direction:{x:0,y:-1}},10.7,9.3,.01,Math.PI/4,.04)
for(const kind of ['canonical','smooth','turn-stop'])for(const model of (kind==='canonical'?['linear']:['held','linear']))for(const dt of manifest.meshes){
 const c=structuredClone(config),noiseSeed=kind==='canonical'?record.spec.worldSeed+3000000:manifest.syntheticSeed;let trace:number[][]|null=null,times:number[]=[],inputs:number[][]=[],filtered:number[][]=[],readouts:number[][]=[]
 if(kind==='smooth'){
  const Channel=model==='linear'?LinearInletChannel:LocalInletChannel,channels=Array.from({length:4},()=>new Channel(c.localInletSampling)),rng=new SeededRandom(noiseSeed);let readout=[0,0,0,0]
  for(let i=0;i<=32/dt;i++){
   const t=i*dt,u=channels.map((_,j)=>.6+.2*Math.sin(.7*t+j*Math.PI/2)),f=u.map((v,j)=>channels[j]!.update(t,v))
   if(i%Math.round(1/dt)===0)readout=f.map(v=>Math.max(0,Math.min(c.sensorSaturation,v+c.sensorNoise*rng.normal())))
   times.push(t);inputs.push(u);filtered.push(f);readouts.push([...readout])
  }
 }else{
  const engine=new SimulationEngine(c),Instrument=model==='linear'?LinearInstrument:EventInstrument
  const field=kind==='canonical'?engine.plume.concentrationAt.bind(engine.plume):(p:{x:number;y:number})=>.6+.18*Math.sin(20*(p.x-.5))+.12*Math.cos(20*(p.y-.5))
  const instrument=new Instrument(c,field,dt,noiseSeed)
  instrument.advance(kind==='canonical'?record.summary.completedAt:20,t=>kind==='canonical'?sampleMotion((record.segments as MotionSegment[])[Math.max(0,Math.ceil(t*16)-1)]!,t):sampleMotion(t<=7.3?first:t<=10.7?second:third,t))
  trace=instrument.trace;times=trace.map(r=>r[0]!);inputs=trace.map(r=>r.slice(12,16));filtered=trace.map(r=>r.slice(16,20));readouts=trace.map(r=>r.slice(20,24))
 }
 const bearings=kind==='canonical'?record.controls.filter((r:any)=>r.measurement.sampleMode==='quad-passive-return').map((r:any)=>{
  const v=readouts[Math.round(r.time/dt)]!,readings=r.measurement.quadSniff.readings.map((q:any,j:number)=>({...q,concentration:v[j],hit:v[j]!>=.115,saturated:v[j]!>=c.sensorSaturation-1e-9})),g=estimateQuadGradient(readings,c.sensorNoise,c.localInletSampling.gradientEstimator)
  return {time:r.time,usable:g.validDirection&&g.commonMean>=.16&&g.quality>=.08&&g.usableChannels===4&&g.geometryQuality>=1-1e-9&&g.supportQuality>=1-1e-9&&!readings.some((r:any)=>r.saturated),gradient:g}
 }):null
 const data={kind,model,dt,config:c,noiseSeed,times,inputs,filtered,readouts,trace,bearings},file=`${kind}-${model}-${Math.round(1/dt)}.json.gz`,body=gzipSync(JSON.stringify(data))
 await writeFile(`${output}/${file}`,body,{flag:'wx'});histories.push({kind,model,dt,file,sha256:sha(body),bytes:body.length});process.stdout.write(`${file}: complete\n`)
}
await writeFile(`${output}/complete.json`,json({complete:true,manifestSha256:sha(json(manifest)),histories,elapsedSeconds:(performance.now()-start)/1000}),{flag:'wx'})
