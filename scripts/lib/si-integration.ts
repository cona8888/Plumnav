import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {SimulationEngine} from '../../src/sim/engine'
import {PhysicalHalfspacePlume} from '../../src/sim/physicalAtmosphere'
import {LocalInletChannel} from '../../src/sim/localInletSampling'
import {SeededRandom} from '../../src/sim/rng'
import {validateSimulationConfig} from '../../src/sim/config'
import {headConfig} from './si-head-motion'
import {SIPoseUncertaintyProbe} from './si-pose-uncertainty-probe'
import type {AlgorithmEnvironment,AlgorithmStepInput,AlgorithmDecision,Measurement,Observation,Vec2} from '../../src/sim/types'

export const CONTROL_DT=1/16, ACQUISITION_SECONDS=600, MISSION_SECONDS=1200
export const METHODS=['coverage','surge-cast','quad-sniff-refine'] as const
export type IntegrationSpec={index:number;field:'si-continuous'|'si-pulse'|'blank';method:typeof METHODS[number];replicate:number;worldSeed:number;sourceSeed:number;startSeed:number;controllerSeed:number;navDt:number}
export function integrationCases(){
 const out:IntegrationSpec[]=[]
 for(let replicate=0;replicate<2;replicate++)for(const field of ['si-continuous','si-pulse','blank'] as const)for(const method of METHODS)
  for(const navDt of replicate===0?[1/16,1/32,1/64]:[1/16])out.push({index:out.length,field,method,replicate,worldSeed:103301+replicate,sourceSeed:103501+replicate,startSeed:103701+replicate,controllerSeed:103901+replicate,navDt})
 return out
}
export function integrationConfig(s:IntegrationSpec){
 const c=headConfig({index:s.index,field:s.field,phaseSeconds:s.field==='si-pulse'?5:0,radiusMetres:0,response:'nominal',noiseC0:.001,replicate:s.replicate,seed:s.startSeed,worldSeed:s.worldSeed,panel:'head-motion',mode:0})
 const oldDomain=c.domainMeters,p=c.localInletSampling!
 c.domainMeters=10;c.robotSpeed*=oldDomain/c.domainMeters;c.activeSniffReach*=oldDomain/c.domainMeters
 for(const k of ['offsetNormalized','zoneRadiusNormalized','arrivalRadiusNormalized'] as const)p.inspection[k]*=oldDomain/c.domainMeters
 const source=new SeededRandom(s.sourceSeed),start=new SeededRandom(s.startSeed)
 c.sourcePositionOverride={x:.35+.3*source.next(),y:.35+.3*source.next()}
 c.robotStartPositionOverride={x:.1+.8*start.next(),y:.1+.8*start.next()}
 c.robotStartHeadingDegrees=360*start.next();c.targetStatus=s.field==='blank'?'absent':'emitting'
 if(s.field==='blank')delete c.sourcePositionOverride
 c.algorithmId=s.method;c.controllerSeed=s.controllerSeed;c.fixedDt=s.navDt
 c.durationSeconds=MISSION_SECONDS+c.fixedDt;c.checkpointSeconds=[c.durationSeconds]
 c.sensorFalsePositiveRate=0;c.sensorFalseNegativeRate=0
 if(s.method==='quad-sniff-refine')Object.assign(p,{gradientEstimator:'relative-geometry-v1',candidateLifecycle:'bounded-inspection-v1',acquisitionPolicy:'time-budgeted-viewpoints-v1',bearingGeometry:'linearized-local-bearing-v1',rayWindowPolicy:'rolling-expiry-v1',localGradientPolicy:'head-step-v1'})
 validateSimulationConfig(c);return c
}

export function publicEnvironment(engine:SimulationEngine):AlgorithmEnvironment{
 const e=engine.environment
 // This explicit map/pose/wind view has no source, forcing, field age or world seed.
 const scenario=Object.freeze({robotStart:Object.freeze({...e.scenario.robotStart}),baseWind:Object.freeze({...e.scenario.baseWind}),obstacles:Object.freeze([])})
 const guarded=new Proxy(scenario,{get(target,key){if(typeof key==='string'&&!(key in target))throw Error(`Undeclared scenario input: ${key}`);return Reflect.get(target,key)}})
 return Object.freeze({...e,durationSeconds:MISSION_SECONDS,scenario:guarded as unknown as AlgorithmEnvironment['scenario'],observationModelSeed:0,observationModelVersion:'integration-no-likelihood-v1',
  windAt:()=>({...scenario.baseWind}),expectedHitRate:()=>{throw Error('SI observation likelihood is not admitted in this reactive pilot')}}) as AlgorithmEnvironment
}

