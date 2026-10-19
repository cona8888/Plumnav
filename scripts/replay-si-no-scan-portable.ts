/** Packaging-only replay: no forward simulation or new world is generated. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {SimulationEngine} from '../src/sim/engine'
import type {AlgorithmStepInput,Observation} from '../src/sim/types'
import {publicEnvironment,cleanDecision,CONTROL_DT} from './lib/si-integration'
import {responseConfig,type ResponseSpec} from './lib/si-response-design'
import {noScanController} from './lib/si-no-scan-controller'

const flag=process.argv.indexOf('--fixtures')
assert(flag>=0&&process.argv[flag+1],'Explicit fixture directory required')
const root=resolve(process.argv[flag+1]!)
const read=(name:string)=>JSON.parse(readFileSync(resolve(root,name),'utf8'))
const manifest=read('manifest.json'),done=read('complete.json')
assert.equal(manifest.version,'no-scan-controller-admission-v1');assert(done.passed)
const spec:ResponseSpec=manifest.spec
assert.equal(spec.replicate,3000);assert.equal(spec.field,'blank');assert.equal(spec.navDt,1/64)
assert.equal(done.inventory.length,3)
const results=[]
for(const item of done.inventory){
 assert(['blank','positive','pulsed'].includes(item.fixture));assert.equal(item.file,item.fixture+'.json.gz')
 const bytes=readFileSync(resolve(root,item.file))
 assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256)
 const r=JSON.parse(gunzipSync(bytes).toString('utf8'))
 assert.equal(r.fixture,item.fixture);assert.equal(r.rows.length,9601)
 const engine=new SimulationEngine(responseConfig(spec)),base=engine.controller as any
 const wrapped=noScanController(base);wrapped.controller.reset(publicEnvironment(engine))
 const observations:Observation[]=[]
 for(const row of r.rows){
  const measurement=structuredClone(row.measurement)
  if(measurement.valid)observations.push({...structuredClone(measurement),position:{...row.position}})
  const input:AlgorithmStepInput={time:row.time,dt:CONTROL_DT,position:{...row.position},heading:row.heading,distance:row.distance,measurement,observations}
  assert.deepEqual(cleanDecision(wrapped.controller.step(input)),row.decision)
  assert.deepEqual(input.measurement,row.measurement)
  assert.deepEqual({pendingScanId:base.pendingScanId,scanSequence:base.scanSequence,passiveSampleCount:base.passiveSamples.length},row.state)
 }
 assert.deepEqual(observations,r.observations);assert.deepEqual(wrapped.trace,r.trace)
 results.push({fixture:r.fixture,decisionsMatched:r.rows.length,passiveReadouts:observations.length,traceMatched:true})
}
assert.equal(new Set(results.map(x=>x.fixture)).size,3)
console.log(JSON.stringify({passed:true,kind:'relocated-controller-replay',node:process.version,results,newSimulation:false,fullMissionAdmitted:false,physicalValidation:false}))
