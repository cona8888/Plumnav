import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {resolve} from 'node:path'
import {runReadoutIntegration,replayReadoutIntegration} from './lib/si-readout-integration'
import {ReadoutExactBridge} from './lib/si-readout-exact-bridge'
import {RESPONSE_STUDY,type ResponseSpec} from './lib/si-response-design'
import type {VerifierBridge} from './lib/si-integration'

const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex')
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'))
const positive='research/results/si_readout_positive_admission_v1_attempt01_2026-09-24/'
const accepted=read(positive+'independent_audit.json')
assert.equal(accepted.completeSha256,sha(readFileSync(positive+'run/complete.json')))
assert.equal(accepted.manifestSha256,sha(readFileSync(positive+'run/manifest.json')))
assert.equal(accepted.details.length,4)
for(const row of read(positive+'run/manifest.json').sources)assert.equal(sha(readFileSync(row.path)),row.sha256)
const root='aws/build/stage2i-20260921-v2/',parent=read(root+'bundle.json')
const protectedRows=[...parent.frozenSources,...parent.inheritedAdditions,...parent.additions]
function protect(){for(const row of protectedRows){assert.equal(sha(readFileSync(root+row.file)),row.sha256);if(row.file.endsWith('.ts'))assert.equal(sha(readFileSync(row.file)),row.sha256)}}
protect()
const idx=process.argv.indexOf('--output');if(idx<0||!process.argv[idx+1])throw Error('Explicit new output required')
const output=resolve(process.argv[idx+1]!);mkdirSync(output)
const write=(name:string,body:string|Buffer)=>writeFileSync(resolve(output,name),body,{flag:'wx'})
const json=(value:any)=>JSON.stringify(value,null,2)+'\n'
const spec:ResponseSpec={index:0,panel:'linear-fresh',studyId:RESPONSE_STUDY,caseRole:'diagnostic',responseScale:1,worldIndex:0,replicate:3000,field:'si-continuous',method:'quad-sniff-refine',policy:'encounter-gated',navDt:1/64,worldSeed:281301,sourceSeed:281501,startSeed:281701,controllerSeed:281901}
const sources=['research/protocols/si_readout_emitting_timing_v1_2026-09-24.md','scripts/test-si-readout-emitting-timing.ts','scripts/lib/si-readout-integration.ts','scripts/lib/si-readout-availability.ts','scripts/lib/si-readout-exact-bridge.ts','scripts/si-readout-exact-bridge.py'].map(path=>({path,sha256:sha(readFileSync(path))}))
const startedAt=new Date().toISOString(),start=performance.now()
write('manifest.json',json({version:'readout-emitting-timing-v1',startedAt,spec,availability:'live-passive',development:null,exactPoseOnly:true,node:process.version,sources,positiveAuditSha256:sha(readFileSync(positive+'independent_audit.json'))}))
const bridge=new ReadoutExactBridge(sources.find(x=>x.path==='scripts/si-readout-exact-bridge.py')!.sha256)
try{
 const record=await runReadoutIntegration(spec,bridge as unknown as VerifierBridge,'live-passive')
 const simulationSeconds=(performance.now()-start)/1000
 const body=gzipSync(JSON.stringify(record));write('mission.json.gz',body)
 assert.equal(record.development,null);assert.equal(record.summary.acquisitionBudgetSeconds,600)
 assert(record.summary.completedAt>=600&&record.summary.completedAt<=1200)
 assert(['inspection-complete','no-eligible-nomination','mission-budget-exhausted'].includes(record.summary.stage))
 const replay=replayReadoutIntegration(record);assert(replay.passed&&replay.schedulingTraceMatched)
 protect()
 write('complete.json',json({completed:true,startedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,simulationSeconds,maxRssBytes:process.memoryUsage().rss,file:'mission.json.gz',bytes:body.length,sha256:sha(body),replay,terminalStage:record.summary.stage,completedAt:record.summary.completedAt,independentlyAudited:false,developmentOnly:true,performanceCampaign:false}))
 console.log(`COMPLETE: one real-field development mission; stage ${record.summary.stage}; simulation ${simulationSeconds.toFixed(2)} s; independent audit required`)
}catch(e){write('failed.json',json({completed:false,error:String(e),failedAt:new Date().toISOString(),diagnosticOnly:true}));throw e}
finally{await bridge.close()}
