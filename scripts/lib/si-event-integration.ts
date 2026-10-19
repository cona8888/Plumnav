import {SimulationEngine} from '../../src/sim/engine'
import {LocalInletChannel} from '../../src/sim/localInletSampling'
import {SeededRandom} from '../../src/sim/rng'
import {createQuadSniffEvent,quadSniffStatusAt,quadSniffChannelDirections,type QuadSniffEvent} from '../../src/sim/quadSniff'
import type {AlgorithmStepInput,AlgorithmDecision,Measurement,Observation} from '../../src/sim/types'
import type {PlumeModel} from '../../src/sim/plume'
import {integrationCases,integrationConfig,publicEnvironment,VerifierBridge,cleanDecision,nominate,CONTROL_DT,ACQUISITION_SECONDS,MISSION_SECONDS,type IntegrationSpec} from './si-integration'
import {SIPoseUncertaintyProbe} from './si-pose-uncertainty-probe'
import {makeMotionSegment,sampleMotion,type MotionSegment,type MotionPose} from './si-event-motion'

export type EventSpec=IntegrationSpec&{panel:'old-world-diagnostic'|'fresh-acceptance'}
export const eventCases=(panel:EventSpec['panel']):EventSpec[]=>integrationCases().map(s=>({...s,panel,...(panel==='fresh-acceptance'?{worldSeed:110301+s.replicate,sourceSeed:110501+s.replicate,startSeed:110701+s.replicate,controllerSeed:110901+s.replicate}:{})}))
const stop=(phase:string):AlgorithmDecision=>({direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase})

/** Exactly the frozen response model, evaluated on the event-exact body path. */
export class EventInstrument{
 readonly trace:number[][]=[];private channels:LocalInletChannel[];private noise:SeededRandom;private tick=0
 readout=[0,0,0,0]
 constructor(private c:ReturnType<typeof integrationConfig>,private field:PlumeModel['concentrationAt'],private dt:number,seed:number){this.channels=Array.from({length:4},()=>new LocalInletChannel(c.localInletSampling!));this.noise=new SeededRandom(seed)}
 advance(to:number,poseAt:(t:number)=>MotionPose){
  const c=this.c,p=c.localInletSampling!,radius=p.opposingInletSpacingMetres/(2*c.domainMeters)
  while(this.tick*this.dt<=to){
   const t=this.tick*this.dt,pose=poseAt(t)
   const points=[0,-Math.PI/2,Math.PI,Math.PI/2].map(a=>({x:pose.position.x+radius*Math.cos(pose.heading+a),y:pose.position.y+radius*Math.sin(pose.heading+a)}))
   const values=points.map(x=>this.field(x,t)),filtered=values.map((v,j)=>this.channels[j]!.update(t,v))
   if(this.tick%Math.round(1/this.dt)===0)this.readout=filtered.map(v=>Math.max(0,Math.min(c.sensorSaturation,v+c.sensorNoise*this.noise.normal())))
   this.trace.push([t,pose.position.x,pose.position.y,pose.heading,...points.flatMap(x=>[x.x,x.y]),...values,...filtered,...this.readout]);this.tick++
  }
 }
}

