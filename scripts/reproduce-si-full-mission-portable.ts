import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {gzipSync,gunzipSync} from 'node:zlib'
import {runScanDisabledIntegration,replayScanDisabledIntegration} from './lib/si-scan-disabled-integration'
import {ReadoutExactBridge} from './lib/si-readout-exact-bridge'
import type {VerifierBridge} from './lib/si-integration'

const arg=(name:string)=>{const i=process.argv.indexOf(name);assert(i>=0&&process.argv[i+1]);return process.argv[i+1]!}
const root=resolve(arg('--package-root')),out=resolve(arg('--output'))
assert.equal(process.cwd(),root)
assert(out!==root&&!out.startsWith(root+'/'))
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const manifest=JSON.parse(readFileSync(resolve(root,'package-manifest.json'),'utf8'))
assert.equal(manifest.kind,'local-full-mission-scaffold-v1');assert.equal(manifest.publicRelease,false)
const protect=()=>{for(const f of manifest.files)assert.equal(sha(readFileSync(resolve(root,f.path))),f.sha256,f.path)}
protect()
const contract=JSON.parse(readFileSync(resolve(root,'contract.json'),'utf8'))
assert.equal(contract.case.id,'si-continuous-scan-disabled-n64')
assert.deepEqual(contract.equalityExclusions,['summary.rpcMilliseconds'])
assert.equal(contract.case.spec.replicate,3000);assert.equal(contract.case.spec.field,'si-continuous')
assert.equal(contract.case.spec.navDt,1/64);assert.equal(contract.case.acquisitionMode,'scan-disabled')
const referenceBytes=readFileSync(resolve(root,'fixtures/mission.json.gz'))
assert.equal(sha(referenceBytes),contract.referenceHistorySha256)
const write=(name:string,value:unknown)=>writeFileSync(resolve(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'})
const started=performance.now(),startedAt=new Date().toISOString()
const bridge=new ReadoutExactBridge(contract.bridgeSha256)
try{
 const record=await runScanDisabledIntegration(contract.case.spec,bridge as unknown as VerifierBridge)
 const bytes=gzipSync(JSON.stringify(record));writeFileSync(resolve(out,'mission.json.gz'),bytes,{flag:'wx'})
 const replay=replayScanDisabledIntegration(record)
 assert(replay.passed&&replay.schedulingTraceMatched&&replay.scanDisabledTraceMatched)
 assert.equal(record.development,null);assert.equal(record.summary.stage,'inspection-complete')
 assert.equal(record.visits.length,17);assert.equal(record.summary.retainedSamples,85)
 const reference=JSON.parse(gunzipSync(referenceBytes).toString())
 const reproduced=JSON.parse(gunzipSync(bytes).toString())
 const referenceRpc=reference.summary.rpcMilliseconds,currentRpc=reproduced.summary.rpcMilliseconds
 assert(Number.isFinite(referenceRpc)&&Number.isFinite(currentRpc))
 reference.summary.rpcMilliseconds=0;reproduced.summary.rpcMilliseconds=0
 assert.deepEqual(reproduced,reference,'Full record differs after sole declared wall-time exclusion')
 protect()
 write('reproduction.json',{passed:true,startedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-started)/1000,terminalRssBytes:process.memoryUsage().rss,historySha256:sha(bytes),bytes:bytes.length,referenceHistorySha256:contract.referenceHistorySha256,fullRecordMatched:true,equalityExclusions:contract.equalityExclusions,rpcWallMilliseconds:{reference:referenceRpc,reproduced:currentRpc},replay,stage:record.summary.stage,completedAt:record.summary.completedAt,packageManifestSha256:sha(readFileSync(resolve(root,'package-manifest.json'))),independentlyAudited:false,newPerformanceCase:false})
 console.log(JSON.stringify({passed:true,fullRecordMatched:true,decisionsChecked:replay.decisionsChecked,stage:record.summary.stage,completedAt:record.summary.completedAt}))
}catch(error){write('reproduction_failure.json',{passed:false,error:String(error),at:new Date().toISOString(),newPerformanceCase:false});throw error}
finally{await bridge.close()}
