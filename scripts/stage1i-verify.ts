import {readFile,readdir,writeFile,rename} from 'node:fs/promises'
import {resolve} from 'node:path'
import {gunzipSync} from 'node:zlib'
import {buildStage1iCases,buildStage1iConfig,buildStage1iManifest,stage1iSha256,stage1iStableJson,STAGE1I_SMOKE_INDICES} from './lib/stage1i-campaign-design'

const arg=(name:string,fallback?:string)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1]},output=resolve(arg('output','stage1i-output')!),mode=arg('mode','smoke') as 'smoke'|'production',shards=Number(arg('shards','4'))
const expectedCases=buildStage1iCases(),expectedSet=new Set(mode==='smoke'?STAGE1I_SMOKE_INDICES:expectedCases.map(c=>c.index)),manifest=buildStage1iManifest(),failures:string[]=[],records:any[]=[]
for(let shard=0;shard<shards;shard++){
 const dir=resolve(output,`worker-${shard}`),complete=JSON.parse(await readFile(resolve(dir,'complete.json'),'utf8')),workerManifest=JSON.parse(await readFile(resolve(dir,'manifest.json'),'utf8'))
 if(!complete.complete||complete.expected!==complete.completed)failures.push(`worker-${shard}: incomplete marker`)
 if(workerManifest.manifestSha256!==manifest.manifestSha256||workerManifest.mode!==mode||workerManifest.shardIndex!==shard||workerManifest.shardCount!==shards)failures.push(`worker-${shard}: manifest mismatch`)
 const actualFiles=new Set((await readdir(dir)).filter(f=>f.startsWith('block-')&&f.endsWith('.json.gz')))
 for(const item of complete.inventory){if(!actualFiles.delete(item.file))failures.push(`worker-${shard}: missing ${item.file}`);const body=await readFile(resolve(dir,item.file));if(stage1iSha256(body)!==item.sha256||body.byteLength!==item.bytes)failures.push(`worker-${shard}: checksum ${item.file}`);const block=JSON.parse(gunzipSync(body).toString('utf8'));if(block.schemaVersion!=='si-pose-registration-block-v1')failures.push(`worker-${shard}: block schema`);records.push(...block.records)}
 if(actualFiles.size)failures.push(`worker-${shard}: unlisted blocks ${[...actualFiles]}`)
}
const indices=records.map(r=>r.spec?.index),actualSet=new Set(indices)
if(indices.length!==expectedSet.size||actualSet.size!==indices.length)failures.push(`record cardinality expected ${expectedSet.size} got ${indices.length}/${actualSet.size} unique`)
for(const i of expectedSet)if(!actualSet.has(i))failures.push(`missing case ${i}`)
for(const r of records){const i=r.spec?.index,e=expectedCases[i];if(!e||stage1iStableJson(r.spec)!==stage1iStableJson(e))failures.push(`case ${i}: spec mismatch`);if(r.configSha256!==stage1iSha256(stage1iStableJson(buildStage1iConfig(e?.field))))failures.push(`case ${i}: config hash`);if(r.visits?.length!==17||r.actualSamples?.length!==17||r.visits?.some((v:any,j:number)=>v.closedAt===null||v.samples.length<2||v.samples.length!==r.actualSamples[j]?.length))failures.push(`case ${i}: incomplete visits/samples`);if(r.result?.status==='incomplete'||r.summary?.completedAt===null)failures.push(`case ${i}: incomplete result`);if(r.summary?.nativeDeclaration||r.summary?.nativeAbstention)failures.push(`case ${i}: native terminal claim`);if(r.positionOffsetsMetres?.some((v:any)=>Math.hypot(v.x,v.y)>r.spec.uncertainty.positionRadiusMetres+1e-12))failures.push(`case ${i}: error bound`)}
if(mode==='production')for(const c of expectedCases.filter(c=>c.kind==='position'&&c.uncertainty.registration==='observed')){const mate=expectedCases[c.index+1];if(!mate||mate.field!==c.field||mate.replicate!==c.replicate||mate.uncertainty.registration!=='commanded'||stage1iStableJson(c.uncertainty).replace('observed','commanded')!==stage1iStableJson(mate.uncertainty))failures.push(`pair ${c.index}: broken design`)}
const result={schemaVersion:'si-pose-registration-verification-v1',accepted:failures.length===0,mode,expectedRecords:expectedSet.size,actualRecords:records.length,uniqueRecords:actualSet.size,manifestSha256:manifest.manifestSha256,statusCounts:Object.fromEntries([...new Set(records.map(r=>r.result.status))].map(s=>[s,records.filter(r=>r.result.status===s).length])),failures:failures.slice(0,100),verifiedAt:new Date().toISOString()}
const target=resolve(output,'verification.json'),partial=`${target}.partial`;await writeFile(partial,stage1iStableJson(result));await rename(partial,target);process.stdout.write(stage1iStableJson(result));if(!result.accepted)process.exitCode=1
