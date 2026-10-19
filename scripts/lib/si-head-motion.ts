import {SimulationEngine} from '../../src/sim/engine'
import {validateSimulationConfig} from '../../src/sim/config'
import {tubeTransportSeconds} from '../../src/sim/physicalDesign'
import {LocalInletChannel} from '../../src/sim/localInletSampling'
import {SIPoseUncertaintyProbe} from './si-pose-uncertainty-probe'
import {buildStage1iConfig,stage1iSha256 as sha,stage1iStableJson as json,type Stage1iField} from './stage1i-campaign-design'
import type {SimulationConfig,Vec2} from '../../src/sim/types'

export const HEAD_MODES = [
 {id:'stationary',translationMetres:0,rotationRadians:0,periodSeconds:4},
 {id:'translation-1mm-4s',translationMetres:.001,rotationRadians:0,periodSeconds:4},
 {id:'translation-10mm-4s',translationMetres:.01,rotationRadians:0,periodSeconds:4},
 {id:'translation-10mm-1s',translationMetres:.01,rotationRadians:0,periodSeconds:1},
 {id:'rotation-15deg-4s',translationMetres:0,rotationRadians:Math.PI/12,periodSeconds:4},
 {id:'rotation-15deg-1s',translationMetres:0,rotationRadians:Math.PI/12,periodSeconds:1},
] as const
export type HeadSpec={index:number;field:Stage1iField;phaseSeconds:number;radiusMetres:number;response:'nominal';noiseC0:number;replicate:number;seed:number;worldSeed:number;panel:'head-motion';mode:number}
export const headCases=()=>{
 const cases:HeadSpec[]=[]
 for(const field of ['peak','offset-peak','ridge','uniform','blank','si-continuous','si-pulse'] as Stage1iField[])
  for(const phaseSeconds of field==='si-pulse'?[5,15]:[0])for(let mode=0;mode<6;mode++)for(let replicate=0;replicate<4;replicate++)
   cases.push({index:cases.length,field,phaseSeconds,radiusMetres:.05,response:'nominal',noiseC0:.001,replicate,seed:960101+replicate,worldSeed:100301+replicate,panel:'head-motion',mode})
 if(cases.length!==192)throw Error('Incorrect head-motion design')
 return cases
}
export function headConfig(spec:HeadSpec):SimulationConfig{
 const c=buildStage1iConfig(spec.field),p=c.localInletSampling!,a=c.physicalAtmosphere!
 c.seed=spec.worldSeed;c.durationSeconds=900;c.checkpointSeconds=[900];c.sensorNoise=spec.noiseC0
 a.measurement.noiseKgPerCubicMetre=spec.noiseC0*a.measurement.concentrationScaleKgPerCubicMetre
 if(a.pulse)a.pulse.phaseSeconds=spec.phaseSeconds
 p.inspection.settlingSeconds=tubeTransportSeconds(p.tubeLengthMetres,p.tubeInnerDiameterMetres,p.flowLitresPerMinutePerChannel)-Math.log(.05)*Math.max(p.riseTimeConstantSeconds,p.recoveryTimeConstantSeconds)+p.averagingSeconds
 p.inspection.dwellSeconds=Math.ceil(p.inspection.settlingSeconds)+4
 p.inspection.maximumPairSeparationSeconds=2*p.inspection.dwellSeconds+2*p.inspection.offsetNormalized/c.robotSpeed
 c.activeSniffCycleSeconds=p.inspection.dwellSeconds;validateSimulationConfig(c);return c
}
export function headMotion(spec:HeadSpec,visit:number,time:number,arrival:number|null){
 const mode=HEAD_MODES[spec.mode]!
 const age=arrival===null?-1:time-arrival
 const wave=age<0||age>12?0:Math.sin(2*Math.PI*age/mode.periodSeconds)
 const direction=visit*Math.PI/8+spec.replicate*Math.PI/7
 return {offsetMetres:{x:mode.translationMetres*wave*Math.cos(direction),y:mode.translationMetres*wave*Math.sin(direction)},angle:mode.rotationRadians*wave}
}
export function inletPoint(point:Vec2,centre:Vec2,offset:Vec2,angle:number,domain:number):Vec2{
 if(offset.x===0&&offset.y===0&&angle===0)return {...point}
 const x=point.x-centre.x,y=point.y-centre.y,c=Math.cos(angle),s=Math.sin(angle)
 return {x:centre.x+offset.x/domain+c*x-s*y,y:centre.y+offset.y/domain+s*x+c*y}
}
export function syntheticHeadField(field:Stage1iField,p:Vec2,domain:number){
 const x=(p.x-.5)*domain,y=(p.y-.5)*domain
 switch(field){
  case'peak':return .01+Math.exp(-(x*x+y*y)/(.18))
  case'offset-peak':return .01+Math.exp(-((x-.03)**2+(y+.02)**2)/.18)
  case'ridge':return .01+Math.exp(-x*x/.18)
  case'uniform':return 1
  case'blank':return 0
  default:throw Error('Unsupported analytic head field')
 }
}
// Columnar rows: time, visit, body x/y, body heading, head dx/dy (m), head angle,
// four physical inlet x/y pairs, four true inputs C0, four filtered outputs C0,
// four (held) noisy readouts C0. Index definitions are frozen in the protocol.
export type HeadTrace=number[][]
export function runHeadInspection(spec:HeadSpec,unwrapped=false){
 const c=headConfig(spec),engine=new SimulationEngine(c),p=c.localInletSampling!
 const probe=new SIPoseUncertaintyProbe({...engine.environment,sensorNoise:.001},c.robotStartPositionOverride!,c.domainMeters,{positionRadiusMetres:spec.radiusMetres,headingBoundRadians:0,registration:'observed',perturbationSeed:spec.seed,positionErrorStructure:'independent'})
 if(!spec.field.startsWith('si-'))engine.plume.concentrationAt=point=>syntheticHeadField(spec.field,point,c.domainMeters)
 const rawField=engine.plume.concentrationAt.bind(engine.plume)
 const mirrors=Array.from({length:4},()=>new LocalInletChannel(p))
 const trace:HeadTrace=[],actualSamples:any[][]=Array.from({length:17},()=>[])
 let frame=engine.getFrame(),queries:{point:Vec2;value:number}[]=[]
 if(!unwrapped)engine.plume.concentrationAt=(point,time)=>{
  if(time!==frame.time||queries.length>=4)throw Error('Unexpected forward query schedule')
  const motion=headMotion(spec,probe.index,time,probe.visits[probe.index]!.arrivedAt)
  const actual=inletPoint(point,frame.robot.position,motion.offsetMetres,motion.angle,c.domainMeters)
  if(engine.environment.isBlocked(actual,0))throw Error('Moved inlet is obstructed')
  const value=rawField(actual,time);queries.push({point:actual,value});return value
 }
 engine.controller.step=input=>{
  const i=probe.index,visit=probe.visits[i]!,before=visit.samples.length
  const motion=headMotion(spec,i,input.time,visit.arrivedAt)
  if(!unwrapped){
   if(queries.length!==4)throw Error('Four input histories required')
   const filtered=queries.map((q,j)=>mirrors[j]!.update(input.time,q.value))
   const readout=input.measurement.localInletReadings!.map(r=>r.concentration)
   trace.push([input.time,i,input.position.x,input.position.y,input.heading,motion.offsetMetres.x,motion.offsetMetres.y,motion.angle,...queries.flatMap(q=>[q.point.x,q.point.y]),...queries.map(q=>q.value),...filtered,...readout])
  }
  const decision=probe.step(input)
  if(visit.samples.length>before)actualSamples[i]!.push({time:input.time,position:{...input.position},heading:input.heading,measurementConcentration:input.measurement.concentration,localInletReadings:structuredClone(input.measurement.localInletReadings??[])})
  return decision
 }
 while(!engine.isCompleted()&&!probe.result){queries=[];frame=engine.step()}
 if(!probe.result||probe.visits.some(v=>v.closedAt===null||v.samples.length!==5)||frame.metrics.nativeDeclaration||frame.metrics.nativeAbstention)throw Error(`Incomplete head inspection ${spec.index}`)
 const headVisits=structuredClone(probe.visits)
 for(let i=0;i<17;i++)for(const sample of headVisits[i]!.samples){
  const m=headMotion(spec,i,sample.time,headVisits[i]!.arrivedAt)
  sample.x+=m.offsetMetres.x/(p.inspection.offsetNormalized*c.domainMeters)
  sample.y+=m.offsetMetres.y/(p.inspection.offsetNormalized*c.domainMeters)
 }
 return {schemaVersion:'si-head-motion-run-v1',spec,configSha256:sha(json(c)),nominalTargets:probe.nominalTargets,actualTargets:probe.actualTargets,positionOffsetsMetres:probe.positionOffsetsMetres,desiredHeadings:probe.desiredHeadings,headingOffsetsRadians:probe.headingOffsetsRadians,visits:probe.visits,headVisits,actualSamples,result:probe.result,trace,summary:{completedAt:probe.completedAt,stopReason:'inspection-complete',pathLengthMeters:frame.metrics.pathLengthMeters,retainedSamples:85,nativeDeclaration:frame.metrics.nativeDeclaration,nativeAbstention:frame.metrics.nativeAbstention}}
}

