import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {gzipSync,gunzipSync} from 'node:zlib'
import {responseCases,responseConfig,responsePlan} from './lib/si-response-design'
import {ResponseVerifierBridge,runResponseFixtureIntegration} from './lib/si-response-fixture'
import {replayResponseIntegration} from './lib/si-response-integration'
import {runLinearIntegration,replayLinearIntegration} from './lib/si-linear-integration'
import type {VerifierBridge} from './lib/si-integration'
import {stage1iSha256 as sha,stage1iStableJson as json} from './lib/stage1i-campaign-design'

const arg=(key:string)=>{const i=process.argv.indexOf(`--${key}`);if(i<0||!process.argv[i+1])throw Error(`Missing ${key}`);return process.argv[i+1]!}
const mode=arg('mode')
if(mode==='plan')process.stdout.write(json(responsePlan()))
else{
 if(!['nominal-preflight','nominal-only'].includes(mode))throw Error('Invalid mode')
 const cases=responseCases(mode as 'nominal-preflight'|'nominal-only'),worker=Number(arg('worker')),output=resolve(arg('output'))
 if(!Number.isInteger(worker)||worker<0||worker>=4)throw Error('Invalid worker')
 const manifest=JSON.parse(await readFile(resolve(output,'manifest.json'),'utf8'))
 if(json(manifest.cases)!==json(cases)||json(manifest.configs)!==json(cases.map(responseConfig)))throw Error('Frozen plan mismatch')
 const dir=resolve(output,`worker-${worker}`);await mkdir(dir)
 const write=(name:string,body:string|Uint8Array)=>writeFile(resolve(dir,name),body,{flag:'wx'})
 const startedAt=new Date().toISOString(),start=performance.now(),assigned=cases.filter(s=>s.index%4===worker),inventory:any[]=[]
 await write('started.json',json({worker,pid:process.pid,startedAt,node:process.version,architecture:process.arch}))
 const bridge=new ResponseVerifierBridge();let maxRssBytes=0
 try{
  for(const s of assigned){
   const t=performance.now(),record=await runResponseFixtureIntegration(s,bridge),simulationSeconds=(performance.now()-t)/1000
   const replay=replayResponseIntegration(record);let compatibility:any=null
   if(s.caseRole==='compatibility'){
    const referenceRoot=resolve(arg('reference-root')),index=s.referenceIndex!,folder=`worker-${index%4}`
    const receipt=JSON.parse(await readFile(resolve(referenceRoot,folder,`case-${String(index).padStart(3,'0')}.receipt.json`),'utf8'))
    const bytes=await readFile(resolve(referenceRoot,folder,receipt.file));if(sha(bytes)!==receipt.sha256)throw Error('Reference checksum')
    const cloud=JSON.parse(gunzipSync(bytes).toString())
    const base=await runLinearIntegration(cloud.spec,bridge as unknown as VerifierBridge)
    const old={...base,reportingFixture:{...record.reportingFixture,reportingReplicate:600000+base.spec.replicate}}
    const referenceReplay=replayLinearIntegration(old),referenceBody=gzipSync(JSON.stringify(old)),referenceFile=`case-${String(s.index).padStart(3,'0')}.reference.gz`
    await write(referenceFile,referenceBody)
    const normalized={...record,spec:old.spec,reportingFixture:old.reportingFixture,summary:{...record.summary,rpcMilliseconds:0}}
    const oldNormalized={...old,summary:{...old.summary,rpcMilliseconds:0}}
    const normalizedSha256=sha(json(normalized));if(normalizedSha256!==sha(json(oldNormalized)))throw Error(`Reference history changed: ${index}`)
    compatibility={passed:true,referenceIndex:index,referenceSha256:receipt.sha256,referenceFile,samePlatformReferenceSha256:sha(referenceBody),referenceReplay,normalizedSha256,excluded:['spec','summary.rpcMilliseconds']}
   }
   if(!replay.passed||!replay.schedulingTraceMatched||replay.privateFieldQueries!==0)throw Error('Public replay failed')
   const body=gzipSync(JSON.stringify(record)),file=`case-${String(s.index).padStart(3,'0')}.json.gz`
   await write(file,body);maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
   const item={index:s.index,file,sha256:sha(body),bytes:body.length,simulationSeconds,elapsedSeconds:(performance.now()-t)/1000,replay,compatibility}
   inventory.push(item);await write(`case-${String(s.index).padStart(3,'0')}.receipt.json`,json(item))
   process.stdout.write(`worker ${worker}: ${inventory.length}/${assigned.length}; case ${s.index}; ${simulationSeconds.toFixed(2)} s\n`)
  }
 }finally{await bridge.close()}
 await write('complete.json',json({complete:true,worker,pid:process.pid,startedAt,finishedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,maxRssBytes,inventory}))
}
