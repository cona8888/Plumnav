import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {gunzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {estimateQuadGradient} from '../src/sim/algorithms/quadSoilSniff'
import {schedulingController} from './lib/si-encounter-gate'
import {publicEnvironment,cleanDecision,CONTROL_DT} from './lib/si-integration'
import type {Observation} from '../src/sim/types'
import {stage1iSha256 as sha} from './lib/stage1i-campaign-design'
const root='research/evidence/si_turn_fresh_2026-09-17',parent='research/results/si_turn_fresh_2026-09-17',output='research/results/si_turn_controller_diagnosis_2026-09-17'
const ab=await readFile(`${parent}/analysis.json`),analysis=JSON.parse(ab.toString()),done=JSON.parse(await readFile(`${parent}/complete.json`,'utf8'))
assert.ok(done.complete&&analysis.integrityPassed&&sha(ab)===done.analysisSha256)
const m=await readFile(`${root}/manifest.json`);assert.equal(sha(m),analysis.manifestSha256)
const selected=analysis.triples.filter((t:any)=>!t.passed).flatMap((t:any)=>t.indices),runs:any[]=[]
for(const index of selected){
 const dir=`${root}/worker-${index%4}`,inventory=JSON.parse(await readFile(`${dir}/complete.json`,'utf8')).inventory,item=inventory.find((i:any)=>i.index===index),body=await readFile(`${dir}/${item.file}`);assert.equal(sha(body),item.sha256)
 const r=JSON.parse(gunzipSync(body).toString()),engine=new SimulationEngine(r.config),env=publicEnvironment(engine),wrapped=schedulingController(engine.controller,r.spec.policy),controller=wrapped.controller,internal=engine.controller as any,observations:Observation[]=[],events:any[]=[]
 controller.reset(env)
 for(const row of r.controls){
  if(row.stage!=='acquisition')break
  const measurement=structuredClone(row.measurement)
  if(measurement.valid)observations.push({...measurement,position:{...row.position}})
  const input={time:row.time,dt:CONTROL_DT,position:{...row.position},heading:row.heading,distance:row.distance,measurement,observations},before=structuredClone(internal.localGradientMove),pendingBefore=internal.pendingScanId
  const remaining=before?Math.hypot(row.position.x-before.target.x,row.position.y-before.target.y)*r.config.domainMeters:null
  const result=controller.step(input);assert.equal(JSON.stringify(cleanDecision(result)),JSON.stringify(row.decision))
  if(result.quadSniff||measurement.sampleMode==='quad-passive-return'||[515.8125,515.875,515.9375,529.1875,529.25,529.3125].includes(row.time)){
   const readings=measurement.quadSniff?.readings
   events.push({time:row.time,position:row.position,heading:row.heading,decision:cleanDecision(result),moveBefore:before,pendingBefore,remainingMetres:remaining,arrivalRadiusMetres:before?before.arrivalRadius*r.config.domainMeters:null,arrivalMarginMetres:before?remaining!-before.arrivalRadius*r.config.domainMeters:null,moveAfter:structuredClone(internal.localGradientMove),outcome:internal.localGradientOutcome,
    gradient:readings?estimateQuadGradient(readings,env.sensorNoise,env.gradientEstimator):null,values:measurement.localInletReadings.map((x:any)=>x.concentration),channels:measurement.localInletReadings})
  }
 }
 assert.equal(JSON.stringify(wrapped.trace),JSON.stringify(r.schedulingTrace));runs.push({index,spec:r.spec,publicReplay:true,privateFieldQueries:0,events})
}
await mkdir(output);const body=JSON.stringify({postHoc:true,doesNotOverrideAcceptance:true,parentAnalysisSha256:sha(ab),runs},null,2)+'\n'
await writeFile(`${output}/diagnosis.json`,body,{flag:'wx'});await writeFile(`${output}/complete.json`,JSON.stringify({complete:true,diagnosisSha256:sha(body),sourceSha256:sha(await readFile('scripts/diagnose-stage2-turn-controller.ts')),bundleSha256:sha(await readFile('outputs/diagnose-stage2-turn-controller.mjs'))},null,2)+'\n',{flag:'wx'})
for(const r of runs)process.stdout.write(JSON.stringify({index:r.index,firstGradient:r.events.find((e:any)=>e.gradient),arrivalBoundaries:r.events.filter((e:any)=>[515.875,529.25].includes(e.time))})+'\n')
