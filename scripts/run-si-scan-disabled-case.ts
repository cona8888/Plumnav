import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {resolve} from 'node:path'
import {runScanDisabledIntegration,replayScanDisabledIntegration} from './lib/si-scan-disabled-integration'
import {ReadoutExactBridge} from './lib/si-readout-exact-bridge'
import type {VerifierBridge} from './lib/si-integration'
import type {ResponseSpec} from './lib/si-response-design'

const argument=(name:string)=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw Error(`Missing ${name}`);return process.argv[i+1]!}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const root=resolve(argument('--root')),caseId=argument('--case')
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
const item=manifest.cases.find((x:any)=>x.id===caseId)
assert(item&&!item.reused);assert.equal(manifest.version,'scan-disabled-mission-admission-v1')
const protect=()=>{for(const row of manifest.sources)assert.equal(sha(readFileSync(row.path)),row.sha256,row.path)}
protect()
const spec:ResponseSpec=item.spec
assert.equal(spec.replicate,3000);assert(['si-continuous','si-pulse','blank'].includes(spec.field));assert.equal(spec.index,0)
assert([1/16,1/32,1/64].includes(spec.navDt));assert.equal(item.kind,'candidate');assert.equal(item.acquisitionMode,'scan-disabled');assert.equal(spec.policy,'reference')
const out=resolve(root,caseId,'run');mkdirSync(out)
const write=(name:string,value:any)=>writeFileSync(resolve(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'})
const start=performance.now(),startedAt=new Date().toISOString()
write('manifest.json',{version:manifest.version,caseId,item,startedAt,parentManifestSha256:sha(readFileSync(resolve(root,'manifest.json')))})
const bridge=new ReadoutExactBridge(manifest.sources.find((x:any)=>x.path==='scripts/si-readout-exact-bridge.py').sha256)
try{
 const rpc=bridge as unknown as VerifierBridge
 const record=await runScanDisabledIntegration(spec,rpc)
 const simulationSeconds=(performance.now()-start)/1000
 const bytes=gzipSync(JSON.stringify(record));writeFileSync(resolve(out,'mission.json.gz'),bytes,{flag:'wx'})
 assert.equal(record.development,null);assert.equal(record.summary.acquisitionBudgetSeconds,600)
 assert(record.summary.completedAt>=600&&record.summary.completedAt<=1200)
 assert(['inspection-complete','no-eligible-nomination','mission-budget-exhausted'].includes(record.summary.stage))
 const replay=replayScanDisabledIntegration(record)
 assert(replay.passed&&replay.schedulingTraceMatched&&replay.scanDisabledTraceMatched);protect()
 write('complete.json',{completed:true,caseId,item,startedAt,finishedAt:new Date().toISOString(),simulationSeconds,elapsedSeconds:(performance.now()-start)/1000,terminalRssBytes:process.memoryUsage().rss,historySha256:sha(bytes),bytes:bytes.length,replay,stage:record.summary.stage,completedAt:record.summary.completedAt,independentlyAudited:false,developmentOnly:true,acquisitionMode:record.acquisitionMode,inspectionPathExercised:record.summary.inspectionAt!==null})
 console.log(`SAVED ${caseId}: ${record.summary.stage}; public replay passed`)
}catch(error){write('failed.json',{completed:false,caseId,error:String(error),at:new Date().toISOString(),diagnosticOnly:true});throw error}
finally{await bridge.close()}
