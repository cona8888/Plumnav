import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
const root='research/evidence/m85_temporal_order_2026-09-13',out='research/evidence/m85_temporal_order_audit_2026-09-13'
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const m=JSON.parse(await readFile(`${root}/manifest.json`,'utf8')),d=JSON.parse(await readFile(`${root}/complete.json`,'utf8'))
if(!d.complete)throw Error('Incomplete')
let hashes=0,ticks=0,samples=0
for(const r of d.inventory){if(sha(await readFile(`${root}/${r.file}`))!==r.sha256)throw Error('Artifact hash');hashes++}
for(const r of m.sources){if(sha(await readFile(`${root}/source-snapshot/${r.file}`))!==r.sha256||sha(await readFile(r.file))!==r.sha256)throw Error('Source hash');hashes+=2}
const rows=[],paired=new Map<string,string>()
for(let i=0;i<m.cases.length;i++){
 const run=JSON.parse(gunzipSync(await readFile(`${root}/run-${i}.json.gz`)).toString()),s=run.summary,c=run.config.localInletSampling.inspection
 const used=new Set<number>(),byTime=new Map<number,any>(run.trace.map((r:any)=>[r.time,r]))
 if(run.trace.length!==2400||s.results.length!==(s.arm==='single'?1:2))throw Error('Run length')
 for(const [j,r] of run.trace.entries()){if(r.time!==j*.25||r.decision.estimate!==null||!Number.isFinite(r.measurement.concentration))throw Error('Trace');ticks++}
 const key=[s.field,s.period,s.phase,s.seed].join(':'),first=JSON.stringify(run.trace.slice(0,960))
 if(paired.has(key)&&paired.get(key)!==first)throw Error('First circuit mismatch');paired.set(key,first)
 for(const [j,r] of s.results.entries()){
  if(r.startedAt!==(j?240:0)||r.completedAt>600||r.visits.length!==9)throw Error('Timing')
  const order=j&&s.arm==='reverse-repeat'?[3,2,1,0]:[0,1,2,3],h=c.offsetNormalized,offsets=[[h,0],[-h,0],[0,h],[0,-h]]
  const medians=[]
  for(const [k,v] of r.visits.entries()){
   const offset=k%2?offsets[order[(k-1)/2]]:[0,0]
   if(Math.hypot(v.target.x-.5-offset[0],v.target.y-.5-offset[1])>1e-12)throw Error('Order/target')
   let last=-Infinity
   for(const x of v.samples){const t=byTime.get(x.time);if(used.has(x.time)||!t||x.time<r.startedAt||!t.measurement.valid||t.measurement.sampleMode!=='passive'||t.measurement.concentration!==x.value||t.measurement.hit!==x.hit||x.time<v.arrivedAt+c.settlingSeconds-1e-9||x.time-last<c.sampleSpacingSeconds-1e-9||Math.hypot(t.position.x-v.target.x,t.position.y-v.target.y)>c.arrivalRadiusNormalized+1e-9)throw Error('Sample provenance');last=x.time;used.add(x.time);samples++}
   const values=v.samples.map((x:any)=>x.value).sort((a:number,b:number)=>a-b);medians.push(values[Math.floor(values.length/2)]??NaN)
  }
  const margin=3*run.config.sensorNoise,min=c.minimumSamplesPerWaypoint
  const supported=r.visits.every((v:any)=>v.samples.length>=min)&&[0,2,4,6,8].every(k=>medians[k]>=.16&&r.visits[k].samples.filter((x:any)=>x.hit).length>=min)&&[1,3,5,7].every(k=>Math.min(medians[k-1],medians[k+1])-medians[k]>margin&&Math.abs(medians[k-1]-medians[k+1])<=Math.max(margin,.05*Math.min(medians[k-1],medians[k+1])))
  if((r.status==='supported')!==supported)throw Error('Independent acceptance')
 }
 if(s.supported!==s.results.every((r:any)=>r.status==='supported'))throw Error('Repeat conjunction')
 rows.push({field:s.field,period:s.period,phase:s.phase,seed:s.seed,arm:s.arm,supported:s.supported,individual:s.results.map((r:any)=>r.status),probeSeconds:s.probeSeconds,path:s.path})
}
const groups=[]
for(const field of ['uniform','peak','blank'])for(const period of field==='blank'?[0]:[0,32,40,64])for(const arm of ['single','same-repeat','reverse-repeat']){const a=rows.filter(r=>r.field===field&&r.period===period&&r.arm===arm);groups.push({field,period,arm,runs:a.length,supported:a.filter(r=>r.supported).length})}
await mkdir(out,{recursive:true});const body=Buffer.from(JSON.stringify({hashes,ticks,samples,pairedFirstHistories:paired.size,groups,rows},null,2)+'\n'),source=await readFile('scripts/m85-audit.ts')
await writeFile(`${out}/audit.json`,body,{flag:'wx'});await writeFile(`${out}/m85-audit.ts`,source,{flag:'wx'});await writeFile(`${out}/complete.json`,JSON.stringify({complete:true,auditSha256:sha(body),sourceSha256:sha(source)})+'\n',{flag:'wx'})
process.stdout.write(JSON.stringify({hashes,ticks,samples,groups},null,2)+'\n')
