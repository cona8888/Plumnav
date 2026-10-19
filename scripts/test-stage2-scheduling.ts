import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {gzipSync,gunzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {eligibleEncounter,schedulingController} from './lib/si-encounter-gate'
import {schedulingCases,schedulingConfig,type SchedulingSpec} from './lib/si-scheduling-design'
import {runScheduling,replayScheduling} from './lib/si-scheduling-integration'
import {publicEnvironment,VerifierBridge,replayIntegration} from './lib/si-integration'
import {PassiveScanClock} from './lib/si-event-integration'
import type {Observation} from '../src/sim/types'

const cases=schedulingCases();assert.equal(cases.length,240);assert.equal(cases.filter(s=>s.navDt===1/16).length,192)
for(const gated of cases.filter(s=>s.policy==='encounter-gated')){
 const reference=cases.find(s=>s.worldIndex===gated.worldIndex&&s.field===gated.field&&s.navDt===gated.navDt&&s.method===gated.method&&s.policy==='reference')!
 assert.deepEqual(schedulingConfig(gated),schedulingConfig(reference))
}
const spec=cases.find(s=>s.policy==='encounter-gated')!,c=schedulingConfig(spec),pose={position:{x:.5,y:.5},heading:0,distance:0}
const clock=new PassiveScanClock(c,()=>false),m=clock.measurement(0,pose,[.2,.2,.2,.2])
assert.ok(eligibleEncounter(m))
for(const bad of [{...m,valid:false},{...m,hit:false},{...m,concentration:.114},{...m,concentration:NaN},{...m,sampleMode:'blanked' as const},{...m,localInletReadings:m.localInletReadings!.slice(1)},
 {...m,localInletReadings:m.localInletReadings!.map((r,i)=>({...r,saturated:i===0}))}, {...m,localInletReadings:m.localInletReadings!.map(r=>({...r,channel:'front' as const}))}])assert.equal(eligibleEncounter(bad),false)
// Same public history with immediate contact: post-latch behavior is unchanged.
const engineA=new SimulationEngine(c),engineB=new SimulationEngine(c),a=schedulingController(engineA.controller,'reference'),b=schedulingController(engineB.controller,'encounter-gated'),env=publicEnvironment(engineA)
a.controller.reset(env);b.controller.reset(env);const observations:Observation[]=[]
for(let tick=0;tick<=48*16;tick++){
 const time=tick/16,measurement=clock.measurement(time,pose,[.2,.2,.2,.2])
 if(measurement.valid)observations.push({...measurement,position:pose.position})
 const input={time,dt:1/16,...pose,measurement,observations},da=a.controller.step(input),db=b.controller.step(input)
 assert.deepEqual(db,da);clock.consumeAndCommand(measurement,da,pose)
}
assert.ok(b.trace.every(r=>r.latched&&r.firstEligibleTime===0));assert.ok(b.trace.some(r=>r.requestedScanId!==null));assert.ok(observations.some(o=>o.sampleMode==='quad-passive-return'))
b.controller.reset(env);assert.equal(b.trace.length,0);b.controller.step({time:0,dt:1/16,...pose,measurement:{...m,hit:false,concentration:0},observations:[]});assert.equal(b.trace[0]!.latched,false)
assert.throws(()=>schedulingController(engineB.controller,'encounter-gated'))
assert.throws(()=>schedulingController(new SimulationEngine({...c,algorithmId:'coverage'}).controller,'encounter-gated'))

const output=process.argv[process.argv.indexOf('--output')+1];if(!process.argv.includes('--output'))throw Error('Exclusive output required');await mkdir(output)
const bridge=new VerifierBridge(),inventory:any[]=[]
try{
 // Compare three full original reference histories, including an inspection.
 for(const index of [0,3,6]){
  const root='research/evidence/si_event_fresh_v2_2026-09-16',old=JSON.parse(gunzipSync(await readFile(`${root}/worker-${index%4}/case-${String(index).padStart(3,'0')}.json.gz`)).toString())
  const s:SchedulingSpec={...old.spec,panel:'encounter-scheduling-v1',worldIndex:-1,policy:'reference'}
  const r=await runScheduling(s,bridge)
  for(const key of ['config','publicEnvironment','publicScenario','navigation','controls','segments','observations','trace','nomination','visits','motionContract','verification','nativeEvents'] as const)assert.ok(JSON.stringify(r[key])===JSON.stringify(old[key]),`Serialized reference mismatch: ${key}`)
  const summary={...r.summary},prior={...old.summary};delete (summary as any).rpcMilliseconds;delete prior.rpcMilliseconds;assert.deepEqual(summary,prior)
  assert.ok(replayIntegration(r).passed&&replayScheduling(r).passed)
  const file=`reference-${index}.json.gz`;await writeFile(`${output}/${file}`,gzipSync(JSON.stringify(r)),{flag:'wx'});inventory.push({file,referenceEquivalent:true});process.stdout.write(`reference ${index}: exact serialized equivalence passed\n`)
 }
 const blanks:any[]=[]
 for(const [index,field,navDt,peak] of [[0,'blank',1/16,false],[1,'blank',1/32,false],[2,'blank',1/64,false],[3,'si-continuous',1/16,true],[4,'si-pulse',1/16,false]] as const){
  const s:SchedulingSpec={...spec,index,field,navDt,worldIndex:999,replicate:199,worldSeed:125991,sourceSeed:126991,startSeed:127991,controllerSeed:128991}
  const r=await runScheduling(s,bridge,{startAtSource:field!=='blank',acquisitionSeconds:16,analyticPeak:peak});assert.ok(replayScheduling(r).passed)
  if(field==='blank'){
   assert.equal(r.nomination,null);assert.ok(r.schedulingTrace.every(t=>!t.latched&&t.requestedScanId===null));assert.ok(r.segments.every(s=>!s.held));blanks.push(r)
  }else{assert.equal(r.summary.stage,'inspection-complete');assert.equal(r.summary.retainedSamples,85);assert.ok(r.schedulingTrace.some(t=>t.latched));assert.ok(r.schedulingTrace.some(t=>t.requestedScanId!==null))}
  const file=`development-${index}.json.gz`;await writeFile(`${output}/${file}`,gzipSync(JSON.stringify(r)),{flag:'wx'});inventory.push({file,summary:r.summary})
 }
 for(const r of blanks){assert.deepEqual(r.controls,blanks[0].controls);assert.deepEqual(r.segments,blanks[0].segments);assert.deepEqual(r.schedulingTrace,blanks[0].schedulingTrace)}
 await writeFile(`${output}/complete.json`,JSON.stringify({complete:true,developmentOnly:true,caseDesignCount:240,referenceEquivalent:3,blankBitIdentical:true,inventory},null,2)+'\n',{flag:'wx'})
 process.stdout.write('PASS: eligibility, latch/reset, post-latch equivalence, 3 full frozen-reference histories, 5 development missions, public replay, blank mesh invariance\n')
}finally{bridge.close()}
