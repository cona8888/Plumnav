import type {AlgorithmController,AlgorithmEnvironment,AlgorithmStepInput,AlgorithmDecision} from '../../src/sim/types'

export const NO_SCAN_CONTROLLER_VERSION='scan-disabled-acquisition-v1' as const
type Hooked=AlgorithmController&{
 shouldScan:(input:AlgorithmStepInput)=>boolean
 issueScan:(input:AlgorithmStepInput)=>AlgorithmDecision
 pendingScanId:number|null
 scanSequence:number
 __researchEncounterGate?:boolean
 __researchNoScan?:boolean
}
export type NoScanTrace={time:number;predicateQueries:number;requestedScanId:null;pendingScanId:null;scanSequence:0}

/** Acquisition-only ablation. The original class is untouched. Unexpected
 * direct-issue branches fail before issueScan mutates state; no command is lost.
 */
export function noScanController(base:AlgorithmController){
 const hook=base as Hooked
 if(base.metadata.id!=='quad-sniff-refine'||typeof hook.shouldScan!=='function'||typeof hook.issueScan!=='function'||hook.__researchEncounterGate||hook.__researchNoScan)throw Error('Unavailable or already wrapped no-scan interface')
 const trace:NoScanTrace[]=[];let current:NoScanTrace|null=null,ready=false,lastTime=-Infinity
 hook.__researchNoScan=true
 hook.shouldScan=(input)=>{
  if(!current||current.time!==input.time)throw Error('No-scan predicate outside causal step')
  current.predicateQueries++;return false
 }
 hook.issueScan=()=>{throw Error('Unexpected direct scan-issue path in scan-disabled acquisition')}
 const assertEmpty=()=>{if(hook.pendingScanId!==null||hook.scanSequence!==0)throw Error('Unexpected pending/issued scan state')}
 const controller:AlgorithmController={metadata:base.metadata,
  reset(env:AlgorithmEnvironment){
   if(current)throw Error('Reset during controller step')
   ready=false;trace.length=0;lastTime=-Infinity;base.reset(env);assertEmpty();ready=true
  },
  step(input){
   if(!ready)throw Error('No-scan reset required')
   if(current)throw Error('Reentrant no-scan step')
   if(!Number.isFinite(input.time)||input.time<0||input.time<=lastTime)throw Error('Non-increasing no-scan clock')
   if(input.measurement.time!==input.time||input.measurement.sampleMode!=='passive'||input.measurement.quadSniff)throw Error('Unexpected scan/event input')
   assertEmpty();current={time:input.time,predicateQueries:0,requestedScanId:null,pendingScanId:null,scanSequence:0}
   try{
    const decision=base.step(input)
    if(decision.quadSniff)throw Error('Unexpected issued scan decision')
    assertEmpty();trace.push(current);lastTime=input.time;return decision
   }finally{current=null}
  }}
 return {version:NO_SCAN_CONTROLLER_VERSION,controller,trace}
}