export class PassiveScanClock{
 event:QuadSniffEvent|null=null;lastScanId:number|null=null
 constructor(private c:ReturnType<typeof integrationConfig>,private isBlocked:(point:{x:number;y:number})=>boolean){}
 measurement(time:number,pose:MotionPose,readout:number[]):Measurement{
  const c=this.c,p=c.localInletSampling!,radius=p.opposingInletSpacingMetres/(2*c.domainMeters),due=Number.isInteger(time)
  const returned=Boolean(this.event&&time>=this.event.startedAt+this.event.cycleSeconds&&due)
  const geometry=quadSniffChannelDirections({x:Math.cos(pose.heading),y:Math.sin(pose.heading)}).map(g=>({...g,reach:radius,support:1,effectiveOffset:{x:g.direction.x*radius,y:g.direction.y*radius}}))
  const readings=geometry.map((g,j)=>({...g,concentration:readout[j]!,hit:returned&&readout[j]!>=.115,saturated:readout[j]!>=c.sensorSaturation-1e-9,integrationSamples:1,effectiveIntegrationSamples:1}))
  const concentration=readout.reduce((a,b)=>a+b,0)/4
  return {time,concentration,wind:{x:p.referenceWindMetresPerSecond/c.domainMeters,y:-p.referenceWindMetresPerSecond/c.domainMeters*Math.cos(Math.PI/2)},valid:this.event?returned:due,hit:this.event?returned&&readings.some(r=>r.hit):due&&concentration>=.115,
   sampleMode:this.event?returned?'quad-passive-return':'blanked':'passive',localInletReadings:readings.map(({channel,concentration,saturated,effectiveOffset})=>({channel,concentration,saturated,effectiveOffset})),
   ...(this.event?{quadSniff:{...quadSniffStatusAt(this.event,time),channels:geometry,phase:returned?'return' as const:'aspirate' as const,...(returned?{readings}:{})}}:{})}
 }
 consumeAndCommand(measurement:Measurement,decision:AlgorithmDecision,pose:MotionPose){
  if(measurement.sampleMode==='quad-passive-return')this.event=null
  const c=this.c
  if(c.activeSniffEnabled&&!this.event&&decision.quadSniff&&decision.quadSniff.scanId!==this.lastScanId){
   const event=createQuadSniffEvent({command:{...decision.quadSniff,forward:{x:Math.cos(pose.heading),y:Math.sin(pose.heading)}},origin:pose.position,time:measurement.time,strengthScale:c.activeSniffStrength,samplingMode:'passive-array',passiveArrayRadius:c.localInletSampling!.opposingInletSpacingMetres/(2*c.domainMeters),cycleSeconds:c.activeSniffCycleSeconds,reachForDirection:()=>c.activeSniffReach,plume:{concentrationAt:()=>0} as unknown as PlumeModel,isBlocked:this.isBlocked})
   if(event){this.event=event;this.lastScanId=event.scanId;return true}
  }
  return false
 }
}