export function refineHeadHistory(record:ReturnType<typeof runHeadInspection>,dt:number){
 const spec=record.spec,c=headConfig(spec),p=c.localInletSampling!,engine=new SimulationEngine(c)
 if(!spec.field.startsWith('si-'))engine.plume.concentrationAt=point=>syntheticHeadField(spec.field,point,c.domainMeters)
 const channels=Array.from({length:4},()=>new LocalInletChannel(p)),coarse=record.trace,trace:HeadTrace=[]
 const duration=record.summary.completedAt!,angles=[0,-Math.PI/2,Math.PI,Math.PI/2]
 // This is a prescribed-path integration check, not another autonomous mission.
 for(let tick=0;tick<=Math.round(duration/dt);tick++){
  const t=tick*dt,k=Math.min(Math.floor(t/c.fixedDt),coarse.length-1),a=coarse[k]!,b=coarse[Math.min(k+1,coarse.length-1)]!,f=(t-a[0]!)/c.fixedDt
  const centre={x:a[2]!+f*(b[2]!-a[2]!),y:a[3]!+f*(b[3]!-a[3]!)},dh=Math.atan2(Math.sin(b[4]!-a[4]!),Math.cos(b[4]!-a[4]!)),heading=a[4]!+f*dh
  const visit=a[1]!,motion=headMotion(spec,visit,t,record.visits[visit]!.arrivedAt)
  const points=angles.map(angle=>inletPoint({x:centre.x+.5*p.opposingInletSpacingMetres/c.domainMeters*Math.cos(heading+angle),y:centre.y+.5*p.opposingInletSpacingMetres/c.domainMeters*Math.sin(heading+angle)},centre,motion.offsetMetres,motion.angle,c.domainMeters))
  const inputs=points.map(point=>engine.plume.concentrationAt(point,t)),filtered=inputs.map((value,j)=>channels[j]!.update(t,value))
  trace.push([t,visit,centre.x,centre.y,heading,motion.offsetMetres.x,motion.offsetMetres.y,motion.angle,...points.flatMap(point=>[point.x,point.y]),...inputs,...filtered])
 }
 return {kind:'prescribed-path-integration-refinement',dt,trace}
}
