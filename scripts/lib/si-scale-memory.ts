import {SimulationEngine} from '../../src/sim/engine'
import {validateSimulationConfig} from '../../src/sim/config'
import {LocalInletChannel} from '../../src/sim/localInletSampling'
import {SeededRandom} from '../../src/sim/rng'
import {headConfig,runHeadInspection,syntheticHeadField,type HeadSpec} from './si-head-motion'
import type {SimulationConfig} from '../../src/sim/types'

export type ScaleMemorySpec={index:number;field:HeadSpec['field'];replicate:number;seed:number;worldSeed:number;variant:string;lengthScale:number;timeScale:number;firstReadout:number;wind:number}
export const MESHES=[1/64,1/128,1/256]
export function scaleMemoryCases(){
 const out:ScaleMemorySpec[]=[]
 for(const field of ['peak','ridge','blank','si-continuous','si-pulse'] as const)for(let replicate=0;replicate<2;replicate++){
  const variants=[['reference',1,1,8,.02],['similar-small',.5,.25,8,.02],['similar-large',2,4,8,.02],['similar-slow',1,2,8,.02],['settle-12',1,1,12,.02],['settle-16',1,1,16,.02],...(field.startsWith('si-')?[['wind-0.1',1,1,8,.1]]:[])]
  for(const [variant,lengthScale,timeScale,firstReadout,wind] of variants)out.push({index:out.length,field,replicate,seed:980101+replicate,worldSeed:102301+replicate,variant:variant as string,lengthScale:lengthScale as number,timeScale:timeScale as number,firstReadout:firstReadout as number,wind:wind as number})
 }
 if(out.length!==64)throw Error('Scale/memory design count')
 return out
}
export function baseSpec(s:ScaleMemorySpec):HeadSpec{return {index:0,field:s.field,phaseSeconds:s.field==='si-pulse'?5:0,radiusMetres:.05,response:'nominal',noiseC0:.001,replicate:s.replicate,seed:s.seed,worldSeed:s.worldSeed,panel:'head-motion',mode:0}}
export function scaleMemoryConfig(s:ScaleMemorySpec):SimulationConfig{
 const c=headConfig(baseSpec(s)),p=c.localInletSampling!,a=c.physicalAtmosphere!,l=s.lengthScale,b=s.timeScale,extra=s.firstReadout-8
 if(![l,b].every(v=>Number.isFinite(v)&&v>0)||![0,4,8].includes(extra))throw Error('Invalid scale/memory inputs')
 c.domainMeters*=l;c.robotSpeed/=b;c.durationSeconds*=b;c.checkpointSeconds=c.checkpointSeconds.map(t=>t*b);c.fixedDt*=b
 for(const k of ['opposingInletSpacingMetres','inletHeightMetres','robotLengthMetres','robotWidthMetres','tubeLengthMetres','tubeInnerDiameterMetres'] as const)p[k]*=l
 p.referenceWindMetresPerSecond=s.wind*l/b;p.flowLitresPerMinutePerChannel*=l**3/b
 for(const k of ['riseTimeConstantSeconds','recoveryTimeConstantSeconds','averagingSeconds','sampleIntervalSeconds'] as const)p[k]*=b
 p.maximumTurnRateRadiansPerSecond/=b;c.sensorLag*=b
 const q=p.inspection;q.settlingSeconds=(q.settlingSeconds+extra)*b;q.dwellSeconds=(12+extra)*b;q.sampleSpacingSeconds*=b
 q.maximumPairSeparationSeconds=2*q.dwellSeconds+2*q.offsetNormalized/c.robotSpeed;c.activeSniffCycleSeconds=q.dwellSeconds
 a.diffusivityMetresSquaredPerSecond*=l*l/b;p.effectiveDiffusivityMetresSquaredPerSecond=a.diffusivityMetresSquaredPerSecond
 a.sourceWidthMetres*=l;a.releaseHeightMetres*=l;a.emissionRateKgPerSecond*=l**3/b
 a.sourceAgeAtMissionStartSeconds*=b;a.quadraturePanelSeconds*=b
 if(a.pulse){a.pulse.periodSeconds*=b;a.pulse.phaseSeconds*=b}
 validateSimulationConfig(c);return c
}
export function scaleMemoryGroups(c:SimulationConfig,s:ScaleMemorySpec){
 const p=c.localInletSampling!,a=c.physicalAtmosphere!,ell=.15*s.lengthScale,u=p.referenceWindMetresPerSecond,T=ell/u
 const flow=p.flowLitresPerMinutePerChannel/60000,delay=Math.PI*(p.tubeInnerDiameterMetres/2)**2*p.tubeLengthMetres/flow
 return {featureMetres:ell,timeScaleSeconds:T,groups:{peclet:u*ell/a.diffusivityMetresSquaredPerSecond,domain:c.domainMeters/ell,
  sourceWidth:a.sourceWidthMetres/ell,releaseHeight:a.releaseHeightMetres/ell,head:p.opposingInletSpacingMetres/ell,height:p.inletHeightMetres/ell,
  robotLength:p.robotLengthMetres/ell,robotWidth:p.robotWidthMetres/ell,tubeLength:p.tubeLengthMetres/ell,tubeDiameter:p.tubeInnerDiameterMetres/ell,
  robotToWind:c.robotSpeed*c.domainMeters/u,turnRate:p.maximumTurnRateRadiansPerSecond*T,pump:flow/(u*ell**2),
  sourceStrength:a.emissionRateKgPerSecond/(a.measurement.concentrationScaleKgPerCubicMetre*u*ell**2),
  delay:delay/T,rise:p.riseTimeConstantSeconds/T,recovery:p.recoveryTimeConstantSeconds/T,averaging:p.averagingSeconds/T,sampling:p.sampleIntervalSeconds/T,
  settling:p.inspection.settlingSeconds/T,dwell:p.inspection.dwellSeconds/T,offset:p.inspection.offsetNormalized*c.domainMeters/ell,
  baseNavigationDt:c.fixedDt/T,quadraturePanel:a.quadraturePanelSeconds/T,sourceAge:a.sourceAgeAtMissionStartSeconds/T,
  pulsePeriod:(a.pulse?.periodSeconds??0)/T,pulsePhase:(a.pulse?.phaseSeconds??0)/T,pulseDuty:a.pulse?.dutyFraction??0,
  firstReadout:s.firstReadout*s.timeScale/T,waypointError:.05*s.lengthScale/ell,poseError:.001*s.lengthScale/ell,
  noise:c.sensorNoise,threshold:a.measurement.thresholdKgPerCubicMetre/a.measurement.concentrationScaleKgPerCubicMetre,saturation:c.sensorSaturation}}
}
export type BaseRecord=ReturnType<typeof runHeadInspection>
export function mappedBaseTime(referenceTime:number,base:BaseRecord,extra:number){
 for(let i=0;i<17;i++){
  const v=base.visits[i]!,arrival=v.arrivedAt!+i*extra,closed=v.closedAt!+(i+1)*extra
  if(referenceTime<=closed){if(referenceTime<arrival)return referenceTime-i*extra;return v.arrivedAt!+Math.min(referenceTime-arrival,12)}
 }
 return base.summary.completedAt!
}
export function runScaleMemoryHistory(base:BaseRecord,s:ScaleMemorySpec,referenceDt:number){
 const c=scaleMemoryConfig(s),p=c.localInletSampling!,engine=new SimulationEngine(c),extra=s.firstReadout-8,b=s.timeScale
 if(!s.field.startsWith('si-'))engine.plume.concentrationAt=point=>syntheticHeadField(s.field,point,100)
 const durationReference=base.summary.completedAt!+17*extra,duration=durationReference*b,dt=referenceDt*b
 const trace:number[][]=[],channels=Array.from({length:4},()=>new LocalInletChannel(p)),angles=[0,-Math.PI/2,Math.PI,Math.PI/2]
 for(let tick=0;tick<=Math.round(durationReference/referenceDt);tick++){
  const referenceTime=tick*referenceDt,t=referenceTime*b,originalTime=mappedBaseTime(referenceTime,base,extra)
  const k=Math.min(Math.floor(originalTime/.0625),base.trace.length-1),a=base.trace[k]!,z=base.trace[Math.min(k+1,base.trace.length-1)]!,fraction=(originalTime-a[0]!)/.0625
  const x=a[2]!+fraction*(z[2]!-a[2]!),y=a[3]!+fraction*(z[3]!-a[3]!),heading=a[4]!+fraction*Math.atan2(Math.sin(z[4]!-a[4]!),Math.cos(z[4]!-a[4]!))
  const points=angles.map(angle=>({x:x+p.opposingInletSpacingMetres/(2*c.domainMeters)*Math.cos(heading+angle),y:y+p.opposingInletSpacingMetres/(2*c.domainMeters)*Math.sin(heading+angle)}))
  const inputs=points.map(point=>engine.plume.concentrationAt(point,t)),filtered=inputs.map((value,j)=>channels[j]!.update(t,value))
  trace.push([t,a[1]!,x,y,heading,0,0,0,...points.flatMap(point=>[point.x,point.y]),...inputs,...filtered])
 }
 // A separate hardware-clock noise stream, independent of integration tick count.
 // Four Gaussian draws at each physical readout, including t=0; no wind draws.
 const rng=new SeededRandom(s.worldSeed+2000000),readoutNoise=Array.from({length:Math.round(durationReference)+1},()=>Array.from({length:4},()=>rng.normal(0,c.sensorNoise)))
 const visits=structuredClone(base.visits)
 for(let i=0;i<17;i++){
  const v=visits[i]!,arrival=base.visits[i]!.arrivedAt!+i*extra;v.arrivedAt=arrival*b;v.closedAt=(arrival+12+extra)*b
  for(let j=0;j<5;j++){
   const sample=v.samples[j]!,rt=arrival+s.firstReadout+j,values=trace[Math.round(rt/referenceDt)]!.slice(20,24).map((v,k)=>Math.max(0,Math.min(c.sensorSaturation,v+readoutNoise[Math.round(rt)]![k]!)))
   sample.time=rt*b;sample.value=values.reduce((a,v)=>a+v,0)/4;sample.clipped=values.some(v=>v>=c.sensorSaturation-1e-9);sample.hit=sample.value>=.115;sample.telemetryComplete=true
  }
 }
 const motionContract={version:'continuous-stationary-head-v1',basis:'prescribed-numerical-constraint',scope:'continuous-head-centre-and-orientation',windows:visits.map((v,visit)=>({visit,start:v.arrivedAt!,end:v.closedAt!,translationDiameterMetres:0,orientationSpanRadians:0}))}
 return {schemaVersion:'si-scale-memory-history-v1',dt,referenceDt,trace,readoutNoise,visits,motionContract,summary:{completedAt:duration,pathLengthMetres:base.summary.pathLengthMeters*s.lengthScale,airLitres:4*p.flowLitresPerMinutePerChannel*duration/60,retainedSamples:85,nativeDeclaration:false,nativeAbstention:false}}
}
