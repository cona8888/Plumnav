import {spawn,execFileSync} from 'node:child_process'
import {mkdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
const dir=resolve(process.argv[2]??'research/results/m51-gaden-native-smoke-v1');mkdirSync(dir,{recursive:false})
const binary=resolve('research/external/gaden-smoke-build/plumenav_gaden_smoke')
const run=(name,mode)=>new Promise((resolveRun,reject)=>{
  const start=Date.now(),child=spawn(binary,[mode],{env:{...process.env,OMP_NUM_THREADS:'1',OMP_DYNAMIC:'FALSE'}})
  let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x)
  child.on('error',reject);child.on('close',code=>{
    const end=Date.now();writeFileSync(join(dir,name+'.log'),stdout+stderr,{flag:'wx'})
    try{
      assert.equal(code,0);assert.ok(!/\[ERROR\]|\[WARN\]|nan|fatal/i.test(stderr))
      const lines=stdout.split('\n').filter(x=>x.startsWith('{')).map(x=>JSON.parse(x)),complete=lines.at(-1),samples=lines.slice(0,-1)
      assert.equal(complete.complete,true);assert.equal(samples.length,90)
      assert.ok(samples.every(r=>Number.isFinite(r.ppm)&&r.ppm>=0))
      assert.equal(complete.absent,mode==='absent')
      if(mode==='absent')assert.ok(samples.every(r=>r.ppm===0));else assert.ok(samples.some(r=>r.ppm>0))
      resolveRun({name,mode,pid:child.pid,start,end,exitCode:code,complete,samples})
    }catch(e){reject(e)}
  })
})
const parallel=await Promise.all([run('emitting-a','emitting'),run('absent','absent')])
const repeat=await run('emitting-b','emitting')
assert.deepEqual(parallel[0].samples,repeat.samples)
const overlapMs=Math.min(...parallel.map(r=>r.end))-Math.max(...parallel.map(r=>r.start))
assert.ok(overlapMs>=0)
const git=(args)=>execFileSync('git',args,{encoding:'utf8'}).trim()
const upstreamCommit=git(['-C','research/external/gaden_core','rev-parse','HEAD'])
const patch=git(['-C','research/external/gaden_core','diff'])+'\n'
writeFileSync(join(dir,'gaden-portability.patch'),patch,{flag:'wx'})
const hash=x=>createHash('sha256').update(x).digest('hex')
const report={scope:'Native CPU compatibility smoke only; methane physics NOT validated',upstreamCommit,
  fmtCommit:git(['-C','research/external/fmt','rev-parse','HEAD']),
  submodules:git(['-C','research/external/gaden_core','submodule','status','--recursive']),
  platform:process.platform,architecture:process.arch,threadsPerProcess:1,parallelOverlapMs:overlapMs,
  binarySha256:hash(readFileSync(binary)),workers:[...parallel,repeat],
  limitations:['No empirical validation or outdoor CFD in this smoke.',
    'Zero filament perturbation; separate-process replay does not validate stochastic seed control.',
    'Upstream buoyancy expression requires dimensional audit before near-ground methane use.']}
writeFileSync(join(dir,'summary.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'})
const files=['scripts/gaden-smoke/CMakeLists.txt','scripts/gaden-smoke/smoke.cpp','scripts/m51-gaden-smoke.mjs']
const sourceHashes={}
for(const f of files){sourceHashes[f]=hash(readFileSync(f));copyFileSync(f,join(dir,f.split('/').at(-1)))}
writeFileSync(join(dir,'manifest.json'),JSON.stringify({sourceHashes,artifactHashes:Object.fromEntries(
  ['summary.json','gaden-portability.patch','emitting-a.log','emitting-b.log','absent.log'].map(f=>[f,hash(readFileSync(join(dir,f)))]))},null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({verified:true,upstreamCommit,parallelOverlapMs:overlapMs,
  workers:report.workers.map(r=>({name:r.name,pid:r.pid,...r.complete})),binarySha256:report.binarySha256},null,2))