export async function runEventIntegration(s:EventSpec,bridge:VerifierBridge,development?:{startAtSource?:boolean;acquisitionSeconds?:number;analyticPeak?:boolean}){
 const c=integrationConfig(s);if(development?.startAtSource)c.robotStartPositionOverride={...c.sourcePositionOverride!}
 const engine=new SimulationEngine(c),env=publicEnvironment(engine),controller=engine.controller,p=c.localInletSampling!
 controller.reset(env)
 const field=development?.analyticPeak?(point:{x:number;y:number})=>.01+Math.exp(-((point.x-c.sourcePositionOverride!.x)**2+(point.y-c.sourcePositionOverride!.y)**2)*c.domainMeters**2/.18):engine.plume.concentrationAt.bind(engine.plume)
 const instrument=new EventInstrument(c,field,c.fixedDt/4,s.worldSeed+3000000),clock=new PassiveScanClock(c,point=>env.isBlocked(point,0)),clearance=Math.hypot(p.robotLengthMetres,p.robotWidthMetres)/(2*c.domainMeters)
 let pose:MotionPose={position:{...c.robotStartPositionOverride!},heading:c.robotStartHeadingDegrees*Math.PI/180,distance:0},previous:MotionSegment|null=null,probe:SIPoseUncertaintyProbe|null=null
 const observations:Observation[]=[],controls:any[]=[],navigation:any[]=[],segments:MotionSegment[]=[],nativeEvents:any[]=[]
 let nomination:ReturnType<typeof nominate>=null,stage='acquisition',finished=false,finalTime=0,firstEncounter:{time:number;distanceMetres:number}|null=null,nominationAt:number|null=null,inspectionAt:number|null=null
 const acquisitionSeconds=development?.acquisitionSeconds??ACQUISITION_SECONDS
 for(let tick=0;tick<=MISSION_SECONDS/CONTROL_DT;tick++){
  const time=tick*CONTROL_DT
  if(previous)pose=sampleMotion(previous,time)
  instrument.advance(time,t=>previous?sampleMotion(previous,t):pose)
  const measurement=clock.measurement(time,pose,instrument.readout)
  if(measurement.valid){observations.push({...structuredClone(measurement),position:{...pose.position}});if(measurement.hit&&!firstEncounter)firstEncounter={time,distanceMetres:pose.distance*c.domainMeters}}
  const input:AlgorithmStepInput={time,dt:CONTROL_DT,...pose,position:{...pose.position},measurement,observations}
  if(stage==='acquisition'&&time>=acquisitionSeconds){nomination=nominate(observations,c.domainMeters,q=>env.isBlocked(q));nominationAt=time;stage=nomination?'drain':'no-eligible-nomination';if(!nomination)finished=true}
  if(stage==='drain'&&measurement.sampleMode!=='blanked'){
   probe=new SIPoseUncertaintyProbe(env,nomination!.point,c.domainMeters,{positionRadiusMetres:0,headingBoundRadians:0,registration:'observed',perturbationSeed:s.startSeed,positionErrorStructure:'independent'});inspectionAt=time;stage='inspection'
  }
  const raw=finished?stop(stage):stage==='acquisition'?controller.step(input):stage==='inspection'?probe!.step(input):stop('DRAIN ACTIVE READOUT')
  if(raw.nativeTerminated||raw.nativeAbstained)nativeEvents.push({time,nativeTerminated:!!raw.nativeTerminated,nativeAbstained:!!raw.nativeAbstained,reason:raw.terminationReason})
  const decision=cleanDecision(raw)
  controls.push({time,...structuredClone(pose),measurement:structuredClone(measurement),stage,decision:structuredClone(decision)})
  if(probe?.result){finished=true;stage='inspection-complete'}
  if(time>=MISSION_SECONDS){finished=true;if(stage!=='inspection-complete')stage='mission-budget-exhausted'}
  finalTime=time
  if(finished){navigation.push({time,...structuredClone(pose),sampleMode:measurement.sampleMode,decision});break}
  const accepted=clock.consumeAndCommand(measurement,decision,pose)
  const segment=makeMotionSegment(pose,decision,time,CONTROL_DT,c.robotSpeed,p.maximumTurnRateRadiansPerSecond,clearance,measurement.sampleMode==='blanked'||accepted)
  segments.push(segment)
  for(let i=0;i<Math.round(CONTROL_DT/c.fixedDt);i++){
   const t=time+i*c.fixedDt;navigation.push({time:t,...sampleMotion(segment,t),sampleMode:i===0?measurement.sampleMode:clock.event?'blanked':'passive',decision})
  }
  previous=segment
 }
 if(!finished)throw Error('No explicit event-exact endpoint')
 const visits=probe?structuredClone(probe.visits):[],motionContract=stage==='inspection-complete'?{version:'continuous-stationary-head-v1',basis:'prescribed-numerical-constraint',scope:'continuous-head-centre-and-orientation',windows:visits.map((v,i)=>({visit:i,start:v.arrivedAt,end:v.closedAt,translationDiameterMetres:0,orientationSpanRadians:0}))}:null
 const rpcStart=performance.now(),verification=motionContract?await bridge.request({operation:'verify',visits,motionContract,reportingReplicate:600000+s.replicate}):null,rpcMilliseconds=motionContract?performance.now()-rpcStart:0
 const source=engine.scenario.source,errors=verification?.arms.map((a:any)=>{const peak=a.decision.candidate?.geometry?.peak
  const point=a.decision.status==='supported'&&peak?{x:nomination!.point.x+.1/c.domainMeters*peak[0],y:nomination!.point.y+.1/c.domainMeters*peak[1]}:null
  return {poseRadiusMetres:a.poseRadiusMetres,reportedPoint:point,sourceErrorMetres:point&&source?Math.hypot(point.x-source.x,point.y-source.y)*c.domainMeters:null}})??[]
 return {schemaVersion:'si-event-exact-integration-run-v1',spec:s,config:c,development:development??null,publicEnvironment:Object.fromEntries(Object.entries(env).filter(([k,v])=>typeof v!=='function'&&k!=='scenario')),publicScenario:{robotStart:{...env.scenario.robotStart},baseWind:{...env.scenario.baseWind},obstacles:[]},
  navigation,controls,segments,observations,trace:instrument.trace,nomination,visits,motionContract,verification,nativeEvents,
  summary:{stage,completedAt:finalTime,acquisitionBudgetSeconds:acquisitionSeconds,nominationAt,inspectionAt,firstEncounter,nominationSourceErrorMetres:nomination&&source?Math.hypot(nomination.point.x-source.x,nomination.point.y-source.y)*c.domainMeters:null,
   pathLengthMetres:pose.distance*c.domainMeters,airLitres:4*p.flowLitresPerMinutePerChannel*finalTime/60,retainedSamples:visits.reduce((a,v)=>a+v.samples.length,0),rpcMilliseconds,errors,assertedNoLeak:false,physicalSourceConfirmed:false}}
}
