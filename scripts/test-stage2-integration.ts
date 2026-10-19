import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {gzipSync,gunzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {integrationCases,integrationConfig,publicEnvironment,VerifierBridge,runIntegration,replayIntegration,nominate,cleanDecision,IntegrationInstrument} from './lib/si-integration'
const cases=integrationCases();assert.equal(cases.length,36)
for(const s of cases)integrationConfig(s)
const env=publicEnvironment(new SimulationEngine(integrationConfig(cases[0]!)))
assert.throws(()=>env.expectedHitRate({x:0,y:0},{x:0,y:0},0));assert.throws(()=>(env.scenario as any).source)
assert.equal(nominate([],10,()=>false),null)
assert.equal(cleanDecision({direction:{x:0,y:0},estimate:null,confidence:1,phase:'old',nativeTerminated:true}).nativeTerminated,undefined)
const bridge=new VerifierBridge()
try{
 const fixture=JSON.parse(gunzipSync(await readFile('research/evidence/si_head_motion_development_v2_2026-09-16/stationary.json.gz')).toString())
 const visits=fixture.headVisits,motionContract={version:'continuous-stationary-head-v1',basis:'prescribed-numerical-constraint',scope:'continuous-head-centre-and-orientation',windows:visits.map((v:any,i:number)=>({visit:i,start:v.arrivedAt,end:v.closedAt,translationDiameterMetres:0,orientationSpanRadians:0}))}
 const verified=await bridge.request({operation:'verify',visits,motionContract,reportingReplicate:600031})
 assert.equal(verified.arms.length,2);assert.equal(verified.arms[0].decision.status,'supported')
 const clocks:number[][]=[]
 for(const navDt of [1/16,1/32,1/64]){
  const c=integrationConfig({...cases[0]!,navDt}),instrument=new IntegrationInstrument(c,()=>.4,navDt/4,999011)
  for(let tick=0;tick<=5/navDt;tick++)instrument.advance({time:tick*navDt,position:{x:.5,y:.5},heading:0,measurement:{time:tick*navDt,concentration:0,hit:false,valid:Number.isInteger(tick*navDt),sampleMode:'passive',wind:{x:0,y:0},localInletReadings:['front','left','aft','right'].map(channel=>({channel,concentration:0,saturated:false,effectiveOffset:{x:0,y:0}}))} as any})
  clocks.push(instrument.trace.filter(row=>Number.isInteger(row[0])).flatMap(row=>row.slice(20,24)))
 }
 for(const history of clocks)for(let i=0;i<history.length;i++)assert.ok(Math.abs(history[i]!-clocks[0]![i]!)<1e-12)
 const output=process.argv[process.argv.indexOf('--output')+1];if(!process.argv.includes('--output'))throw Error('Exclusive development output required');await mkdir(output)
 for(const [i,field,method,peak] of [[0,'si-continuous','quad-sniff-refine',true],[1,'blank','coverage',false],[2,'si-pulse','surge-cast',false]] as const){
  const s={...cases.find(s=>s.field===field&&s.method===method)!,index:i,worldSeed:103991,sourceSeed:104991,startSeed:105991,controllerSeed:106991,replicate:31}
  const r=await runIntegration(s,bridge,{startAtSource:field!=='blank',acquisitionSeconds:16,analyticPeak:peak})
  assert.ok(replayIntegration(r).passed)
  assert.ok(r.controls.every(c=>!c.decision.nativeTerminated&&!c.decision.nativeAbstained))
  assert.equal(r.summary.assertedNoLeak,false);assert.equal(r.summary.physicalSourceConfirmed,false)
  if(field==='blank')assert.equal(r.nomination,null)
  if(peak){assert.equal(r.summary.stage,'inspection-complete');assert.equal(r.summary.retainedSamples,85);assert.ok(r.verification)}
  await writeFile(`${output}/case-${i}.json.gz`,gzipSync(JSON.stringify(r)),{flag:'wx'})
  process.stdout.write(JSON.stringify({development:true,index:i,summary:r.summary})+'\n')
 }
 process.stdout.write('INTEGRATION DEVELOPMENT PASSED\n')
}finally{bridge.close()}
