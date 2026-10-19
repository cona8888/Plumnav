import assert from 'node:assert/strict'
import {fork} from 'node:child_process'
import type {ChildProcess} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync, mkdirSync, appendFileSync} from 'node:fs'
import {join, dirname, resolve} from 'node:path'
import {gzipSync} from 'node:zlib'
import {fileURLToPath} from 'node:url'
import {arch, platform, cpus, totalmem} from 'node:os'
import {DESIGN, makeTrace} from './lib/outdoor-detectability'
import {BUDGET, budgetSpecs, makeBudgetTrace} from './lib/outdoor-budget'

const SOURCES = ['scripts/lib/outdoor-budget.ts', 'scripts/run-outdoor-budget.ts',
  'scripts/audit-outdoor-budget.py', 'scripts/test-outdoor-budget.ts', 'scripts/test-outdoor-budget.py',
  'research/protocols/outdoor_mission_budget_development_v1_2026-09-22.md',
  'outputs/run-outdoor-budget.mjs', 'outputs/outdoor-budget.meta.json']
const HOLDOUT = 'research/results/outdoor_holdout_campaign_v1_2026-09-22'
const MECHANISM = 'research/results/outdoor_mechanism_diagnostic_v1_2026-09-22'
type HashRow = {file: string; sha256: string}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const sha = (path: string) => hash(readFileSync(path))
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
function frozen() {
  const roots = [HOLDOUT, MECHANISM], sources = new Map<string, HashRow>()
  const manifestPins = ['4b26f5e096d1a1e88e75fb9164b3a24a737ddda069832c366108d66e26158b9a',
    '869e7d3475a815333a2b50eceb943fa2911804147569729f1b855cec29eff782']
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]!, c = read(join(root, 'closure.json')), m = read(join(root, 'manifest.json'))
    assert.equal(c.accepted, true); assert.equal(sha(join(root,'manifest.json')), manifestPins[i])
    for (const [key, file] of Object.entries({manifest:'manifest.json', audit:'audit.json', report:'report.md'}))
      assert.equal(c[key+'Sha256'], sha(join(root,file)))
    for (const r of m.sourceHashes as HashRow[]) {
      assert.equal(sha(r.file), r.sha256); assert.equal(sha(join(root,'source-snapshot',r.file)),r.sha256)
      sources.set(r.file,r)
    }
  }
  const hm = read(join(HOLDOUT,'manifest.json')), stage = hm.pilot.manifest.frozenStage2i
  assert.equal(stage.hashes.length,141); assert.equal(sha(stage.bundle),stage.bundleSha256)
  for (const r of stage.hashes as HashRow[]) assert.equal(sha(r.file),r.sha256)
  const completed = read(join(HOLDOUT,'execution-complete.json'))
  assert.equal(sha(join(HOLDOUT,'execution-complete.json')),read(join(HOLDOUT,'audit.json')).executionReceiptSha256)
  for (const r of completed.files) assert.equal(sha(join(HOLDOUT,r.file)),r.sha256)
  const mc = read(join(MECHANISM,'closure.json'))
  assert.equal(sha(join(MECHANISM,'diagnostics.json.gz')),mc.diagnosticsSha256)
  assert.equal(sha(join(MECHANISM,'summary.json')),mc.summarySha256)
  return {roots: roots.map(directory=>({directory,closureSha256:sha(join(directory,'closure.json'))})),
    stage2i: stage, sources: [...sources.values()]}
}
type FileReceipt = {file: string; sha256: string; bytes: number}
type Receipt = FileReceipt & {index:number; startedMs:number; endedMs:number; seconds:number;
  extendedSeconds:number; referenceSeconds:number; reference:FileReceipt|null; compatibilityPassed:boolean;
  pid:number; userCpuMicroseconds:number; systemCpuMicroseconds:number; rssBytes:number}
