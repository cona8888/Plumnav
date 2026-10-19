import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {resolve} from 'node:path'
import {SimulationEngine} from '../src/sim/engine'
import type {AlgorithmStepInput,Observation} from '../src/sim/types'
import {publicEnvironment,cleanDecision,CONTROL_DT} from './lib/si-integration'
import {responseConfig,type ResponseSpec,RESPONSE_STUDY} from './lib/si-response-design'
import {PassiveScanClock} from './lib/si-event-integration'
import {schedulingController} from './lib/si-encounter-gate'
import {noScanController} from './lib/si-no-scan-controller'

const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex')
const i=process.argv.indexOf('--output');if(i<0||!process.argv[i+1])throw Error('Explicit new output required')
const out=resolve(process.argv[i+1]!);mkdirSync(out)
const write=(name:string,value:any)=>writeFileSync(resolve(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'})
const s:ResponseSpec={index:0,panel:'linear-fresh',studyId:RESPONSE_STUDY,caseRole:'diagnostic',responseScale:1,worldIndex:0,replicate:3000,field:'blank',method:'quad-sniff-refine',policy:'reference',navDt:1/64,worldSeed:281301,sourceSeed:281501,startSeed:281701,controllerSeed:281901}
const c=responseConfig(s),start=performance.now(),checks:any[]=[],inventory:any[]=[]
const sourcePaths=['research/protocols/si_no_scan_controller_admission_v1_2026-09-24.md','scripts/lib/si-no-scan-controller.ts','scripts/test-si-no-scan-controller.ts']
const sources=sourcePaths.map(path=>({path,sha256:sha(readFileSync(path))}))
const parentRoot='aws/build/stage2i-20260921-v2/',parent=JSON.parse(readFileSync(parentRoot+'bundle.json','utf8'))
function protect(){
 assert.equal(sha(readFileSync(parentRoot+'bundle.json')),'25eb9e00a783e4d6e8b96f20ec241520407ca86ce15004ef8259425f7e68626a')
 const rows=[...parent.frozenSources,...parent.inheritedAdditions,...parent.additions];assert.equal(rows.length,179)
 for(const row of rows){assert.equal(sha(readFileSync(parentRoot+row.file)),row.sha256);if(row.file.endsWith('.ts'))assert.equal(sha(readFileSync(row.file)),row.sha256)}
 for(const row of sources)assert.equal(sha(readFileSync(row.path)),row.sha256)
}
write('manifest.json',{version:'no-scan-controller-admission-v1',startedAt:new Date().toISOString(),sources,spec:s,node:process.version,controllerOnly:true})
function test(name:string,fn:()=>void){const t=performance.now();fn();checks.push({name,seconds:(performance.now()-t)/1000});console.log(`PASS ${name}`)}
function setup(){const engine=new SimulationEngine(c),env=publicEnvironment(engine),base=engine.controller as any;return {engine,env,base}}
type Fixture='blank'|'positive'|'pulsed'
const clock=new PassiveScanClock(c,()=>false)
function input(t:number,fixture:Fixture,observations:Observation[]):AlgorithmStepInput{
 const angle=t/30,pose={position:{x:.5+.2*Math.cos(angle),y:.5+.2*Math.sin(angle)},heading:angle,distance:.2*angle}
 const positive=fixture==='positive'||fixture==='pulsed'&&t>=20&&(t-20)%40<10
 const measurement=clock.measurement(t,pose,positive?[.2625,.25,.2375,.25]:[0,0,0,0])
 if(measurement.valid)observations.push({...structuredClone(measurement),position:{...pose.position}})
 return {time:t,dt:CONTROL_DT,...pose,measurement,observations}
}
function exercise(fixture:Fixture,base:any,wrapper:ReturnType<typeof noScanController>,env:any){
 wrapper.controller.reset(env);const observations:Observation[]=[],rows:any[]=[]
 for(let tick=0;tick<=600/CONTROL_DT;tick++){
  const data=input(tick*CONTROL_DT,fixture,observations),before=JSON.stringify(data.measurement)
  const decision=wrapper.controller.step(data)
  assert.equal(JSON.stringify(data.measurement),before);assert(!decision.quadSniff);assert.notEqual(decision.phase,'AWAITING FOUR CHANNELS')
  assert.equal(base.pendingScanId,null);assert.equal(base.scanSequence,0)
  rows.push({time:data.time,position:data.position,heading:data.heading,distance:data.distance,measurement:data.measurement,decision:cleanDecision(decision),state:{pendingScanId:base.pendingScanId,scanSequence:base.scanSequence,passiveSampleCount:base.passiveSamples.length}})
 }
 assert.equal(observations.length,601)
 assert.deepEqual(base.passiveSamples.map((x:any)=>({time:x.time,concentration:x.concentration,hit:x.hit,position:x.position})),observations.map(x=>({time:x.time,concentration:x.concentration,hit:x.hit,position:x.position})))
 assert(wrapper.trace.some(x=>x.predicateQueries>0))
 return {fixture,rows,trace:structuredClone(wrapper.trace),observations}
}
try{
 test('frozen inputs unchanged',protect)
 test('strict hook lifecycle and malformed input rejection',()=>{
  const {base,env}=setup(),w=noScanController(base),m=input(0,'blank',[])
  assert.throws(()=>w.controller.step(m),/reset required/)
  assert.throws(()=>noScanController(base),/already wrapped/)
  w.controller.reset(env)
  assert.throws(()=>base.shouldScan(m),/outside causal/)
  assert.throws(()=>w.controller.step({...m,measurement:{...m.measurement,sampleMode:'blanked'}}),/scan\/event/)
  w.controller.step(m)
  assert.throws(()=>w.controller.step(m),/Non-increasing/)
  assert.throws(()=>w.controller.step({...m,time:-1}),/Non-increasing/)
  const gated=setup();schedulingController(gated.base,'encounter-gated');assert.throws(()=>noScanController(gated.base),/already wrapped/)
  const wrong=setup();wrong.base.metadata={...wrong.base.metadata,id:'coverage'};assert.throws(()=>noScanController(wrong.base),/Unavailable/)
  assert.throws(()=>(env.scenario as any).source,/Undeclared/);assert.throws(()=>(env.scenario as any).sourceSeed,/Undeclared/)
 })
 test('direct scan issuance and stale pending state fail closed',()=>{
  const {base,env}=setup(),w=noScanController(base);w.controller.reset(env)
  assert.throws(()=>base.issueScan(input(0,'positive',[])),/direct scan-issue/)
  assert.equal(base.pendingScanId,null);assert.equal(base.scanSequence,0)
  base.pendingScanId=12;assert.throws(()=>w.controller.step(input(0,'positive',[])),/pending\/issued/)
  w.controller.reset(env);assert.equal(base.pendingScanId,null)
 })
 for(const fixture of ['blank','positive','pulsed'] as const)test(`${fixture}: complete state history, memory and reset equivalence`,()=>{
  const {base,env}=setup(),w=noScanController(base),first=exercise(fixture,base,w,env)
  const body=gzipSync(JSON.stringify(first)),file=fixture+'.json.gz';writeFileSync(resolve(out,file),body,{flag:'wx'})
  inventory.push({fixture,file,sha256:sha(body),bytes:body.length,controls:first.rows.length,predicateQueries:first.trace.reduce((a,x)=>a+x.predicateQueries,0)})
  const second=exercise(fixture,base,w,env);assert.deepEqual(second,first)
  if(fixture!=='positive'){
   const other=setup(),g=schedulingController(other.base,'encounter-gated');g.controller.reset(other.env);const obs:Observation[]=[]
   for(const row of first.rows){if(fixture==='pulsed'&&row.time>=20)break;const decision=g.controller.step(input(row.time,fixture,obs));assert.deepEqual(cleanDecision(decision),row.decision)}
  }
 })
 test('unwrapped positive controller issues a real scan',()=>{
  const {base,env}=setup();base.reset(env);const obs:Observation[]=[];let issued=false
  for(let t=0;t<=2;t+=CONTROL_DT){const decision=base.step(input(t,'positive',obs));if(decision.quadSniff){issued=true;assert.equal(base.pendingScanId,decision.quadSniff.scanId);break}}
  assert(issued)
 })
 test('frozen inputs unchanged after fixtures',protect)
 write('complete.json',{passed:true,version:'no-scan-controller-admission-v1',finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,checks,inventory,parentFilesUnchanged:179,fullMissionAdmitted:false,physicalValidation:false,performanceComparison:false})
}catch(error){write('failed.json',{passed:false,error:String(error),at:new Date().toISOString(),checks,inventory,diagnosticOnly:true});throw error}