export class VerifierBridge{
 private child=spawn(process.env.PYTHON??'python',['-u','scripts/si-integration-bridge.py'],{stdio:['pipe','pipe','inherit'],env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'}})
 private next=0;private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>()
 constructor(){
  createInterface({input:this.child.stdout}).on('line',line=>{const r=JSON.parse(line),p=this.pending.get(r.id);if(!p)throw Error('Unexpected verifier RPC');this.pending.delete(r.id);r.ok?p.resolve(r.result):p.reject(Error(r.error))})
  this.child.on('error',error=>{for(const p of this.pending.values())p.reject(error);this.pending.clear()})
  this.child.on('exit',code=>{for(const p of this.pending.values())p.reject(Error(`Verifier exited ${code}`));this.pending.clear()})
 }
 request(data:object){const id=this.next++;return new Promise<any>((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.child.stdin.write(JSON.stringify({...data,id})+'\n')})}
 close(){this.child.stdin.end()}
}

const xy=(v:Vec2)=>[v.x,v.y]
const stop=(phase:string):AlgorithmDecision=>({direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase})
export const cleanDecision=(d:AlgorithmDecision):AlgorithmDecision=>({direction:{...d.direction},speedScale:d.speedScale,estimate:d.estimate?{...d.estimate}:null,confidence:d.confidence,phase:d.phase,...(d.quadSniff?{quadSniff:structuredClone(d.quadSniff)}:{})})

export function nominate(observations:readonly Observation[],domain:number,isBlocked:(p:Vec2)=>boolean){
 const hits=observations.filter(o=>o.valid&&o.hit&&o.concentration>=.16&&o.localInletReadings?.length===4&&!o.localInletReadings.some(r=>r.saturated))
 const ranked=[...hits].sort((a,b)=>b.concentration-a.concentration||a.time-b.time)
 for(const o of ranked){
  const neighbours=hits.filter(h=>Math.hypot(h.position.x-o.position.x,h.position.y-o.position.y)*domain<=.15)
  if(new Set(neighbours.map(h=>h.time)).size<3)continue
  const targets=[o.position,...Array.from({length:8},(_,i)=>({x:o.position.x+.1/domain*Math.cos(i*Math.PI/4),y:o.position.y+.1/domain*Math.sin(i*Math.PI/4)}))]
  if(targets.some(isBlocked))continue
  return {point:{...o.position},observationTime:o.time,concentration:o.concentration,supportTimes:neighbours.map(h=>h.time)}
 }
 return null
}

/** Continuous instrument on the causal, piecewise-linear executed body path.
 * Noise draws belong to integer-second hardware clocks, never solver ticks.
 */
export class IntegrationInstrument{
 readonly trace:number[][]=[]
 private readonly channels:LocalInletChannel[];private readonly noise:SeededRandom
 private lastPose:{time:number;position:Vec2;heading:number}|null=null
 private readout=[0,0,0,0];private tick=0
 constructor(private config:ReturnType<typeof integrationConfig>,private field:(p:Vec2,t:number)=>number,private dt:number,noiseSeed:number){
  this.channels=Array.from({length:4},()=>new LocalInletChannel(config.localInletSampling!));this.noise=new SeededRandom(noiseSeed)
 }
 advance(input:Pick<AlgorithmStepInput,'time'|'position'|'heading'|'measurement'>):Measurement{
  const now={time:input.time,position:{...input.position},heading:input.heading},before=this.lastPose??now,c=this.config,p=c.localInletSampling!
  while(this.tick*this.dt<=now.time+1e-12){
   const t=this.tick*this.dt,f=now.time===before.time?0:(t-before.time)/(now.time-before.time)
   if(f < -1e-10 || f > 1+1e-10)throw Error('Noncausal instrument interval')
   const x=before.position.x+f*(now.position.x-before.position.x),y=before.position.y+f*(now.position.y-before.position.y)
   const dh=Math.atan2(Math.sin(now.heading-before.heading),Math.cos(now.heading-before.heading)),heading=before.heading+f*dh,r=p.opposingInletSpacingMetres/(2*c.domainMeters)
   const points=[0,-Math.PI/2,Math.PI,Math.PI/2].map(a=>({x:x+r*Math.cos(heading+a),y:y+r*Math.sin(heading+a)}))
   const values=points.map(q=>this.field(q,t)),filtered=values.map((v,j)=>this.channels[j]!.update(t,v))
   if(this.tick%Math.round(1/this.dt)===0)this.readout=filtered.map(v=>Math.max(0,Math.min(c.sensorSaturation,v+c.sensorNoise*this.noise.normal())))
   // time, body x/y/heading, 8 inlet coordinates, 4 inputs, 4 filtered, 4 readouts.
   this.trace.push([t,x,y,heading,...points.flatMap(xy),...values,...filtered,...this.readout]);this.tick++
  }
  this.lastPose=now
  const m=structuredClone(input.measurement),threshold=c.physicalAtmosphere!.measurement.thresholdKgPerCubicMetre/c.physicalAtmosphere!.measurement.concentrationScaleKgPerCubicMetre
  m.concentration=this.readout.reduce((a,b)=>a+b,0)/4
  m.wind={x:p.referenceWindMetresPerSecond/c.domainMeters,y:-p.referenceWindMetresPerSecond/c.domainMeters*Math.cos(Math.PI/2)}
  m.localInletReadings=m.localInletReadings!.map((r,j)=>({...r,concentration:this.readout[j]!,saturated:this.readout[j]!>=c.sensorSaturation-1e-9}))
  if(m.quadSniff?.readings)m.quadSniff.readings=m.quadSniff.readings.map((r,j)=>({...r,concentration:this.readout[j]!,hit:this.readout[j]!>=threshold,saturated:this.readout[j]!>=c.sensorSaturation-1e-9}))
  m.hit=m.valid&&(m.sampleMode==='quad-passive-return'?this.readout.some(v=>v>=threshold):m.concentration>=threshold)
  return m
 }
}

export async function runIntegration(s:IntegrationSpec,bridge:VerifierBridge,development?:{startAtSource?:boolean;acquisitionSeconds?:number;analyticPeak?:boolean}){
 const c=integrationConfig(s)
 if(development?.startAtSource)c.robotStartPositionOverride={...c.sourcePositionOverride!}
 const acquisitionSeconds=development?.acquisitionSeconds??ACQUISITION_SECONDS,engine=new SimulationEngine(c),env=publicEnvironment(engine)
 const field=new PhysicalHalfspacePlume(engine.scenario,c.seed,c)
 const instrument=new IntegrationInstrument(c,development?.analyticPeak?(p)=>.01+Math.exp(-((p.x-c.sourcePositionOverride!.x)**2+(p.y-c.sourcePositionOverride!.y)**2)*c.domainMeters**2/.18):field.concentrationAt.bind(field),c.fixedDt/4,s.worldSeed+3000000)
 const controller=engine.controller,acquire=controller.step.bind(controller);controller.reset(env)
 const observations:Observation[]=[],controls:any[]=[],navigation:any[]=[],nativeEvents:any[]=[]
 let held=stop('INITIAL'),probe:SIPoseUncertaintyProbe|null=null,nomination:ReturnType<typeof nominate>=null,finished=false,stage='acquisition',finalTime=0,previousInput:AlgorithmStepInput|null=null
 let firstEncounter:{time:number;distanceMetres:number}|null=null,nominationAt:number|null=null,inspectionAt:number|null=null
 controller.step=raw=>{
  const measurement=instrument.advance(raw),input:AlgorithmStepInput={time:raw.time,dt:CONTROL_DT,position:{...raw.position},heading:raw.heading,measurement,observations,distance:raw.distance}
  if(measurement.valid){observations.push({...structuredClone(measurement),position:{...input.position}});if(measurement.hit&&!firstEncounter)firstEncounter={time:input.time,distanceMetres:input.distance*c.domainMeters}}
  const due=Math.round(input.time/c.fixedDt)%Math.round(CONTROL_DT/c.fixedDt)===0
  if(due){
   if(stage==='acquisition'&&input.time>=acquisitionSeconds){nomination=nominate(observations,c.domainMeters,p=>env.isBlocked(p));nominationAt=input.time;stage=nomination?'drain':'no-eligible-nomination';if(!nomination)finished=true}
   if(stage==='drain'&&measurement.sampleMode!=='blanked'){
    probe=new SIPoseUncertaintyProbe(env,nomination!.point,c.domainMeters,{positionRadiusMetres:0,headingBoundRadians:0,registration:'observed',perturbationSeed:s.startSeed,positionErrorStructure:'independent'});inspectionAt=input.time;stage='inspection'
   }
   let decision:AlgorithmDecision
   if(finished)decision=stop(stage)
   else if(stage==='acquisition')decision=acquire(input)
   else if(stage==='inspection')decision=probe!.step(input)
   else decision=stop('DRAIN ACTIVE READOUT')
   if(decision.nativeTerminated||decision.nativeAbstained)nativeEvents.push({time:input.time,nativeTerminated:!!decision.nativeTerminated,nativeAbstained:!!decision.nativeAbstained,reason:decision.terminationReason})
   held=cleanDecision(decision)
   controls.push({time:input.time,position:{...input.position},heading:input.heading,distance:input.distance,measurement:structuredClone(measurement),stage,decision:structuredClone(held)})
   if(probe?.result){finished=true;stage='inspection-complete'}
   if(input.time>=MISSION_SECONDS){finished=true;if(stage!=='inspection-complete')stage='mission-budget-exhausted'}
  }
  navigation.push({time:input.time,position:{...input.position},heading:input.heading,distance:input.distance,sampleMode:measurement.sampleMode,decision:held})
  finalTime=input.time;previousInput=input;return held
 }
 while(!engine.isCompleted()&&!finished)engine.step()
 if(!finished||!previousInput)throw Error('Integration ended without explicit endpoint')
 const visits=probe?structuredClone(probe.visits):[],motionContract=stage==='inspection-complete'?{version:'continuous-stationary-head-v1',basis:'prescribed-numerical-constraint',scope:'continuous-head-centre-and-orientation',windows:visits.map((v,i)=>({visit:i,start:v.arrivedAt,end:v.closedAt,translationDiameterMetres:0,orientationSpanRadians:0}))}:null
 const rpcStart=performance.now(),verification=motionContract?await bridge.request({operation:'verify',visits,motionContract,reportingReplicate:600000+s.replicate}):null,rpcMilliseconds=motionContract?performance.now()-rpcStart:0
 const final=navigation.at(-1)!,source=engine.scenario.source
 const errors=verification?.arms.map((a:any)=>{const fit=a.decision.candidate,peak=fit?.geometry?.peak
  const point=a.decision.status==='supported'&&peak?{x:nomination!.point.x+.1/c.domainMeters*peak[0],y:nomination!.point.y+.1/c.domainMeters*peak[1]}:null
  return {poseRadiusMetres:a.poseRadiusMetres,reportedPoint:point,sourceErrorMetres:point&&source?Math.hypot(point.x-source.x,point.y-source.y)*c.domainMeters:null}
 })??[]
 return {schemaVersion:'si-acquisition-integration-run-v1',spec:s,config:c,development:development??null,publicEnvironment:Object.fromEntries(Object.entries(env).filter(([k,v])=>typeof v!=='function'&&k!=='scenario')),publicScenario:{robotStart:{...env.scenario.robotStart},baseWind:{...env.scenario.baseWind},obstacles:[]},
  navigation,controls,observations,trace:instrument.trace,nomination,visits,motionContract,verification,nativeEvents,
  summary:{stage,completedAt:finalTime,acquisitionBudgetSeconds:acquisitionSeconds,nominationAt,inspectionAt,firstEncounter,nominationSourceErrorMetres:nomination&&source?Math.hypot(nomination.point.x-source.x,nomination.point.y-source.y)*c.domainMeters:null,
   pathLengthMetres:final.distance*c.domainMeters,airLitres:4*c.localInletSampling!.flowLitresPerMinutePerChannel*finalTime/60,retainedSamples:visits.reduce((a,v)=>a+v.samples.length,0),rpcMilliseconds,errors,assertedNoLeak:false,physicalSourceConfirmed:false}}
}

/** Replay uses only recorded public inputs, never concentrationAt or source truth. */
export function replayIntegration(record:Awaited<ReturnType<typeof runIntegration>>){
 const engine=new SimulationEngine(record.config),env=publicEnvironment(engine),controller=engine.controller
 controller.reset(env);const observations:Observation[]=[];let probe:SIPoseUncertaintyProbe|null=null,checked=0
 for(const row of record.controls){
  const m=structuredClone(row.measurement)
  if(m.valid)observations.push({...m,position:{...row.position}})
  const input:AlgorithmStepInput={time:row.time,dt:CONTROL_DT,position:{...row.position},heading:row.heading,distance:row.distance,measurement:m,observations}
  let decision:AlgorithmDecision
  if(row.stage==='acquisition')decision=controller.step(input)
  else if(row.stage==='inspection'){
   if(!probe)probe=new SIPoseUncertaintyProbe(env,record.nomination!.point,record.config.domainMeters,{positionRadiusMetres:0,headingBoundRadians:0,registration:'observed',perturbationSeed:record.spec.startSeed,positionErrorStructure:'independent'})
   decision=probe.step(input)
  }else decision=stop(row.stage==='drain'?'DRAIN ACTIVE READOUT':row.stage)
  if(JSON.stringify(cleanDecision(decision))!==JSON.stringify(row.decision))throw Error(`Public decision replay mismatch at ${row.time}`)
  checked++
 }
 if(JSON.stringify(probe?.visits??[])!==JSON.stringify(record.visits))throw Error('Inspection replay mismatch')
 return {passed:true,decisionsChecked:checked,privateFieldQueries:0}
}
