import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {gzipSync} from 'node:zlib'
import {spawnSync} from 'node:child_process'
import {runReadoutIntegration,replayReadoutIntegration} from './lib/si-readout-integration'
import {runScanDisabledIntegration,replayScanDisabledIntegration} from './lib/si-scan-disabled-integration'
import {MechanismBridgeV2} from './lib/si-mechanism-bridge-v2'
import type {VerifierBridge} from './lib/si-integration'
import type {ResponseSpec} from './lib/si-response-design'

const arg=(name:string)=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw Error('Missing '+name);return process.argv[i+1]!}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const manifestPath=resolve(arg('--manifest')),expected=arg('--sha256'),bytes=readFileSync(manifestPath)
assert.equal(sha(bytes),expected)
assert(process.env.PYTHON)
// The strict parser checks duplicate JSON keys, the entire case set and all source pins.
const check=spawnSync(process.env.PYTHON,['-B','scripts/check-si-mechanism-manifest-v2.py','--manifest',manifestPath,'--sha256',expected],{stdio:'inherit',timeout:30000})
assert.equal(check.status,0,'Manifest admission failed')
const m=JSON.parse(bytes.toString())
if(process.argv.includes('--dry-run')){console.log(JSON.stringify({passed:true,cases:m.cases.length,newMissions:0}));process.exit(0)}
// Fresh performance execution remains fail-closed until a separate admission release.
assert.equal(m.purpose,'full-development-worker-admission','Fresh campaign execution is not authorised/admitted')
const c=m.cases.find((x:any)=>x.id===arg('--case'));assert(c,'Unknown case')
const w=m.worlds.find((x:any)=>x.key===c.worldKey);assert(w)
const spec:ResponseSpec=c.spec
const out=resolve(arg('--output'));mkdirSync(out,{recursive:false})
const write=(name:string,data:any)=>writeFileSync(resolve(out,name),JSON.stringify(data,null,2)+'\n',{flag:'wx'})
write('manifest.json',{version:'mechanism-worker-case-v2',parentManifestSha256:expected,case:c,world:w})
const start=performance.now(),startedAt=new Date().toISOString()
const context={caseId:c.id,worldKey:c.worldKey,arm:c.arm,field:spec.field,reportingReplicate:w.reportingReplicate}
const bridge=new MechanismBridgeV2(expected,manifestPath,context,m.sources.find((r:any)=>r.path==='scripts/si-mechanism-bridge-v2.py').sha256)
let bridgeClosed=false
try{
  const rpc=bridge as unknown as VerifierBridge
  const record=c.arm==='NS'?await runScanDisabledIntegration(spec,rpc):await runReadoutIntegration(spec,rpc,['RW','GW'].includes(c.arm)?'original-withheld':'live-passive')
  const simulationSeconds=(performance.now()-start)/1000
  const body=gzipSync(JSON.stringify(record));writeFileSync(resolve(out,'mission.json.gz'),body,{flag:'wx'})
  assert.equal(record.development,null);assert.equal(record.summary.acquisitionBudgetSeconds,600)
  assert(record.summary.completedAt>=600&&record.summary.completedAt<=1200)
  const replay=c.arm==='NS'?replayScanDisabledIntegration(record as Awaited<ReturnType<typeof runScanDisabledIntegration>>):replayReadoutIntegration(record)
  assert(replay.passed&&replay.privateFieldQueries===0&&replay.schedulingTraceMatched)
  await bridge.close();bridgeClosed=true
  for(const r of m.sources)assert.equal(sha(readFileSync(r.path)),r.sha256,r.path)
  write('complete.json',{completed:true,caseId:c.id,case:c,parentManifestSha256:expected,startedAt,finishedAt:new Date().toISOString(),simulationSeconds,elapsedSeconds:(performance.now()-start)/1000,terminalRssBytes:process.memoryUsage().rss,historySha256:sha(body),bytes:body.length,replay,verifierCalls:bridge.calls,stage:record.summary.stage,completedAt:record.summary.completedAt,independentlyAudited:false,developmentOnly:true,performanceCampaign:false})
  console.log('SAVED '+c.id+'; public replay passed; independent audit required')
}catch(e){write('failed.json',{completed:false,error:String(e),diagnosticOnly:true});throw e}
finally{if(!bridgeClosed)await bridge.close()}
