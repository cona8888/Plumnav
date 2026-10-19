import assert from 'node:assert/strict'
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {gzipSync} from 'node:zlib'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import {SimulationEngine} from '../src/sim/engine'
import type {AlgorithmStepInput,AlgorithmDecision,Observation} from '../src/sim/types'
import {PassiveScanClock} from './lib/si-event-integration'
import {publicEnvironment,CONTROL_DT,type VerifierBridge} from './lib/si-integration'
import {responseConfig,type ResponseSpec,RESPONSE_STUDY} from './lib/si-response-design'
import {runResponseIntegration} from './lib/si-response-integration'
import {runReadoutIntegration,replayReadoutIntegration} from './lib/si-readout-integration'
import {exposeScanReadout,scanBlocksMotion,scanCanDrain} from './lib/si-readout-availability'
import {schedulingController,eligibleEncounter} from './lib/si-encounter-gate'
import {LinearInstrument} from './lib/si-linear-instrument'
import {makeMotionSegment,sampleMotion,type MotionPose} from './lib/si-turn-motion'

const start=performance.now(), checks:{name:string;seconds:number}[]=[]
const outputIndex=process.argv.indexOf('--output')
if(outputIndex<0||!process.argv[outputIndex+1])throw Error('Explicit new development output directory required')
const output=resolve(process.argv[outputIndex+1]!)
mkdirSync(output)
const write=(name:string,body:string|Buffer)=>writeFileSync(resolve(output,name),body,{flag:'wx'})
write('started.json',JSON.stringify({startedAt:new Date().toISOString(),node:process.version,pid:process.pid,developmentOnly:true})+'\n')
async function test(name:string, fn:()=>unknown|Promise<unknown>){const t=performance.now();await fn();checks.push({name,seconds:(performance.now()-t)/1000});console.log(`PASS: ${name}`)}
const sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex')
const root='aws/build/stage2i-20260921-v2/'
const bundle=JSON.parse(readFileSync(root+'bundle.json','utf8'))
const parentRows=[...bundle.frozenSources,...bundle.inheritedAdditions,...bundle.additions]
function checkParents(){
 assert.equal(sha(readFileSync(root+'bundle.json')),'25eb9e00a783e4d6e8b96f20ec241520407ca86ce15004ef8259425f7e68626a')
 for(const r of parentRows){assert.equal(sha(readFileSync(root+r.file)),r.sha256,r.file);if(r.file.endsWith('.ts'))assert.equal(sha(readFileSync(r.file)),r.sha256,r.file)}
 return parentRows.length
}
const s:ResponseSpec={index:0,panel:'linear-fresh',studyId:RESPONSE_STUDY,caseRole:'diagnostic',responseScale:1,worldIndex:0,replicate:3000,field:'blank',method:'quad-sniff-refine',policy:'reference',navDt:1/64,worldSeed:281301,sourceSeed:281501,startSeed:281701,controllerSeed:281901}
const c=responseConfig(s),pose:MotionPose={position:{x:.5,y:.5},heading:0,distance:0}
const still:AlgorithmDecision={direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase:'fixture'}
const issue=(scanId:number):AlgorithmDecision=>({...still,quadSniff:{scanId,forward:{x:1,y:0}}})
const clock=()=>new PassiveScanClock(c,()=>false)
function started(at=0){const k=clock();assert(k.consumeAndCommand(k.measurement(at,pose,[.14,.14,.14,.14]),issue(1),pose));return k}
function normalize(record:any){const {availability,availabilityVersion,availabilityTrace,...old}=record;return {...old,summary:{...old.summary,rpcMilliseconds:0}}}

