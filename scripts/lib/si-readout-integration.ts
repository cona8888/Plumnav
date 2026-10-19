import {SimulationEngine} from '../../src/sim/engine'
import type {AlgorithmStepInput,AlgorithmDecision,Observation} from '../../src/sim/types'
import {publicEnvironment,VerifierBridge,cleanDecision,nominate,CONTROL_DT,ACQUISITION_SECONDS,MISSION_SECONDS} from './si-integration'
import {PassiveScanClock} from './si-event-integration'
import {SIPoseUncertaintyProbe} from './si-pose-uncertainty-probe'
import {makeMotionSegment,sampleMotion,type MotionSegment,type MotionPose} from './si-turn-motion'
import {schedulingController} from './si-encounter-gate'
import {responseConfig as integrationConfig,type ResponseSpec as LinearSpec} from './si-response-design'
import {LinearInstrument} from './si-linear-instrument'
import {exposeScanReadout,scanBlocksMotion,scanCanDrain,READOUT_AVAILABILITY_VERSION,type ReadoutAvailability} from './si-readout-availability'
const stop=(phase:string):AlgorithmDecision=>({direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase})

export async function runReadoutIntegration(s:LinearSpec,bridge:VerifierBridge,availability:ReadoutAvailability,development?:{startAtSource?:boolean;acquisitionSeconds?:number;analyticPeak?:boolean}){
 if(!['original-withheld','live-passive'].includes(availability))throw Error('Unknown readout availability')
 const availabilityTrace:any[]=[]
 const c=integrationConfig(s);if(development?.startAtSource)c.robotStartPositionOverride={...c.sourcePositionOverride!}
 const engine=new SimulationEngine(c),env=publicEnvironment(engine),schedule=schedulingController(engine.controller,s.policy),controller=schedule.controller,p=c.localInletSampling!
 controller.reset(env)
 const field=development?.analyticPeak?(point:{x:number;y:number})=>.01+Math.exp(-((point.x-c.sourcePositionOverride!.x)**2+(point.y-c.sourcePositionOverride!.y)**2)*c.domainMeters**2/.18):engine.plume.concentrationAt.bind(engine.plume)
 const instrument=new LinearInstrument(c,field,c.fixedDt/4,s.worldSeed+3000000),clock=new PassiveScanClock(c,point=>env.isBlocked(point,0)),clearance=Math.hypot(p.robotLengthMetres,p.robotWidthMetres)/(2*c.domainMeters)
 let pose:MotionPose={position:{...c.robotStartPositionOverride!},heading:c.robotStartHeadingDegrees!*Math.PI/180,distance:0},previous:MotionSegment|null=null,probe:SIPoseUncertaintyProbe|null=null
 const observations:Observation[]=[],controls:any[]=[],navigation:any[]=[],segments:MotionSegment[]=[],nativeEvents:any[]=[]
 let nomination:ReturnType<typeof nominate>=null,stage='acquisition',finished=false,finalTime=0,firstEncounter:{time:number;distanceMetres:number}|null=null,nominationAt:number|null=null,inspectionAt:number|null=null
 const acquisitionSeconds=development?.acquisitionSeconds??ACQUISITION_SECONDS
 for(let tick=0;tick<=MISSION_SECONDS/CONTROL_DT;tick++){
  const time=tick*CONTROL_DT
  if(previous)pose=sampleMotion(previous,time)
  instrument.advance(time,t=>previous?sampleMotion(previous,t):pose)
  const rawMeasurement=clock.measurement(time,pose,instrument.readout)
  const measurement=exposeScanReadout(rawMeasurement,availability)
  availabilityTrace.push({time,scanId:clock.event?.scanId??null,rawMode:rawMeasurement.sampleMode,rawValid:rawMeasurement.valid,effectiveMode:measurement.sampleMode,effectiveValid:measurement.valid})
  if(measurement.valid){observations.push({...structuredClone(measurement),position:{...pose.position}});if(measurement.hit&&!firstEncounter)firstEncounter={time,distanceMetres:pose.distance*c.domainMeters}}
  const input:AlgorithmStepInput={time,dt:CONTROL_DT,...pose,position:{...pose.position},measurement,observations}
  if(stage==='acquisition'&&time>=acquisitionSeconds){nomination=nominate(observations,c.domainMeters,q=>env.isBlocked(q));nominationAt=time;stage=nomination?'drain':'no-eligible-nomination';if(!nomination)finished=true}
  if(stage==='drain'&&scanCanDrain(rawMeasurement)){
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
  const segment=makeMotionSegment(pose,decision,time,CONTROL_DT,c.robotSpeed,p.maximumTurnRateRadiansPerSecond,clearance,scanBlocksMotion(rawMeasurement,accepted))
  segments.push(segment)
  for(let i=0;i<Math.round(CONTROL_DT/c.fixedDt);i++){
   const t=time+i*c.fixedDt;navigation.push({time:t,...sampleMotion(segment,t),sampleMode:i===0?rawMeasurement.sampleMode:clock.event?'blanked':'passive',decision})
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
  availabilityVersion:READOUT_AVAILABILITY_VERSION,availability,availabilityTrace,
  responseVersion:'linear-inlet-v1',motionVersion:'antipodal-positive-v1',schedulingVersion:'encounter-gate-v1',schedulingTrace:schedule.trace,navigation,controls,segments,observations,trace:instrument.trace,nomination,visits,motionContract,verification,nativeEvents,
  summary:{stage,completedAt:finalTime,acquisitionBudgetSeconds:acquisitionSeconds,nominationAt,inspectionAt,firstEncounter,nominationSourceErrorMetres:nomination&&source?Math.hypot(nomination.point.x-source.x,nomination.point.y-source.y)*c.domainMeters:null,
   pathLengthMetres:pose.distance*c.domainMeters,airLitres:4*p.flowLitresPerMinutePerChannel*finalTime/60,retainedSamples:visits.reduce((a,v)=>a+v.samples.length,0),rpcMilliseconds,errors,assertedNoLeak:false,physicalSourceConfirmed:false}}
}

/** Replay uses only recorded public inputs, never concentrationAt or source truth. */
export function replayReadoutIntegration(record:Awaited<ReturnType<typeof runReadoutIntegration>>){
 const engine=new SimulationEngine(record.config),env=publicEnvironment(engine),schedule=schedulingController(engine.controller,record.spec.policy),controller=schedule.controller
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
 if(JSON.stringify(schedule.trace)!==JSON.stringify(record.schedulingTrace))throw Error('Scheduling replay mismatch')
 return {passed:true,decisionsChecked:checked,privateFieldQueries:0,schedulingTraceMatched:true}
}

