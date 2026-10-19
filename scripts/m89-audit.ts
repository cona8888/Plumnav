import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {LocalInletChannel} from '../src/sim/localInletSampling'
import {channelReference} from './lib/channel-reference'
const root='research/evidence/m89_channel_history_2026-09-13',out='research/evidence/m89_channel_history_audit_2026-09-13',sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const m=JSON.parse(await readFile(`${root}/manifest.json`,'utf8')),d=JSON.parse(await readFile(`${root}/complete.json`,'utf8'))
if(!d.complete)throw Error('Incomplete')
let hashes=0,ticks=0,channelPoints=0,replays=0
for(const r of d.inventory){if(sha(await readFile(`${root}/${r.file}`))!==r.sha256)throw Error('Artifact hash');hashes++}
for(const r of m.sources){if(sha(await readFile(r.file))!==r.sha256||sha(await readFile(`${root}/source-snapshot/${r.file}`))!==r.sha256)throw Error('Source hash');hashes+=2}
const rows=[]
for(let i=0;i<m.cases.length;i++){
 const r=JSON.parse(gunzipSync(await readFile(`${root}/run-${i}.json.gz`)).toString()),old=JSON.parse(gunzipSync(await readFile(`${m.parentRoot}/run-${r.summary.parentIndex}.json.gz`)).toString())
 if(JSON.stringify(r.trace)!==JSON.stringify(old.trace))throw Error('Replay mismatch');replays++
 if(r.trace.length!==2400||r.histories.length!==4||r.oracle.length!==5)throw Error('Wrong dimensions')
 for(const [j,t] of r.trace.entries()){if(t.time!==j*.25||t.decision.estimate!==null)throw Error('Trace clock/source contract');ticks++}
 for(const h of r.histories){const channel=new LocalInletChannel(r.config.localInletSampling);if(h.length!==2400)throw Error('Channel length');for(const [k,x] of h.entries()){if(x.time!==k*.25||channel.update(x.time,x.value)!==x.output)throw Error('Recorded channel disagreement');channelPoints++}}
 const times=r.summary.results.flatMap((v:any)=>v.visits.flatMap((v:any)=>v.samples.map((s:any)=>s.time)))
 const baseline=r.histories[0],settings=r.config.localInletSampling
 for(const o of r.oracle){
  const errors=o.predictions.flatMap((v:number[],j:number)=>v.map((x,k)=>x-r.histories[j][k].output)),max=Math.max(...errors.map(Math.abs))
  if(!Number.isFinite(max)||max!==o.maxError)throw Error('Oracle error summary')
  const retained=times.map((t:number)=>{const k=t/.25;return o.predictions.reduce((a:number,b:number[])=>a+b[k]!,0)/4-r.histories.reduce((a:number,b:any[])=>a+b[k].output,0)/4}),rmse=Math.sqrt(retained.reduce((a:number,v:number)=>a+v*v,0)/retained.length)
  if(rmse!==o.retainedRmse||Math.max(...retained.map(Math.abs))!==o.retainedMax)throw Error('Retained metric disagreement')
  if(o.variant==='matched'){
   const coarse=r.histories.map((h:any)=>channelReference(h,o.settings,.01)),delta=Math.max(...o.predictions.flatMap((a:number[],j:number)=>a.map((v,k)=>Math.abs(v-coarse[j][k]))))
   if(delta!==o.refinementMax||delta>1e-7||max>1e-7)throw Error('Independent refinement failed')
  }
  rows.push({index:i,field:r.summary.field,signal:r.summary.signal,sensor:r.summary.sensor,variant:o.variant,maxError:max,retainedRmse:rmse,retainedMax:o.retainedMax,refinementMax:o.refinementMax})
 }
 // Instantaneous inlet concentration is an oracle too, not a measured baseline.
 const instantaneous=times.map((t:number)=>{const k=t/.25;return r.histories.reduce((a:number,h:any[])=>a+h[k].value-h[k].output,0)/4})
 rows.push({index:i,field:r.summary.field,signal:r.summary.signal,sensor:r.summary.sensor,variant:'instantaneous-input',maxError:null,retainedRmse:Math.sqrt(instantaneous.reduce((a:number,v:number)=>a+v*v,0)/instantaneous.length),retainedMax:Math.max(...instantaneous.map(Math.abs)),refinementMax:null})
}
await mkdir(out,{recursive:true});const body=Buffer.from(JSON.stringify({hashes,ticks,channelPoints,replays,rows},null,2)+'\n'),source=await readFile('scripts/m89-audit.ts')
await writeFile(`${out}/audit.json`,body,{flag:'wx'});await writeFile(`${out}/m89-audit.ts`,source,{flag:'wx'});await writeFile(`${out}/complete.json`,JSON.stringify({complete:true,auditSha256:sha(body),sourceSha256:sha(source)})+'\n',{flag:'wx'})
for(const variant of [...new Set(rows.map(r=>r.variant))]){const a=rows.filter(r=>r.variant===variant);process.stdout.write(JSON.stringify({variant,maxAll:Math.max(...a.map(r=>r.maxError??0)),retainedRmseRange:[Math.min(...a.map(r=>r.retainedRmse)),Math.max(...a.map(r=>r.retainedRmse))],retainedMax:Math.max(...a.map(r=>r.retainedMax)),aboveMargin:a.filter(r=>r.retainedMax>.003).length})+'\n')}
process.stdout.write(JSON.stringify({hashes,ticks,channelPoints,replays})+'\n')
