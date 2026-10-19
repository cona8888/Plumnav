import type {AlgorithmDecision,AlgorithmEnvironment,AlgorithmStepInput,Vec2} from '../../src/sim/types'
import {SeededRandom} from '../../src/sim/rng'
import {evaluateIntegrityVisits,SIClockedIntegrityProbe} from './si-clocked-integrity-probe'

export type SIPoseUncertaintySpec={positionRadiusMetres:number;headingBoundRadians:number;registration:'observed'|'commanded';perturbationSeed:number;positionErrorStructure?:'independent'|'constant-bias'}
const angleDifference=(a:number,b:number)=>Math.atan2(Math.sin(a-b),Math.cos(a-b))

/** Research-only waypoint/head perturbation around the 1 mm clocked fixture. */
export class SIPoseUncertaintyProbe extends SIClockedIntegrityProbe{
 readonly nominalTargets:Vec2[];readonly actualTargets:Vec2[];readonly desiredHeadings:number[];readonly positionOffsetsMetres:Vec2[];readonly headingOffsetsRadians:number[]
 private readonly h:number;private readonly effectiveRadius:number;private readonly verifierNoise:number
 constructor(environment:AlgorithmEnvironment,private readonly candidatePoint:Vec2,domainMetres:number,readonly uncertainty:SIPoseUncertaintySpec){
  if(!environment.inspectionContract||domainMetres<=0||uncertainty.positionRadiusMetres<0||uncertainty.headingBoundRadians<0)throw Error('Invalid pose uncertainty fixture')
  const effectiveRadius=.001/domainMetres,effective={...environment,inspectionContract:{...environment.inspectionContract,arrivalRadiusNormalized:effectiveRadius}}
  super(effective,candidatePoint);this.h=effective.inspectionContract!.offsetNormalized;this.effectiveRadius=effectiveRadius;this.verifierNoise=effective.sensorNoise
  this.nominalTargets=this.visits.map(v=>({...v.target}));const rng=new SeededRandom(uncertainty.perturbationSeed)
  const offset=()=>{const radius=uncertainty.positionRadiusMetres*Math.sqrt(rng.next()),angle=2*Math.PI*rng.next();return {x:radius*Math.cos(angle),y:radius*Math.sin(angle)}}
  const common=uncertainty.positionErrorStructure==='constant-bias'?offset():null
  this.positionOffsetsMetres=this.visits.map(()=>common?{...common}:offset())
  this.headingOffsetsRadians=this.visits.map(()=>(2*rng.next()-1)*uncertainty.headingBoundRadians)
  this.actualTargets=this.nominalTargets.map((target,i)=>({x:target.x+this.positionOffsetsMetres[i]!.x/domainMetres,y:target.y+this.positionOffsetsMetres[i]!.y/domainMetres}))
  this.visits.forEach((visit,i)=>visit.target={...this.actualTargets[i]!})
  this.desiredHeadings=this.nominalTargets.map((target,i)=>(i===0?0:Math.atan2(target.y-this.nominalTargets[i-1]!.y,target.x-this.nominalTargets[i-1]!.x))+this.headingOffsetsRadians[i]!)
 }
 override step(input:AlgorithmStepInput):AlgorithmDecision{
  if(!this.result){const visit=this.visits[this.index]!,dx=visit.target.x-input.position.x,dy=visit.target.y-input.position.y
   if(Math.hypot(dx,dy)<=this.effectiveRadius&&visit.arrivedAt===null){const desired=this.desiredHeadings[this.index]!,error=angleDifference(desired,input.heading)
    if(Math.abs(error)>1e-12)return {direction:{x:Math.cos(desired),y:Math.sin(desired)},speedScale:0,estimate:null,confidence:0,phase:'SI POSE ORIENTATION'}
   }
  }
  const visitIndex=this.index,visit=this.visits[visitIndex],before=visit?.samples.length??0,decision=super.step(input)
  if(visit&&visit.samples.length>before&&this.uncertainty.registration==='commanded'){
   const nominal=this.nominalTargets[visitIndex]!,sample=visit.samples.at(-1)!
   sample.x=(nominal.x-this.candidatePoint.x)/this.h;sample.y=(nominal.y-this.candidatePoint.y)/this.h
   if(this.result)this.result=evaluateIntegrityVisits(this.visits,this.verifierNoise)
  }
  return decision
 }
}
