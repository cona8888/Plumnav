import assert from 'node:assert/strict'
import {fork} from 'node:child_process'
import type {ChildProcess} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync,mkdirSync,appendFileSync,statfsSync} from 'node:fs'
import {join,dirname,resolve} from 'node:path'
import {gzipSync,gunzipSync} from 'node:zlib'
import {fileURLToPath} from 'node:url'
import {arch,platform,cpus,totalmem} from 'node:os'
import {DESIGN} from './lib/outdoor-detectability'
import {BUDGET} from './lib/outdoor-budget'
import {CAMPAIGN,campaignSpecs,makeCampaignTrace} from './lib/outdoor-budget-campaign'
import type {Mode} from './lib/outdoor-budget-campaign'

const RAW='research/results/outdoor_budget_development_v1_2026-09-22'
const REVIEW='research/results/outdoor_budget_reference_review_v2_2026-09-22'
const SOURCES=['scripts/lib/outdoor-budget-campaign.ts','scripts/run-outdoor-budget-campaign.ts',
  'scripts/audit-outdoor-budget-campaign.py','scripts/test-outdoor-budget-campaign.ts',
  'scripts/test-outdoor-budget-campaign.py','research/protocols/outdoor_budget_campaign_v1_2026-09-22.md',
  'outputs/run-outdoor-budget-campaign.mjs','outputs/outdoor-budget-campaign.meta.json']
type HashRow={file:string;sha256:string}
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'))
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex')
const sha=(p:string)=>hash(readFileSync(p))
function frozen(){
  const c=read(join(REVIEW,'closure.json')),rm=read(join(REVIEW,'manifest.json')),raw=read(join(RAW,'manifest.json'))
  assert.equal(c.accepted,true);assert.equal(c.auditSha256,'6851cf735de73586d03d9313a6975684ad6730c4b4703b151a0ba762bd028672')
  assert.equal(c.auditSha256,sha(join(REVIEW,'audit.json')));assert.equal(c.manifestSha256,sha(join(REVIEW,'manifest.json')))
  assert.equal(c.inputManifestSha256,sha(join(RAW,'manifest.json')));assert.equal(c.inputExecutionSha256,sha(join(RAW,'execution-complete.json')))
  assert.equal(c.preservedFailedAuditSha256,sha(join(RAW,'audit.failed.json')))
  for(const r of read(join(RAW,'execution-complete.json')).files){
    assert.equal(sha(join(RAW,r.file)),r.sha256)
    if(r.reference)assert.equal(sha(join(RAW,r.reference.file)),r.reference.sha256)
  }
  const sources=new Map<string,HashRow>()
  for(const [root,m] of [[RAW,raw],[REVIEW,rm]] as const)for(const r of m.sourceHashes as HashRow[]){
    assert.equal(sha(r.file),r.sha256);assert.equal(sha(join(root,'source-snapshot',r.file)),r.sha256);sources.set(r.file,r)
  }
  const stage=raw.frozen.stage2i;assert.equal(stage.hashes.length,141);assert.equal(sha(stage.bundle),stage.bundleSha256)
  for(const r of stage.hashes as HashRow[])assert.equal(sha(r.file),r.sha256)
  return {rawDirectory:resolve(RAW),reviewDirectory:resolve(REVIEW),reviewClosureSha256:sha(join(REVIEW,'closure.json')),
    rawManifestSha256:sha(join(RAW,'manifest.json')),rawExecutionSha256:sha(join(RAW,'execution-complete.json')),
    sourceHashes:[...sources.values()]}
}
type Receipt={index:number;file:string;sha256:string;bytes:number;pid:number;startedMs:number;endedMs:number;
  seconds:number;userCpuMicroseconds:number;systemCpuMicroseconds:number;rssBytes:number;compatibilityPassed:boolean}
