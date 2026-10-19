import {add,distance,dot,normalize,scale,sub} from '../math'
import type {AlgorithmDecision,AlgorithmEnvironment,AlgorithmStepInput,Vec2} from '../types'
import {inspectionAttemptBudget} from './physicalCandidateLifecycle'
type Scan={time:number;position:Vec2;concentration:number;direction?:Vec2;usableDirection?:boolean}
type Visit={target:Vec2;arrivedAt:number|null;samples:Array<{time:number;value:number;hit:boolean}>}
export type LocalMaximumResult={candidate:Vec2;startedAt:number;completedAt:number;status:'supported'|'rejected';
  reason:string;medians:number[];differences:number[];margin:number;visits:Visit[]}
const median=(a:number[])=>{const b=[...a].sort((x,y)=>x-y);return b.length?b[Math.floor(b.length/2)]!:NaN}

/** Finite cross-pattern contrast witness, NOT source location or proof of a
 * continuous/global maximum. Each flank is bracketed by fresh core revisits.
 */
export function evaluateLocalMaximumVisits(visits:Visit[],noise:number,minimumSamples:number) {
  const medians=visits.map(v=>median(v.samples.map(s=>s.value))),margin=3*noise
  const complete=visits.length===9&&visits.every(v=>v.samples.length>=minimumSamples)
  const differences=[1,3,5,7].map(i=>Math.min(medians[i-1]??NaN,medians[i+1]??NaN)-(medians[i]??NaN))
  const stable=[1,3,5,7].every(i=>Math.abs(medians[i-1]!-medians[i+1]!)<=Math.max(margin,.05*Math.min(medians[i-1]!,medians[i+1]!)))
  const coreSignal=[0,2,4,6,8].every(i=>medians[i]!>=.16&&visits[i]?.samples.filter(s=>s.hit).length!>=minimumSamples)
  return {supported:complete&&coreSignal&&stable&&differences.every(d=>d>margin),medians,differences,margin,
    gates:{complete,coreSignal,stable,allFourFlanksLower:differences.every(d=>d>margin)}}
}
export class LocalMaximumProbe {
  private history:Scan[]=[]
  private active:{candidate:Vec2;startedAt:number;deadline:number;index:number;visits:Visit[]}|null=null
  private results:LocalMaximumResult[]=[]
  private pendingRecenter:Vec2|null=null
  private nominationReason='not-requested'
  constructor(private environment:AlgorithmEnvironment,private flankOrder:readonly number[]=[0,1,2,3]) {
    if(flankOrder.length!==4||[...flankOrder].sort().join(',')!=='0,1,2,3')throw new Error('Probe order must permute all four flanks')
    this.flankOrder=[...flankOrder]
  }
  observeScan(input:AlgorithmStepInput,concentration:number,validDirection:boolean,fullSupport:boolean,direction?:Vec2,usableDirection=validDirection) {
    if(this.active||this.results.some(r=>r.status==='supported')||this.results.length>=2)return
    if(!fullSupport){this.history=[];return}
    this.history.push({time:input.time,position:{...input.position},concentration,
      ...(this.environment.localMaximum?.nomination?{...(direction?{direction:{...direction}}:{}),usableDirection}:{})})
    this.history=this.history.filter(s=>s.time>=input.time-75).slice(-3)
    const [a,b,c]=this.history,margin=3*this.environment.sensorNoise,h=2*this.environment.activeSniffReach
    if(this.environment.localMaximum?.nomination) {
      const persistent=Boolean(a&&b&&c&&c.time-a.time>=2*this.environment.activeSniffCycleSeconds&&this.history.every(s=>s.concentration>=.16))
      const reversal=Boolean(b?.usableDirection&&c?.usableDirection&&b.direction&&c.direction&&dot(b.direction,c.direction)<=0)
      if(persistent&&(!usableDirection||reversal)) {
        this.nominationReason=!usableDirection?'persistent-signal-unreliable-direction':'persistent-signal-direction-reversal'
        this.start(input);this.history=[]
      }
      return
    }
    if(validDirection||!a||!b||!c||concentration<.16||distance(a.position,b.position)<h/2||distance(b.position,c.position)<h/2||
      b.concentration<a.concentration-margin||c.concentration<b.concentration-margin||c.concentration-a.concentration<=margin)return
    this.start(input)
    this.history=[]
  }
  /** Candidate comes from the current sensed pose, never a fictitious ray. */
  start(input:AlgorithmStepInput,candidate:Vec2=input.position) {
    if(this.active||this.results.length>=2||this.results.some(r=>r.status==='supported'))return
    const e=this.environment,c=e.inspectionContract!,h=c.offsetNormalized,p={...candidate}
    const offsets=[{x:h,y:0},{x:-h,y:0},{x:0,y:h},{x:0,y:-h}]
    const targets=[p,...this.flankOrder.flatMap(i=>[add(p,offsets[i]!),p])]
    const visits=targets.map(target=>({target:{...target},arrivedAt:null,samples:[]} as Visit))
    const budget=inspectionAttemptBudget(input.position,targets,c,e.maxSpeed,e.candidateLifecycle!.maximumTurnRateRadiansPerSecond,input.dt)
    // Check every segment, rather than silently skipping a blocked direction.
    const blocked=targets.some((target,i)=>Array.from({length:17},(_,k)=>add(i?targets[i-1]!:input.position,
      scale(sub(target,i?targets[i-1]!:input.position),k/16))).some(q=>e.isBlocked(q)))
    this.active={candidate:p,startedAt:input.time,deadline:input.time+budget.totalSeconds,index:0,visits}
    if(blocked||input.time+budget.totalSeconds>e.durationSeconds)this.finish(input.time,blocked?'blocked-pattern':'insufficient-mission-budget',false)
  }
  private finish(time:number,reason:string,evaluate=true) {
    const a=this.active!,e=this.environment
    const check=evaluateLocalMaximumVisits(a.visits,e.sensorNoise,e.inspectionContract!.minimumSamplesPerWaypoint)
    this.results.push({candidate:a.candidate,startedAt:a.startedAt,completedAt:time,status:evaluate&&check.supported?'supported':'rejected',
      reason:evaluate?check.supported?'fresh-four-flank-contrast':'contrast-or-stationarity-failed':reason,
      medians:check.medians,differences:check.differences,margin:check.margin,visits:a.visits})
    this.active=null
    if(e.localMaximum?.recentering&&evaluate&&!check.supported&&this.results.length<2&&
      check.gates.complete&&check.gates.coreSignal&&check.gates.stable) {
      const flanks=[1,3,5,7].map(i=>({i,gain:check.medians[i]!-Math.max(check.medians[i-1]!,check.medians[i+1]!)}))
        .sort((x,y)=>y.gain-x.gain)
      if(flanks[0]!.gain>0) {
        // Positive observed gain only proposes a test. It is not significant
        // evidence or acceptance; the next entire circuit must be fresh.
        this.pendingRecenter=add(a.candidate,scale(sub(a.visits[flanks[0]!.i]!.target,a.candidate),.5))
      }
    }
  }
  step(input:AlgorithmStepInput):AlgorithmDecision|null {
    const stopped=(phase:string):AlgorithmDecision=>({direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase,
      debug:{note:'Historical local contrast witness only; not a leak-source or no-leak declaration.'}})
    if(this.results.some(r=>r.status==='supported'))return stopped('LOCAL HOTSPOT SUPPORTED; HOLD')
    if(!this.active&&this.pendingRecenter) {
      const target=this.pendingRecenter;this.pendingRecenter=null
      this.nominationReason='higher-flank-half-step-proposal'
      this.start(input,target)
    }
    const a=this.active;if(!a)return null
    if(input.time>a.deadline){this.finish(input.time,'timed-out',false);return stopped('LOCAL HOTSPOT PROBE TIMEOUT')}
    const c=this.environment.inspectionContract!,v=a.visits[a.index]!
    const remaining=distance(input.position,v.target)
    if(remaining>c.arrivalRadiusNormalized) {
      // Leaving a dwell invalidates its unfinished samples and settling clock.
      v.arrivedAt=null;v.samples=[]
      return {direction:normalize(sub(v.target,input.position)),speedScale:Math.min(.46,remaining/(this.environment.maxSpeed*input.dt)),
        estimate:null,confidence:0,phase:'LOCAL HOTSPOT PROBE MOVE',debug:{target:{...v.target}}}
    }
    v.arrivedAt??=input.time
    const m=input.measurement,last=v.samples.at(-1)?.time??-Infinity
    if(input.time>=v.arrivedAt+c.settlingSeconds&&m.valid&&m.sampleMode==='passive'&&
      m.concentration<this.environment.localMaximum!.sensorSaturation-1e-9&&input.time-last>=c.sampleSpacingSeconds)
      v.samples.push({time:input.time,value:m.concentration,hit:m.hit})
    if(input.time-v.arrivedAt>=c.dwellSeconds&&v.samples.length>=c.minimumSamplesPerWaypoint) {
      a.index++
      if(a.index===a.visits.length){this.finish(input.time,'completed');return stopped(this.results.at(-1)!.status==='supported'?'LOCAL HOTSPOT SUPPORTED; HOLD':'LOCAL HOTSPOT NOT SUPPORTED; REACQUIRE')}
    }
    return stopped('LOCAL HOTSPOT PROBE DWELL')
  }
  hasActiveAttempt(){return this.active!==null}
  snapshot(){return structuredClone({history:this.history,active:this.active,results:this.results,
    ...(this.environment.localMaximum?.nomination||this.environment.localMaximum?.recentering?
      {pendingRecenter:this.pendingRecenter,nominationReason:this.nominationReason}:{})})}
}