await test('179 frozen parent files and working TypeScript sources unchanged',()=>assert.equal(checkParents(),179))
await test('unknown availability and malformed live measurements fail closed',()=>{
 const m=started().measurement(1,pose,[.14,.14,.14,.14])
 assert.throws(()=>exposeScanReadout(m,'bad' as any),/Unknown/)
 assert.throws(()=>exposeScanReadout({...m,quadSniff:undefined},'live-passive'),/unfinished/)
 assert.throws(()=>exposeScanReadout({...m,localInletReadings:[]},'live-passive'),/Malformed/)
 assert.throws(()=>exposeScanReadout({...m,valid:true},'live-passive'),/Malformed/)
 const bad=structuredClone(m);bad.localInletReadings![0]!.concentration=NaN
 assert.throws(()=>exposeScanReadout(bad,'live-passive'),/Malformed/)
})
await test('original identity, integer eligibility, fractional onset and delayed return',()=>{
 for(const onset of [0,.0625,.9375]){
  const k=started(onset),seen:number[]=[]
  const end=Math.ceil(onset+12)
  for(let t=onset;t<=end;t+=CONTROL_DT){
   const raw=k.measurement(t,pose,[.12,.14,.16,.18]),before=JSON.stringify(raw)
   assert.strictEqual(exposeScanReadout(raw,'original-withheld'),raw)
   const live=exposeScanReadout(raw,'live-passive')
   assert.equal(JSON.stringify(raw),before,'adapter mutated input')
   assert.equal(live.valid,Number.isInteger(t))
   assert.deepEqual(live.localInletReadings,raw.localInletReadings)
   assert.deepEqual(live.quadSniff,raw.quadSniff)
   if(live.valid)seen.push(t)
   if(t<end){assert.equal(raw.sampleMode,'blanked');assert.equal(scanCanDrain(raw),false)}
   else{assert.equal(live.sampleMode,'quad-passive-return');assert.strictEqual(live,raw);assert.equal(scanCanDrain(raw),true)}
  }
  assert.equal(new Set(seen).size,seen.length)
  assert.equal(seen.length,end-Math.ceil(onset)+1)
 }
})
await test('live hit uses unchanged scalar mean, not any-channel trigger',()=>{
 const k=started(),raw=k.measurement(1,pose,[.2,.01,.01,.01]),live=exposeScanReadout(raw,'live-passive')
 assert.equal(live.hit,false);assert.equal(eligibleEncounter(live),false)
 const returned=k.measurement(12,pose,[.2,.01,.01,.01]);assert.equal(returned.hit,true)
 assert.strictEqual(exposeScanReadout(returned,'live-passive'),returned)
})
await test('stationary hold and drain are independent of readout availability',()=>{
 const k=started(),move={...still,direction:{x:0,y:1},speedScale:1}
 for(let t=0;t<12;t+=CONTROL_DT){
  const raw=k.measurement(t,pose,[.14,.14,.14,.14]),live=exposeScanReadout(raw,'live-passive')
  assert.equal(scanCanDrain(raw),false)
  if(Number.isInteger(t))assert(live.valid)
  const segment=makeMotionSegment(pose,move,t,CONTROL_DT,c.robotSpeed,c.localInletSampling!.maximumTurnRateRadiansPerSecond,.04,scanBlocksMotion(raw,false))
  for(const f of [0,.25,.5,.75,1])assert.deepEqual(sampleMotion(segment,t+f*CONTROL_DT),pose)
 }
 assert(scanBlocksMotion(k.measurement(12,pose,[0,0,0,0]),true),'newly accepted event must also hold')
})
await test('scan completion consumed once and issued IDs cannot restart it',()=>{
 const k=started(),ret=k.measurement(12,pose,[.14,.14,.14,.14])
 assert.equal(k.consumeAndCommand(ret,still,pose),false);assert.equal(k.event,null)
 assert.equal(k.consumeAndCommand(k.measurement(12,pose,[.14,.14,.14,.14]),issue(1),pose),false)
 assert(k.consumeAndCommand(k.measurement(13,pose,[.14,.14,.14,.14]),issue(2),pose))
 assert.equal(k.event!.scanId,2)
})
await test('real pending controller ingests each live passive readout',()=>{
 for(const availability of ['original-withheld','live-passive'] as const){
  const engine=new SimulationEngine(c),env=publicEnvironment(engine),controller=engine.controller,observations:Observation[]=[]
  controller.reset(env)
  const input=(time:number,m:any):AlgorithmStepInput=>({time,dt:CONTROL_DT,...pose,measurement:m,observations})
  const initial=clock().measurement(0,pose,[.14,.14,.14,.14])
  // Research-only instrumentation of the frozen method, not a production hook.
  const base=controller as any;const issued=base.issueScan(input(0,initial));assert(issued.quadSniff)
  const k=clock();assert(k.consumeAndCommand(initial,issued,pose))
  for(let t=CONTROL_DT;t<12;t+=CONTROL_DT){const m=exposeScanReadout(k.measurement(t,pose,[.14,.14,.14,.14]),availability);if(m.valid)observations.push({...m,position:{...pose.position}});controller.step(input(t,m));assert.equal(base.pendingScanId,issued.quadSniff.scanId)}
  assert.equal(base.passiveSamples.length,availability==='live-passive'?11:0)
  assert.deepEqual(base.passiveSamples.map((r:any)=>r.time),observations.map(o=>o.time))
  const m=exposeScanReadout(k.measurement(12,pose,[.14,.14,.14,.14]),availability);controller.step(input(12,m));assert.equal(base.pendingScanId,null)
 }
})
await test('encounter gate is causal and public source access is rejected',()=>{
 const engine=new SimulationEngine(c),env=publicEnvironment(engine),gate=schedulingController(engine.controller,'encounter-gated');gate.controller.reset(env)
 assert.throws(()=>(env.scenario as any).source,/Undeclared/)
 assert.throws(()=>(env.scenario as any).sourceSeed,/Undeclared/)
 for(const [t,value] of [[0,0],[1,.14],[2,0]]){const m=clock().measurement(t!,pose,[value!,value!,value!,value!]);gate.controller.step({time:t!,dt:CONTROL_DT,...pose,measurement:m,observations:[]})}
 assert.equal(gate.trace[0]!.latched,false);assert.equal(gate.trace[0]!.requestedScanId,null)
 assert.equal(gate.trace[1]!.firstEligibleTime,1);assert.equal(gate.trace[2]!.latched,true)
})
await test('availability causes no new field queries or instrument-memory reset',()=>{
 const runs=[]
 for(const availability of ['original-withheld','live-passive'] as const){
  let queries=0
  const instrument=new LinearInstrument(c,(_p,t)=>{queries++;return t<6?.14:.02},c.fixedDt/4,2841301),k=started()
  for(let t=0;t<=14;t+=CONTROL_DT){instrument.advance(t,()=>pose);const raw=k.measurement(t,pose,instrument.readout);exposeScanReadout(raw,availability);k.consumeAndCommand(raw,still,pose)}
  runs.push({queries,trace:instrument.trace})
 }
 assert.deepEqual(runs[0],runs[1]);assert.equal(runs[0]!.queries,4*(14*256+1))
 assert(runs[0]!.trace.some(r=>r[0]!>6&&r[16]!>.02),'recovery memory was not exercised')
})

