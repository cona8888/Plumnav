import type {AlgorithmController,AlgorithmEnvironment,AlgorithmStepInput,Measurement} from '../../src/sim/types'

export type SniffPolicy='reference'|'encounter-gated'
export type ScheduleTrace={time:number;eligible:boolean;firstEligibleTime:number|null;latched:boolean;queries:{allowed:boolean;originalResult:boolean|null}[];requestedScanId:number|null}
export function eligibleEncounter(m:Measurement){
 return m.valid&&m.hit&&Number.isFinite(m.concentration)&&m.concentration>=.115&&
  ['passive','quad-passive-return'].includes(m.sampleMode)&&m.localInletReadings?.length===4&&
  new Set(m.localInletReadings.map(r=>r.channel)).size===4&&m.localInletReadings.every(r=>Number.isFinite(r.concentration)&&!r.saturated)||false
}

/** Research-only hook into the frozen scan predicate, BEFORE scan issue.
 * The app class is not edited and issued commands are never discarded.
 * Source hashes and reference-equivalence tests guard this internal interface.
 */
export function schedulingController(base:AlgorithmController,policy:SniffPolicy){
 const trace:ScheduleTrace[]=[];let firstEligibleTime:number|null=null,current:ScheduleTrace|null=null
 if(policy==='encounter-gated'){
  if(base.metadata.id!=='quad-sniff-refine')throw Error('Encounter gate is four-channel-only')
  const hooked=base as unknown as {shouldScan:(input:AlgorithmStepInput)=>boolean;__researchEncounterGate?:boolean}
  if(typeof hooked.shouldScan!=='function'||hooked.__researchEncounterGate)throw Error('Frozen scan hook unavailable/already installed')
  const original=hooked.shouldScan.bind(base);hooked.__researchEncounterGate=true
  hooked.shouldScan=(input)=>{
   if(!current||current.time!==input.time)throw Error('Scan predicate outside causal step')
   const originalResult=firstEligibleTime===null?null:original(input),allowed=originalResult??false
   current.queries.push({allowed,originalResult});return allowed
  }
 }
 const controller:AlgorithmController={metadata:base.metadata,
  reset(env:AlgorithmEnvironment){firstEligibleTime=null;current=null;trace.length=0;base.reset(env)},
  step(input){
   if(current)throw Error('Reentrant controller step')
   const eligible=eligibleEncounter(input.measurement)
   if(eligible&&firstEligibleTime===null)firstEligibleTime=input.time
   current={time:input.time,eligible,firstEligibleTime,latched:firstEligibleTime!==null,queries:[],requestedScanId:null}
   try{
    const decision=base.step(input);current.requestedScanId=decision.quadSniff?.scanId??null
    if(policy==='encounter-gated'&&!current.latched&&decision.quadSniff)throw Error('Scan bypassed encounter gate')
    trace.push(current);return decision
   }finally{current=null}
  }}
 return {controller,trace}
}
