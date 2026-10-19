import type {AlgorithmEnvironment,AlgorithmStepInput,AlgorithmDecision,Vec2} from '../../src/sim/types'
export type IntegritySample={time:number;value:number;hit:boolean;x:number;y:number;clipped:boolean;telemetryComplete:boolean}
export type IntegrityVisit={target:Vec2;arrivedAt:number|null;closedAt:number|null;samples:IntegritySample[]}
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)]??NaN
export function linearSolve(a:number[][],b:number[]){const m=a.map((r,i)=>[...r,b[i]!]);for(let k=0;k<b.length;k++){let p=k;for(let i=k+1;i<b.length;i++)if(Math.abs(m[i]![k]!)>Math.abs(m[p]![k]!))p=i;if(Math.abs(m[p]![k]!)<1e-12)return null;[m[k],m[p]]=[m[p]!,m[k]!];const d=m[k]![k]!;for(let j=k;j<=b.length;j++)m[k]![j]!/=d;for(let i=0;i<b.length;i++)if(i!==k){const f=m[i]![k]!;for(let j=k;j<=b.length;j++)m[i]![j]!-=f*m[k]![j]!}}return m.map(r=>r[b.length]!)}
export function evaluateIntegrityVisits(visits:IntegrityVisit[],noise:number,minimum=2){
 const margin=3*noise,medians=visits.map(v=>median(v.samples.map(s=>s.value)))
 const complete=visits.length===17&&visits.every(v=>v.closedAt!==null&&v.samples.length>=minimum)
 const telemetry=visits.every(v=>v.samples.every(s=>s.telemetryComplete)),clipped=visits.some(v=>v.samples.some(s=>s.clipped))
 const core=visits.every((v,i)=>i%2===1||(medians[i]!>=.16&&v.samples.filter(s=>s.hit).length>=minimum))
 const stable=Array.from({length:8},(_,k)=>2*k+1).every(i=>Math.abs(medians[i-1]!-medians[i+1]!)<=Math.max(margin,.05*Math.min(medians[i-1]!,medians[i+1]!)))
 let coefficients:number[]|null=null,rmse:number|null=null,eigenMax:number|null=null,peak:Vec2|null=null
 if(complete){const rows=visits.map(v=>{const x=v.samples.reduce((a,s)=>a+s.x,0)/v.samples.length,y=v.samples.reduce((a,s)=>a+s.y,0)/v.samples.length;return [1,x,y,.5*x*x,x*y,.5*y*y]}),a=Array.from({length:6},(_,i)=>Array.from({length:6},(_,j)=>rows.reduce((sum,r)=>sum+r[i]!*r[j]!,0))),b=Array.from({length:6},(_,i)=>rows.reduce((sum,r,j)=>sum+r[i]!*medians[j]!,0));coefficients=linearSolve(a,b)
  if(coefficients){const c=coefficients;rmse=Math.sqrt(rows.reduce((a,r,i)=>a+(r.reduce((v,x,j)=>v+x*c[j]!,0)-medians[i]!)**2,0)/rows.length);eigenMax=(c[3]!+c[5]!+Math.hypot(c[3]!-c[5]!,2*c[4]!))/2;const det=c[3]!*c[5]!-c[4]!**2;if(Math.abs(det)>1e-12)peak={x:(c[4]!*c[2]!-c[5]!*c[1]!)/det,y:(c[4]!*c[1]!-c[3]!*c[2]!)/det}}
 }
 const reason=!telemetry?'missing-channel-telemetry':clipped?'clipped-required-measurement':!complete?'insufficient-samples':!core?'insufficient-signal':!stable?'temporal-inconsistency':rmse===null||rmse>margin?'spatial-model-mismatch':eigenMax===null||eigenMax>=-2*margin?'not-negative-definite':!peak||Math.hypot(peak.x,peak.y)>1?'maximum-outside-probed-region':'local-quadratic-supported'
 return {status:reason==='local-quadratic-supported'?'supported':'abstained',reason,medians,coefficients,rmse,eigenMax,peak,margin,gates:{complete,telemetry,clipped,core,stable}}
}
/** Versioned research policy: dwell starts on the next hardware-clock edge. */
export class SIClockedIntegrityProbe {
 visits:IntegrityVisit[];index=0;result:ReturnType<typeof evaluateIntegrityVisits>|null=null;completedAt:number|null=null
 constructor(private e:AlgorithmEnvironment,private candidate:Vec2){const h=e.inspectionContract!.offsetNormalized;this.visits=[candidate,...Array.from({length:8},(_,i)=>[{x:candidate.x+h*Math.cos(i*Math.PI/4),y:candidate.y+h*Math.sin(i*Math.PI/4)},candidate]).flat()].map(target=>({target:{...target},arrivedAt:null,closedAt:null,samples:[]}))}
 step(input:AlgorithmStepInput):AlgorithmDecision{
  const stop=(phase:string):AlgorithmDecision=>({direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase})
  if(this.result)return stop('SI INTEGRITY HOLD')
  const c=this.e.inspectionContract!,v=this.visits[this.index]!,dx=v.target.x-input.position.x,dy=v.target.y-input.position.y,d=Math.hypot(dx,dy)
  if(d>c.arrivalRadiusNormalized){v.arrivedAt=null;v.samples=[];if(this.e.isBlocked(v.target))throw Error('Blocked integrity fixture');return {direction:{x:dx/d,y:dy/d},speedScale:Math.min(.46,d/(this.e.maxSpeed*input.dt)),estimate:null,confidence:0,phase:'SI INTEGRITY MOVE'}}
  if(v.arrivedAt===null){const boundary=Math.ceil((input.time-1e-12)/c.sampleSpacingSeconds)*c.sampleSpacingSeconds;if(input.time<boundary-1e-12)return stop('SI CLOCK ALIGNMENT HOLD');v.arrivedAt=boundary}
  const m=input.measurement,last=v.samples.at(-1)?.time??-Infinity
  if(input.time>=v.arrivedAt+c.settlingSeconds&&m.valid&&m.sampleMode==='passive'&&m.time===input.time&&input.time-last>=c.sampleSpacingSeconds){const channels=m.localInletReadings;v.samples.push({time:input.time,value:m.concentration,hit:m.hit,x:(input.position.x-this.candidate.x)/c.offsetNormalized,y:(input.position.y-this.candidate.y)/c.offsetNormalized,clipped:channels?.some(r=>r.saturated)??false,telemetryComplete:channels?.length===4&&new Set(channels.map(r=>r.channel)).size===4&&channels.every(r=>Number.isFinite(r.concentration))})}
  if(input.time-v.arrivedAt>=c.dwellSeconds){v.closedAt=input.time;this.index++;if(this.index===this.visits.length){this.completedAt=input.time;this.result=evaluateIntegrityVisits(this.visits,this.e.sensorNoise,c.minimumSamplesPerWaypoint)}}
  return stop('SI INTEGRITY DWELL')
 }
}
