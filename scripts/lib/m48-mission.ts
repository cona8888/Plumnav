import {makeTransportField,type PlumeCase} from './m47-transport'
import {DelayedFourSensor,inletPositions,type Four,type Point,type Reading} from './m41-spatial-check'
import {M41_REFERENCE} from './m41-development'
import {transientSpatialFit} from './m43-transient-probe'
import {relativeInputCheck} from './m44-relative-check'
import {m42Random} from './m42-noise-probe'
export const M48_ARMS=['wind-cast','gradient-cue','wind-gradient-cue'] as const
export type M48Arm=typeof M48_ARMS[number]
export type MissionCase={kind:PlumeCase;start:Point;noise:number;seed:number;cycles?:number;integrationStep?:number;releaseStep?:number}
const magnitude=(p:Point)=>Math.hypot(p.x,p.y)
const unit=(p:Point):Point=>{const m=magnitude(p);return m?{x:p.x/m,y:p.y/m}:{x:0,y:0}}
export function missionDirection(arm:M48Arm,contact:boolean,cycle:number,cue:Point|null,wind:Point):Point {
  const up=unit({x:-wind.x,y:-wind.y}),cross={x:-up.y,y:up.x}
  const fallback=contact?up:{x:cross.x*(cycle%4<2?1:-1),y:cross.y*(cycle%4<2?1:-1)}
  if(!cue||arm==='wind-cast')return fallback
  if(arm==='gradient-cue')return cue
  const component=cue.x*cross.x+cue.y*cross.y
  return unit({x:up.x+cross.x*component,y:up.y+cross.y*component})
}
/** Shared observation-only peak rule, not a validated source detector. */
export class PeakDeclaration {
  best:{position:Point;value:number;distance:number}|null=null
  drops=0
  update(position:Point,value:number,distance:number):Point|null {
    if(!Number.isFinite(value))throw new RangeError('Invalid concentration')
    if(!this.best||value>this.best.value){this.best={position:{...position},value,distance};this.drops=0;return null}
    this.drops=value<.8*this.best.value?this.drops+1:0
    return this.best.value>.075&&this.drops>=2&&distance-this.best.distance>=.15?{...this.best.position}:null
  }
}
export function runM48Mission(c:MissionCase,arm:M48Arm,options:{confirmation?:'peak'|'revisit'}={}) {
  const cycles=c.cycles??10,dt=c.integrationStep??.1
  if(!Number.isInteger(cycles)||cycles<1||cycles>20||!Number.isFinite(dt)||dt<=0||dt>.1||c.noise<0)
    throw new RangeError('Invalid mission settings')
  const wind={x:.02,y:0},field=makeTransportField(c.kind,{wind,diffusivity:.0005},c.releaseStep??1,cycles*25.1+1)
  const r=M41_REFERENCE,sensor=new DelayedFourSensor({tau:r.tau,delay:r.delay}),rng=m42Random(c.seed^0x85ebca6b)
  let time=0,position={...c.start},distance=0,readouts=0,contacts=0,wasHit=false
  let declared:Point|null=null
  const detector=new PeakDeclaration(),trace:{cycle:number;time:number;position:Point;value:number;cueAccepted:boolean;
    cue:Point|null;navigation:Point;distance:number;declared:Point|null}[]=[]
  const confirmations:{time:number;candidate:Point;peakValue:number;first:number|null;second:number|null;
    accepted:boolean;reason:string;distance:number}[]=[]
  const maximumSeconds=cycles*25.1,maximumReadouts=cycles*24,maximumDistance=cycles*.11
  // Same local averaging geometry as M41–47. Truth remains inside this world.
  const sample=(p:Point,t:number):Four=>inletPositions(p,0,r.spacing).map(m=>{
    const f=r.footprint
    return [m,{x:m.x+f,y:m.y},{x:m.x-f,y:m.y},{x:m.x,y:m.y+f},{x:m.x,y:m.y-f}]
      .reduce((sum,q)=>sum+field.evaluate(q,t).concentration,0)/5
  }) as Four
  sensor.advance(0,sample(position,0))
  const advance=(duration:number,end:Point)=>{
    const start={...position},t0=time,n=Math.ceil(duration/dt)
    let values:Four=[0,0,0,0]
    for(let i=1;i<=n;i++){
      const p={x:start.x+(end.x-start.x)*i/n,y:start.y+(end.y-start.y)*i/n}
      values=sensor.advance(t0+duration*i/n,sample(p,t0+duration*i/n))
    }
    time=t0+duration;distance+=Math.hypot(end.x-start.x,end.y-start.y);position={...end};return values
  }
  const dwell=()=>{
    const rs:Reading[]=[]
    for(let i=0;i<12;i++){
      const values=advance(1,position).map(x=>x+c.noise*Math.sqrt(-2*Math.log(rng()))*Math.cos(2*Math.PI*rng())) as Four
      readouts++;const hit=values.reduce((s,x)=>s+x,0)/4>.075
      if(hit&&!wasHit)contacts++;wasHit=hit
      rs.push({time,position:{...position},heading:0,values})
    }
    return rs
  }
  // Known survey box, independent of truth. Clipping consumes the scheduled
  // movement duration but only actual path length contributes to distance.
  const move=(d:Point,length:number,seconds:number)=>advance(seconds,{
    x:Math.max(-.3,Math.min(1.2,position.x+d.x*length)),y:Math.max(-.5,Math.min(.5,position.y+d.y*length))})
  for(let cycle=0;cycle<cycles;cycle++){
    if(time+25.1>maximumSeconds+1e-8||readouts+24>maximumReadouts||distance+.11>maximumDistance+1e-8)break
    const rs=dwell(),f=transientSpatialFit(rs,r.spacing,r.minimumContrast,c.noise,r.tau,r.delay)
    // All arms execute the same observation-based probe policy, even if the
    // navigation arm subsequently ignores the cue. This isolates cue use.
    const probe=f.fit.direction&&f.fit.trainingResidual<=r.tolerance?f.fit.direction:{x:0,y:0}
    move(probe,.01,.1);const movedAt=time,terminal=dwell()
    const check=relativeInputCheck(f.fit,terminal,f.inputSigma,{spacing:r.spacing,minimumContrast:r.minimumContrast,
      noise:c.noise,tau:r.tau,delay:r.delay,movedAt})
    const value=terminal.slice(-4).reduce((s,o)=>s+o.values.reduce((a,b)=>a+b,0)/4,0)/4
    const cue=check.check.accepted?f.fit.direction:null
    declared=detector.update(position,value,distance)
    if(declared&&options.confirmation==='revisit'){
      const candidate={...declared},peakValue=detector.best!.value
      const travel=Math.hypot(candidate.x-position.x,candidate.y-position.y),seconds=travel/.1
      declared=null
      if(time+seconds+24>maximumSeconds+1e-8||readouts+24>maximumReadouts||distance+travel>maximumDistance+1e-8){
        confirmations.push({time,candidate,peakValue,first:null,second:null,accepted:false,reason:'insufficient-budget',distance})
      }else{
        if(seconds>1e-12)advance(seconds,candidate)
        const mean=(rs:Reading[])=>rs.slice(-4).reduce((s,o)=>s+o.values.reduce((a,b)=>a+b,0)/4,0)/4
        const first=mean(dwell()),second=mean(dwell())
        const accepted=Math.min(first,second)>.075&&Math.min(first,second)>=.8*peakValue&&
          Math.abs(second-first)<=.1*Math.max(first,second)
        confirmations.push({time,candidate,peakValue,first,second,accepted,
          reason:accepted?'persistent-peak':'peak-not-persistent',distance})
        if(accepted)declared=candidate
      }
      detector.best=null;detector.drops=0
    }
    const navigation=missionDirection(arm,value>.075,cycle,cue,wind)
    trace.push({cycle,time,position:{...position},value,cueAccepted:check.check.accepted,cue,navigation,distance,declared})
    if(declared)break
    if(time+1<=maximumSeconds+1e-8&&distance+.1<=maximumDistance+1e-8)move(navigation,.1,1)
  }
  const emitting=c.kind==='steady-release',error=declared?magnitude(declared):null
  return {case:c,arm,trace,confirmations,declared,localizationError:error,success:emitting&&error!==null&&error<=.015,
    falseDeclaration:declared!==null&&(!emitting||error!>.015),
    stoppedSourceDeclaration:c.kind==='interrupted-release'&&declared!==null,
    elapsedSeconds:time,distanceMetres:distance,readoutCount:readouts,plumeContacts:contacts,
    bestObservedPosition:detector.best?.position??null,finalPosition:position,
    maximumSeconds:cycles*25.1,localizationTolerance:.015,
    purpose:'Controlled mission development; heuristic declaration and simplified transport, not outdoor GSL validation'}
}