const [flag,arg] = process.argv.slice(2)
if (flag === '--worker') {
  if (!arg || process.argv.length !== 4) throw Error('Worker arguments')
  const output = arg, manifest = read(join(output,'manifest.json'))
  function save(name:string, data:unknown): FileReceipt {
    const bytes = gzipSync(JSON.stringify(data)); writeFileSync(join(output,name),bytes,{flag:'wx'})
    return {file:name,sha256:hash(bytes),bytes:bytes.length}
  }
  process.on('message',(message:{index?:number;stop?:boolean})=>{
    if(message.stop){process.disconnect!();return}
    const index=message.index!; assert.ok(Number.isInteger(index)&&manifest.specs[index])
    const startedMs=Date.now(), cpu=process.cpuUsage(), trace=makeBudgetTrace(manifest.specs[index])
    const file=save(`trace-${String(index).padStart(3,'0')}.json.gz`,trace)
    const extendedSeconds=(Date.now()-startedMs)/1000, referenceStart=Date.now()
    let reference:FileReceipt|null=null, compatibilityPassed=false
    if(trace.spec.resolution===0){
      const legacy=makeTrace(trace.spec), n=600/trace.resolution.dt
      assert.deepEqual(trace.inlet.slice(0,n),legacy.inlet)
      assert.deepEqual(trace.noise.slice(0,600),legacy.noise)
      assert.deepEqual(trace.world,legacy.world); assert.deepEqual(trace.fieldSettings,legacy.fieldSettings)
      for(const m of trace.measurements){
        const old=legacy.measurements.find(o=>o.rateKgPerSecond===m.rateKgPerSecond&&o.sensor.id===m.sensor.id)!
        assert.deepEqual(m.readings.slice(0,600),old.readings)
        assert.equal(m.outcomes[0]!.alarmSeconds,old.outcomes.find(o=>o.k===5)!.alarmSeconds)
      }
      reference=save(`reference-${String(index).padStart(3,'0')}.json.gz`,legacy); compatibilityPassed=true
    }
    const used=process.cpuUsage(cpu), endedMs=Date.now()
    const receipt:Receipt={...file,index,startedMs,endedMs,seconds:(endedMs-startedMs)/1000,
      extendedSeconds, referenceSeconds:reference?(endedMs-referenceStart)/1000:0, reference,compatibilityPassed,
      pid:process.pid,userCpuMicroseconds:used.user,systemCpuMicroseconds:used.system,rssBytes:process.memoryUsage().rss}
    writeFileSync(join(output,`trace-${String(index).padStart(3,'0')}.receipt.json`),JSON.stringify(receipt)+'\n',{flag:'wx'})
    process.send!({receipt})
  })
  process.send!({ready:true,pid:process.pid})
} else {
  if(flag!=='--output'||!arg||process.argv.length!==4) throw Error('Usage: --output NEW_DIRECTORY (development only)')
  const output=resolve(arg), guard=frozen()
  const sourceHashes=[...guard.sources,...SOURCES.map(file=>({file,sha256:sha(file)}))]
  mkdirSync(output)
  const write=(name:string,data:unknown)=>writeFileSync(join(output,name),JSON.stringify(data)+'\n',{flag:'wx'})
  for(const r of sourceHashes){const p=join(output,'source-snapshot',r.file);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,readFileSync(r.file),{flag:'wx'})}
  const specs=budgetSpecs(), startedMs=Date.now()
  write('manifest.json',{schemaVersion:BUDGET.version,mode:'development',createdAt:new Date(startedMs).toISOString(),
    baseDesign:DESIGN,budget:BUDGET,specs,sourceHashes,frozen:guard,
    runtime:{node:process.version,arch:arch(),platform:platform(),cpus:cpus().length,totalMemoryBytes:totalmem(),supervisorPid:process.pid}})
  const children:ChildProcess[]=[], receipts:Receipt[]=[], exits:{pid:number;code:number}[]=[]
  const event=(data:object)=>appendFileSync(join(output,'execution-events.jsonl'),JSON.stringify({at:Date.now(),...data})+'\n')
  let next=0,failed=false
  try {
    await new Promise<void>((accept,reject)=>{
      const abort=(error:Error)=>{if(failed)return;failed=true;clearTimeout(timer);for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');reject(error)}
      const timer=setTimeout(()=>abort(Error('Development runtime cap exceeded')),BUDGET.maxRuntimeSeconds*1000)
      const assign=(child:ChildProcess)=>{if(failed)return;if(next<specs.length){const index=next++;event({assigned:index,pid:child.pid});child.send({index})}else child.send({stop:true})}
      for(let i=0;i<BUDGET.workers;i++){
        const child=fork(fileURLToPath(import.meta.url),['--worker',output],{stdio:['ignore','ignore','pipe','ipc'],
          env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}})
        children.push(child);child.stderr!.on('data',(b:Buffer)=>appendFileSync(join(output,`worker-${i}.stderr.log`),b))
        child.on('error',abort)
        child.on('message',(m:{ready?:boolean;receipt?:Receipt})=>{
          if(m.ready){event({started:true,worker:i,pid:child.pid});assign(child)}
          else if(m.receipt){receipts.push(m.receipt);event({completed:m.receipt.index,pid:child.pid});console.log(JSON.stringify({finished:receipts.length,expected:specs.length,index:m.receipt.index,seconds:(Date.now()-startedMs)/1000}));assign(child)}
          else abort(Error('Unknown worker message'))
        })
        child.on('exit',(code,signal)=>{
          event({exited:true,pid:child.pid,code,signal});if(code!==0){abort(Error(`Worker failed ${code}/${signal}`));return}
          exits.push({pid:child.pid!,code});if(exits.length===BUDGET.workers){clearTimeout(timer);receipts.length===specs.length?accept():reject(Error('Incomplete set'))}
        })
      }
    })
    receipts.sort((a,b)=>a.index-b.index);assert.deepEqual(receipts.map(r=>r.index),specs.map((_,i)=>i))
    for(const r of sourceHashes)assert.equal(sha(r.file),r.sha256)
    assert.deepEqual(frozen(),guard)
    write('execution-complete.json',{executionComplete:true,independentlyAccepted:false,files:receipts,exits,
      seconds:(Date.now()-startedMs)/1000,manifestSha256:sha(join(output,'manifest.json')),eventLogSha256:sha(join(output,'execution-events.jsonl'))})
    console.log(JSON.stringify({executionComplete:true,independentlyAccepted:false,output,seconds:(Date.now()-startedMs)/1000}))
  }catch(error){write('failure.json',{failed:true,diagnosticOnly:true,error:String(error)});throw error}
}
