import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {resolve} from 'node:path'
import {runResponseIntegration} from './lib/si-response-integration'
import {runReadoutIntegration,replayReadoutIntegration} from './lib/si-readout-integration'
import {ReadoutExactBridge} from './lib/si-readout-exact-bridge'
import {RESPONSE_STUDY,type ResponseSpec} from './lib/si-response-design'
import type {VerifierBridge} from './lib/si-integration'

const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex')
const read=(p:string)=>readFileSync(p,'utf8')
const root='aws/build/stage2i-20260921-v2/',bundle=JSON.parse(read(root+'bundle.json'))
function parents(){
 assert.equal(sha(readFileSync(root+'bundle.json')),'25eb9e00a783e4d6e8b96f20ec241520407ca86ce15004ef8259425f7e68626a')
 const rows=[...bundle.frozenSources,...bundle.inheritedAdditions,...bundle.additions]
 for(const r of rows){assert.equal(sha(readFileSync(root+r.file)),r.sha256);if(r.file.endsWith('.ts'))assert.equal(sha(readFileSync(r.file)),r.sha256)}
 const old=JSON.parse(read('research/results/si_readout_admission_v1_attempt01_2026-09-24/complete.json'))
 for(const r of old.sources)assert.equal(sha(readFileSync(r.path)),r.sha256,r.path)
 assert.equal(rows.length,179)
}
function mechanicalDelta(){
 let expected=read('scripts/lib/si-response-integration.ts')
 expected=expected.replaceAll('runResponseIntegration','runReadoutIntegration').replaceAll('replayResponseIntegration','replayReadoutIntegration')
 expected=expected.replace("import {LinearInstrument} from './si-linear-instrument'", "import {LinearInstrument} from './si-linear-instrument'\nimport {exposeScanReadout,scanBlocksMotion,scanCanDrain,READOUT_AVAILABILITY_VERSION,type ReadoutAvailability} from './si-readout-availability'")
 expected=expected.replace('s:LinearSpec,bridge:VerifierBridge,development?', 's:LinearSpec,bridge:VerifierBridge,availability:ReadoutAvailability,development?')
 expected=expected.replace(' const c=integrationConfig(s);', " if(!['original-withheld','live-passive'].includes(availability))throw Error('Unknown readout availability')\n const availabilityTrace:any[]=[]\n const c=integrationConfig(s);")
 expected=expected.replace('  const measurement=clock.measurement(time,pose,instrument.readout)', '  const rawMeasurement=clock.measurement(time,pose,instrument.readout)\n  const measurement=exposeScanReadout(rawMeasurement,availability)\n  availabilityTrace.push({time,scanId:clock.event?.scanId??null,rawMode:rawMeasurement.sampleMode,rawValid:rawMeasurement.valid,effectiveMode:measurement.sampleMode,effectiveValid:measurement.valid})')
 expected=expected.replace("stage==='drain'&&measurement.sampleMode!=='blanked'", "stage==='drain'&&scanCanDrain(rawMeasurement)")
 expected=expected.replace("measurement.sampleMode==='blanked'||accepted)", 'scanBlocksMotion(rawMeasurement,accepted))')
 expected=expected.replace('sampleMode:i===0?measurement.sampleMode:clock.event?', 'sampleMode:i===0?rawMeasurement.sampleMode:clock.event?')
 expected=expected.replace("  responseVersion:'linear-inlet-v1'", "  availabilityVersion:READOUT_AVAILABILITY_VERSION,availability,availabilityTrace,\n  responseVersion:'linear-inlet-v1'")
 assert.equal(read('scripts/lib/si-readout-integration.ts').trimEnd(),expected.trimEnd())
}
function normalize(record:any){const {availability,availabilityVersion,availabilityTrace,...old}=record;return {...old,summary:{...old.summary,rpcMilliseconds:0}}}
const idx=process.argv.indexOf('--output');if(idx<0||!process.argv[idx+1])throw Error('Explicit new output required')
const out=resolve(process.argv[idx+1]!);mkdirSync(out)
const write=(name:string,body:string|Buffer)=>writeFileSync(resolve(out,name),body,{flag:'wx'})
const json=(x:any)=>JSON.stringify(x,null,2)+'\n'
const s:ResponseSpec={index:0,panel:'linear-fresh',studyId:RESPONSE_STUDY,caseRole:'diagnostic',responseScale:1,worldIndex:0,replicate:3000,field:'si-continuous',method:'quad-sniff-refine',policy:'reference',navDt:1/64,worldSeed:281301,sourceSeed:281501,startSeed:281701,controllerSeed:281901}
const development={startAtSource:true,analyticPeak:true,acquisitionSeconds:30.0625}
const sourcePaths=['research/protocols/si_readout_positive_admission_v1_2026-09-24.md','scripts/test-si-readout-positive-admission.ts','scripts/lib/si-readout-exact-bridge.ts','scripts/si-readout-exact-bridge.py','scripts/lib/si-readout-integration.ts','scripts/lib/si-readout-availability.ts']
const startedAt=new Date().toISOString(),start=performance.now(),sources=sourcePaths.map(path=>({path,sha256:sha(readFileSync(path))}))
write('manifest.json',json({version:'readout-positive-admission-v1',startedAt,node:process.version,architecture:process.arch,spec:s,development,sources,exactPoseOnly:true,performanceCampaign:false}))
const inventory:any[]=[];let maxRssBytes=0,bridge:ReadoutExactBridge|undefined
try{
 parents();mechanicalDelta();console.log('PASS: protected sources and exact mechanical run-loop delta')
 bridge=new ReadoutExactBridge(sources.find(x=>x.path==='scripts/si-readout-exact-bridge.py')!.sha256)
 const rpc=bridge as unknown as VerifierBridge
 await assert.rejects(bridge.request({operation:'verify',visits:[],motionContract:null,reportingReplicate:603001}),/Undeclared/)
 await assert.rejects(bridge.request({operation:'verify',visits:[],motionContract:null,reportingReplicate:603000,source:{x:0,y:0}}),/Undeclared/)
 await assert.rejects(bridge.request({operation:'wrong',visits:[],motionContract:null,reportingReplicate:603000}),/Unknown/)
 console.log('PASS: strict exact-pose RPC rejects extra truth, wrong ID and operation')
 for(const policy of ['reference','encounter-gated'] as const){
  const spec={...s,policy},t=performance.now()
  const parent=await runResponseIntegration(spec,rpc,development),parentBody=gzipSync(JSON.stringify(parent)),parentFile=`${policy}-parent.json.gz`
  write(parentFile,parentBody);inventory.push({kind:'parent',file:parentFile,sha256:sha(parentBody),seconds:(performance.now()-t)/1000,bytes:parentBody.length})
  console.log(`SAVED: ${parentFile}`)
  for(const availability of ['original-withheld','live-passive'] as const){
   const t=performance.now(),r=await runReadoutIntegration(spec,rpc,availability,development)
   const body=gzipSync(JSON.stringify(r)),file=`${policy}-${availability}.json.gz`
   write(file,body)
   const item:any={kind:'candidate',policy,availability,file,sha256:sha(body),bytes:body.length,seconds:(performance.now()-t)/1000,stage:r.summary.stage,inspectionAt:r.summary.inspectionAt,completedAt:r.summary.completedAt,drainRows:r.controls.filter(x=>x.stage==='drain').length}
   inventory.push(item)
   assert.equal(r.summary.stage,'inspection-complete');assert.equal(r.visits.length,17);assert(r.visits.every(v=>v.samples.length===5))
   assert.equal(r.verification!.arms.length,1);assert.equal(r.verification!.arms[0]!.poseRadiusMetres,0)
   assert(r.verification!.arms[0]!.decision.admitted,'stationary-head contract must be admitted, not necessarily supported')
   if(availability==='original-withheld')assert.deepEqual(normalize(r),normalize(parent))
   item.replay=replayReadoutIntegration(r);assert(item.replay.passed)
   for(let i=0;i<r.controls.length;i++){
    const row=r.controls[i]!,entry=r.availabilityTrace[i]!
    if(row.stage==='drain')assert.equal(entry.rawMode,'blanked')
    if(entry.rawMode==='blanked'&&i<r.segments.length)assert(r.segments[i]!.held)
    if(row.time===r.summary.inspectionAt)assert.notEqual(entry.rawMode,'blanked')
   }
   maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
   write(`${file}.receipt.json`,json(item))
   console.log(`PASS: ${policy}/${availability}; completed inspection and replay; drain rows ${item.drainRows}`)
  }
 }
 assert(inventory.some(x=>x.kind==='candidate'&&x.drainRows>0),'Actual main-loop drain transition not exercised')
 parents();mechanicalDelta()
 await bridge.close();bridge=undefined
 write('complete.json',json({version:'readout-positive-admission-v1',completed:true,startedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,maxRssBytes,inventory,protectedParentFiles:179,mechanicalDeltaMatched:true,exactPoseOnly:true,analyticFixtureOnly:true,full600SecondAcquisition:false,independentlyAudited:false,performanceCampaign:false}))
 console.log('COMPLETE: analytic positive gate; independent audit still required')
}catch(e){
 write('failed.json',json({completed:false,failedAt:new Date().toISOString(),error:String(e),inventory,diagnosticOnly:true}))
 throw e
}finally{if(bridge)await bridge.close()}