const smoke:any[]=[]
await test('shortened blank original histories match and all four arms replay',async()=>{
 const bridge={request:async()=>{throw Error('Blank admission must not call verifier')}} as unknown as VerifierBridge
 for(const policy of ['reference','encounter-gated'] as const){
  const spec={...s,policy},development={acquisitionSeconds:24}
  const old=await runResponseIntegration(spec,bridge,development)
  write(`${policy}-parent.json.gz`,gzipSync(JSON.stringify(old)))
  for(const availability of ['original-withheld','live-passive'] as const){
   const t=performance.now(),record=await runReadoutIntegration(spec,bridge,availability,development)
   const stored=gzipSync(JSON.stringify(record)),file=`${policy}-${availability}.json.gz`
   write(file,stored)
   assert.equal(record.summary.stage,'no-eligible-nomination');assert.equal(record.summary.completedAt,24)
   if(availability==='original-withheld')assert.deepEqual(normalize(record),normalize(old))
   const replay=replayReadoutIntegration(record);assert(replay.passed&&replay.schedulingTraceMatched)
   const times=record.observations.map(o=>o.time);assert.equal(new Set(times).size,times.length)
   assert(times.every(Number.isInteger))
   for(let i=0;i<record.segments.length;i++){if(record.availabilityTrace[i]!.rawMode==='blanked')assert(record.segments[i]!.held)}
   const bytes=JSON.stringify(record)
   smoke.push({policy,availability,seconds:(performance.now()-t)/1000,file,sha256:sha(stored),compressedBytes:stored.length,historySha256:sha(bytes),historyBytes:Buffer.byteLength(bytes),observations:times.length,extraEligibleReadouts:record.availabilityTrace.filter(r=>r.effectiveValid&&!r.rawValid).length,replay})
  }
 }
 assert(smoke.find(x=>x.policy==='reference'&&x.availability==='live-passive').extraEligibleReadouts>0)
})
await test('frozen parents unchanged after all checks',()=>assert.equal(checkParents(),179))

const paths=['research/protocols/si_readout_admission_v1_2026-09-24.md','scripts/lib/si-readout-availability.ts','scripts/lib/si-readout-integration.ts','scripts/test-si-readout-admission.ts']
const receipt={schemaVersion:'si-readout-admission-v1',passed:true,createdAt:new Date().toISOString(),node:process.version,architecture:process.arch,elapsedSeconds:(performance.now()-start)/1000,checks,smoke,sources:paths.map(path=>({path,sha256:sha(readFileSync(path))})),parentFilesUnchanged:179,developmentOnly:true,fullMissionAdmitted:false,performanceCampaignRun:false,physicalValidation:false}
write('complete.json',JSON.stringify(receipt,null,2)+'\n')
console.log(JSON.stringify(receipt,null,2))
