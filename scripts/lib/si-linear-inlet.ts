import {tubeTransportSeconds} from '../../src/sim/physicalDesign'
import type {LocalInletSamplingConfig} from '../../src/sim/types'

type Segment={start:number;end:number;initial:number;input:number;slope:number;tau:number}
// Stable integrals of 1-exp(-z); avoid cancellation on very short segments.
function phi(z:number){
 const r=-Math.expm1(-z)
 if(z<.01){
  let term=z*z/2,p2=term,p3=z*term/3
  for(let k=3;k<=12;k++){term*=-z/k;p2+=term;p3+=z*term/(k+1)}
  return {r,p2,p3}
 }
 const p2=z-r;return {r,p2,p3:z*z/2-p2}
}
export function linearResponse(initial:number,input:number,slope:number,tau:number,duration:number){
 const {r,p2,p3}=phi(duration/tau),delta=input-initial
 return {state:initial+delta*r+slope*tau*p2,area:initial*duration+delta*tau*p2+slope*tau*tau*p3}
}
function segmentArea(s:Segment,a:number,b:number){
 const offset=a-s.start,y=linearResponse(s.initial,s.input,s.slope,s.tau,offset).state
 return linearResponse(y,s.input+s.slope*offset,s.slope,s.tau,b-a).area
}

/** Research-only continuous-input reference. No future update can affect an
 * already emitted value. Clean prehistory; initial input jumps at its delayed
 * timestamp; subsequent inlet samples are joined linearly, without extrapolation.
 * The asymmetric ODE is integrated exactly, splitting at input/state crossings.
 */
export class LinearInletChannel{
 private inputs:Array<{time:number;value:number}>=[]
 private segments:Segment[]=[]
 private state=0;private time=0;private lastInput=-Infinity
 readonly delay:number
 constructor(private readonly settings:LocalInletSamplingConfig){
  if(![settings.riseTimeConstantSeconds,settings.recoveryTimeConstantSeconds].every(v=>Number.isFinite(v)&&v>0)||!Number.isFinite(settings.averagingSeconds)||settings.averagingSeconds<0)throw Error('Invalid linear inlet settings')
  this.delay=tubeTransportSeconds(settings.tubeLengthMetres,settings.tubeInnerDiameterMetres,settings.flowLitresPerMinutePerChannel)
  if(!Number.isFinite(this.delay)||this.delay<0)throw Error('Invalid tube delay')
 }
 private integrate(end:number,input:number,slope:number){
  const length=end-this.time;if(length<=0)return
  const difference=input-this.state,tau=difference>0||(difference===0&&slope>=0)?this.settings.riseTimeConstantSeconds:this.settings.recoveryTimeConstantSeconds
  const crossing=difference*slope<0?tau*Math.log1p(-difference/(slope*tau)):Infinity
  const first=Math.min(length,crossing),segment:Segment={start:this.time,end:this.time+first,initial:this.state,input,slope,tau}
  if(first<=0||!Number.isFinite(first))throw Error('Unresolved response interval')
  this.state=linearResponse(this.state,input,slope,tau,first).state;this.segments.push(segment);this.time=segment.end
  if(crossing<length){
   // At this analytically located crossing input==state; then slope fixes sign.
   const at=input+slope*crossing;this.state=at
   const nextTau=slope>=0?this.settings.riseTimeConstantSeconds:this.settings.recoveryTimeConstantSeconds
   const rest:Segment={start:this.time,end,initial:at,input:at,slope,tau:nextTau}
   this.state=linearResponse(at,at,slope,nextTau,end-this.time).state;this.segments.push(rest);this.time=end
  }else this.time=end
  if(!Number.isFinite(this.state)||this.state<0)throw Error('Nonphysical response state')
 }
 update(time:number,concentration:number){
  if(!Number.isFinite(time)||time<0||time<=this.lastInput||!Number.isFinite(concentration)||concentration<0)throw Error('Invalid linear inlet history')
  this.lastInput=time;this.inputs.push({time:time+this.delay,value:concentration})
  while(this.time<time){
   while(this.inputs.length>1&&this.inputs[1]!.time<=this.time)this.inputs.shift()
   const a=this.inputs[0]!
   if(this.time<a.time){this.integrate(Math.min(time,a.time),0,0);continue}
   const b=this.inputs[1];if(!b)throw Error('Future inlet sample required; extrapolation forbidden')
   const slope=(b.value-a.value)/(b.time-a.time),input=a.value+slope*(this.time-a.time)
   this.integrate(Math.min(time,b.time),input,slope)
  }
  const window=this.settings.averagingSeconds,cutoff=time-window
  while(this.segments.length&&this.segments[0]!.end<=cutoff)this.segments.shift()
  if(window===0)return this.state
  return this.segments.reduce((sum,s)=>sum+segmentArea(s,Math.max(cutoff,s.start),s.end),0)/window
 }
}