const [flag,modeArg,outArg,smokeArg]=process.argv.slice(2)
if(flag==='--worker'){
  const output=modeArg!;assert.equal(process.argv.length,4)
  const m=read(join(output,'manifest.json'))
  process.on('message',(message:{index?:number;stop?:boolean})=>{
    if(message.stop){process.disconnect!();return}
    const index=message.index!;assert.ok(Number.isInteger(index)&&m.specs[index])
    const startedMs=Date.now(),cpu=process.cpuUsage(),trace=makeCampaignTrace(m.specs[index],m.mode)
    if(m.mode==='smoke'){
      const n=[0,3,6,9][index]!
      const old=JSON.parse(gunzipSync(readFileSync(join(RAW,`trace-${String(n).padStart(3,'0')}.json.gz`))).toString())
      assert.deepEqual({...trace,schemaVersion:BUDGET.version},old)
    }
    const file=`trace-${String(index).padStart(3,'0')}.json.gz`,bytes=gzipSync(JSON.stringify(trace))
    writeFileSync(join(output,file),bytes,{flag:'wx'})
    const used=process.cpuUsage(cpu),endedMs=Date.now()
    const receipt:Receipt={index,file,sha256:hash(bytes),bytes:bytes.length,pid:process.pid,startedMs,endedMs,
      seconds:(endedMs-startedMs)/1000,userCpuMicroseconds:used.user,systemCpuMicroseconds:used.system,
      rssBytes:process.memoryUsage().rss,compatibilityPassed:m.mode==='smoke'}
    writeFileSync(join(output,`trace-${String(index).padStart(3,'0')}.receipt.json`),JSON.stringify(receipt)+'\n',{flag:'wx'})
    process.send!({receipt})
  })
  process.send!({ready:true})
}else{
  if(flag!=='--mode'||!['smoke','campaign'].includes(modeArg??'')||!outArg||
    (modeArg==='campaign'?!smokeArg:!!smokeArg))throw Error('Usage: --mode smoke NEW_DIR | --mode campaign NEW_DIR ACCEPTED_SMOKE_DIR')
  const mode=modeArg as Mode,output=resolve(outArg),development=frozen()
  const sourceHashes=[...development.sourceHashes,...SOURCES.map(file=>({file,sha256:sha(file)}))]
  let smokeEvidence=null
  if(mode==='campaign'){
    const s=read(join(smokeArg!,'audit.json')),c=read(join(smokeArg!,'closure.json')),m=read(join(smokeArg!,'manifest.json'))
    assert.equal(c.accepted,true);assert.equal(sha(join(smokeArg!,'audit.json')),c.auditSha256)
    assert.equal(s.mode,'smoke');assert.equal(s.accepted,true);assert.equal(s.compatibilityPassed,true);assert.equal(s.maxConcurrentWorkers,4)
    assert.equal(sha(join(smokeArg!,'manifest.json')),s.manifestSha256);assert.deepEqual(m.sourceHashes,sourceHashes)
    for(const r of read(join(smokeArg!,'execution-complete.json')).files)assert.equal(sha(join(smokeArg!,r.file)),r.sha256)
    assert.ok(read(join(REVIEW,'audit.json')).projectedEndToEndWith25PercentHeadroomSeconds<CAMPAIGN.maxRuntimeSeconds)
    smokeEvidence={directory:resolve(smokeArg!),closureSha256:sha(join(smokeArg!,'closure.json')),auditSha256:sha(join(smokeArg!,'audit.json'))}
  }
  const disk=statfsSync('.');assert.ok(disk.bavail*disk.bsize>1024**3,'Need at least 1 GiB free')
  mkdirSync(output)
  const write=(name:string,data:unknown)=>writeFileSync(join(output,name),JSON.stringify(data)+'\n',{flag:'wx'})
  for(const r of sourceHashes){const dest=join(output,'source-snapshot',r.file);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(r.file),{flag:'wx'})}
  const specs=campaignSpecs(mode),startedMs=Date.now()
  write('manifest.json',{schemaVersion:CAMPAIGN.version,mode,createdAt:new Date(startedMs).toISOString(),baseDesign:DESIGN,
    developmentDesign:BUDGET,campaign:CAMPAIGN,specs,sourceHashes,development,smokeEvidence,
    runtime:{node:process.version,arch:arch(),platform:platform(),cpus:cpus().length,totalMemoryBytes:totalmem(),supervisorPid:process.pid}})
  const children:ChildProcess[]=[],receipts:Receipt[]=[],exits:{pid:number;code:number}[]=[]
  const event=(data:object)=>appendFileSync(join(output,'execution-events.jsonl'),JSON.stringify({at:Date.now(),...data})+'\n')
  let next=0,failed=false
  try{
    await new Promise<void>((accept,reject)=>{
      const abort=(error:Error)=>{if(failed)return;failed=true;clearTimeout(timer);for(const c of children)if(c.exitCode===null)c.kill('SIGTERM');reject(error)}
      const timer=setTimeout(()=>abort(Error('One-hour execution cap exceeded')),CAMPAIGN.maxRuntimeSeconds*1000)
      const assign=(child:ChildProcess)=>{if(failed)return;if(next<specs.length){const index=next++;event({assigned:index,pid:child.pid});child.send({index})}else child.send({stop:true})}
      for(let i=0;i<CAMPAIGN.workers;i++){
        const child=fork(fileURLToPath(import.meta.url),['--worker',output],{stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}})
        children.push(child);child.stderr!.on('data',(b:Buffer)=>appendFileSync(join(output,`worker-${i}.stderr.log`),b));child.on('error',abort)
        child.on('message',(m:{ready?:boolean;receipt?:Receipt})=>{
          if(m.ready){event({started:true,worker:i,pid:child.pid});assign(child)}
          else if(m.receipt){receipts.push(m.receipt);event({completed:m.receipt.index,pid:child.pid});
            if(receipts.length%16===0||receipts.length===specs.length)console.log(JSON.stringify({finished:receipts.length,expected:specs.length,seconds:(Date.now()-startedMs)/1000}));assign(child)}
          else abort(Error('Unknown worker message'))
        })
        child.on('exit',(code,signal)=>{event({exited:true,pid:child.pid,code,signal});if(code!==0){abort(Error(`Worker failed ${code}/${signal}`));return}
          exits.push({pid:child.pid!,code});if(exits.length===CAMPAIGN.workers){clearTimeout(timer);receipts.length===specs.length?accept():reject(Error('Incomplete set'))}})
      }
    })
    receipts.sort((a,b)=>a.index-b.index);assert.deepEqual(receipts.map(r=>r.index),specs.map((_,i)=>i))
    for(const r of sourceHashes)assert.equal(sha(r.file),r.sha256);assert.deepEqual(frozen(),development)
    write('execution-complete.json',{executionComplete:true,independentlyAccepted:false,files:receipts,exits,
      seconds:(Date.now()-startedMs)/1000,manifestSha256:sha(join(output,'manifest.json')),eventLogSha256:sha(join(output,'execution-events.jsonl'))})
    console.log(JSON.stringify({executionComplete:true,independentlyAccepted:false,mode,output,seconds:(Date.now()-startedMs)/1000}))
  }catch(error){write('failure.json',{failed:true,diagnosticOnly:true,error:String(error)});throw error}
}
