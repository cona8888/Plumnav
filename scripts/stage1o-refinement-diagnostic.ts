/** Post-hoc diagnosis of the retained Stage 1o contraction failure; not promotion. */
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {gzipSync,gunzipSync} from 'node:zlib'
import {fileURLToPath} from 'node:url'
import {refineHeadHistory} from './lib/si-head-motion'
import {stage1iSha256 as sha,stage1iStableJson as json} from './lib/stage1i-campaign-design'

const raw=resolve('research/evidence/si_head_motion_pilot_2026-09-16')
const analysis=JSON.parse(await readFile('research/results/si_head_motion_pilot_2026-09-16/analysis.json','utf8'))
const entry=analysis.rawInventory.find((r:any)=>r.index===68),body=await readFile(resolve(raw,entry.file))
if(sha(body)!==entry.sha256)throw Error('Original record checksum')
const original=JSON.parse(gunzipSync(body).toString())
if(original.spec.field!=='ridge'||original.spec.mode!==5||original.spec.replicate!==0)throw Error('Wrong diagnostic target')
const output=resolve('research/evidence/si_head_motion_refinement_diagnostic_2026-09-16');await mkdir(output)
const sourceBundle=await readFile(fileURLToPath(import.meta.url));await writeFile(resolve(output,'runner.mjs'),sourceBundle,{flag:'wx'})
const startedAt=new Date().toISOString(),start=performance.now(),inventory:any[]=[]
await writeFile(resolve(output,'manifest.json'),json({evidenceClass:'post-hoc numerical diagnosis; original failed gate unchanged',physicalIndex:68,originalRawSha256:sha(body),originalManifestSha256:sha(await readFile(resolve(raw,'manifest.json'))),dt:[.0078125,.00390625],scriptSha256:sha(await readFile('scripts/stage1o-refinement-diagnostic.ts')),basisSourceSha256:sha(await readFile('scripts/lib/si-head-motion.ts')),bundleSha256:sha(sourceBundle)}),{flag:'wx'})
for(const dt of [.0078125,.00390625]){
 const record=refineHeadHistory(original,dt),compressed=gzipSync(JSON.stringify(record)),file=`dt-${dt}.json.gz`
 await writeFile(resolve(output,file),compressed,{flag:'wx'});inventory.push({dt,file,sha256:sha(compressed),bytes:compressed.length})
 process.stdout.write(`Diagnostic dt=${dt}: ${record.trace.length} history rows\n`)
}
await writeFile(resolve(output,'complete.json'),json({complete:true,startedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,inventory}),{flag:'wx'})
