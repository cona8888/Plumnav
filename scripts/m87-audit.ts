import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
const root='research/evidence/m87_model_selection_2026-09-13',out='research/evidence/m87_model_selection_audit_2026-09-13'
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const m=JSON.parse(await readFile(`${root}/manifest.json`,'utf8')),d=JSON.parse(await readFile(`${root}/complete.json`,'utf8'))
if(!d.complete)throw Error('Incomplete')
let hashes=0,ticks=0,samples=0
for(const r of d.inventory){if(sha(await readFile(`${root}/${r.file}`))!==r.sha256)throw Error('Artifact hash');hashes++}
for(const r of m.sources){if(sha(await readFile(`${root}/source-snapshot/${r.file}`))!==r.sha256||sha(await readFile(r.file))!==r.sha256)throw Error('Source hash');hashes+=2}
const rows=[]
// Separate QR least-squares check at the recorded period (not a second grid search).
function qrFit(data:any[],period:number){
 const basis=(t:number)=>period?[1,t/600,Math.sin(2*Math.PI*t/period),Math.cos(2*Math.PI*t/period)]:[1,t/600]
 const n=period?4:2,q:number[][]=[],r=Array.from({length:n},()=>Array(n).fill(0))
 for(let j=0;j<n;j++){const v=data.map(s=>basis(s.time)[j]!);for(let k=0;k<j;k++){r[k]![j]=v.reduce((a,x,i)=>a+x*q[k]![i]!,0);for(let i=0;i<v.length;i++)v[i]!-=r[k]![j]*q[k]![i]!}r[j]![j]=Math.hypot(...v);q.push(v.map(x=>x/r[j]![j]))}
 const b=q.map(v=>v.reduce((a,x,i)=>a+x*data[i].value,0)),coef=Array(n).fill(0)
 for(let j=n-1;j>=0;j--)coef[j]=(b[j]!-r[j]!.reduce((a,x,k)=>a+(k>j?x*coef[k]:0),0))/r[j]![j]
 const predict=(t:number)=>basis(t).reduce((a,x,j)=>a+x*coef[j],0)
 return {predict,rmse:(a:any[])=>Math.sqrt(a.reduce((v,s)=>v+(predict(s.time)-s.value)**2,0)/a.length)}
}
function validateSelection(results:any[],noise:number,orders:number[][],score:any,piecewise:boolean,old:any){
 const centres=results.map(r=>r.visits.filter((_:any,k:number)=>k%2===0)),margin=3*noise
 const group=(v:any[])=>{const train=v.filter((_,k)=>k%2===0).flatMap(v=>v.samples),test=v.filter((_,k)=>k%2===1).flatMap(v=>v.samples),all=v.flatMap(v=>v.samples),cross=qrFit(train,0),full=qrFit(all,0);return {predict:full.predict,trainingRmse:cross.rmse(train),validationRmse:cross.rmse(test),fullRmse:full.rmse(all),eligible:[cross.rmse(train),cross.rmse(test),full.rmse(all)].every(x=>x<=margin)}}
 const global=group(centres.flat()),pieces=piecewise?centres.map(group):[],model=global.eligible?'global-affine':piecewise&&pieces.every(p=>p.eligible)?'per-round-affine':'harmonic'
 if(score.model!==model)throw Error('Selector disagrees with QR')
 for(const [a,b] of [[global,score.affineDiagnostics.global],...pieces.map((p,j)=>[p,score.affineDiagnostics.pieces[j]])])for(const key of ['trainingRmse','validationRmse','fullRmse'])if(Math.abs(a[key]-b[key])>1e-8)throw Error('Affine residual mismatch')
 if(model==='harmonic'){if(score.supported!==old.supported||JSON.stringify(score.contrasts)!==JSON.stringify(old.contrasts))throw Error('Harmonic fallback changed');return}
 const fits=model==='global-affine'?[global,global]:pieces,contrasts=[]
 for(let j=0;j<2;j++){const a=Array(4).fill(NaN);for(let k=0;k<4;k++){const v=results[j].visits[2*k+1].samples.map((s:any)=>fits[j]!.predict(s.time)-s.value).sort((a:number,b:number)=>a-b);a[orders[j]![k]!]=v[Math.floor(v.length/2)]}contrasts.push(a)}
 for(let j=0;j<2;j++)for(let k=0;k<4;k++)if(Math.abs(contrasts[j]![k]-score.contrasts[j][k])>1e-8)throw Error('Affine contrast mismatch')
 const core=centres.flat().every((v:any)=>{const a=v.samples.map((x:any)=>x.value).sort((a:number,b:number)=>a-b);return a[Math.floor(a.length/2)]>=.16&&v.samples.filter((x:any)=>x.hit).length>=2})
 if(score.supported!==(core&&contrasts.every(a=>a.every(x=>x>margin))))throw Error('Affine decision mismatch')
}
const archived=JSON.parse(await readFile(`${root}/archived.json`,'utf8')).rows
for(const r of archived){const bytes=await readFile(`${r.parent}/run-${r.index}.json.gz`);if(sha(bytes)!==r.sha256)throw Error('Parent run hash');hashes++;const run=JSON.parse(gunzipSync(bytes).toString()),s=run.summary,orders=[[0,1,2,3],s.order??(s.arm==='reverse-repeat'?[3,2,1,0]:[0,1,2,3])];validateSelection(s.results,run.config.sensorNoise,orders,r.affine,false,r.old);validateSelection(s.results,run.config.sensorNoise,orders,r.piecewise,true,r.old)}
for(let i=0;i<m.cases.length;i++){
 const run=JSON.parse(gunzipSync(await readFile(`${root}/run-${i}.json.gz`)).toString()),s=run.summary,c=run.config.localInletSampling.inspection
 const used=new Set<number>(),byTime=new Map<number,any>(run.trace.map((r:any)=>[r.time,r]))
 if(run.trace.length!==2400||s.results.length!==2)throw Error('Run length')
 for(const [j,r] of run.trace.entries()){if(r.time!==j*.25||r.decision.estimate!==null||!Number.isFinite(r.measurement.concentration))throw Error('Trace');ticks++}
 for(const [j,r] of s.results.entries()){
  if(r.startedAt!==(j?s.repeatStart:0)||r.completedAt>600||r.visits.length!==9)throw Error('Timing')
  const order=j?s.order:[0,1,2,3],h=c.offsetNormalized,offsets=[[h,0],[-h,0],[0,h],[0,-h]]
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
 const corrected=s.corrected,all=s.results.flatMap((r:any)=>r.visits.filter((_:any,k:number)=>k%2===0)).flatMap((v:any)=>v.samples)
 const predict=(t:number)=>{const x=corrected.period?[1,t/600,Math.sin(2*Math.PI*t/corrected.period),Math.cos(2*Math.PI*t/corrected.period)]:[1,t/600];return x.reduce((v,n,k)=>v+n*corrected.coefficients[k],0)}
 const rms=Math.sqrt(all.reduce((v:number,x:any)=>v+(predict(x.time)-x.value)**2,0)/all.length)
 if(Math.abs(rms-corrected.fullRmse)>1e-10)throw Error('Corrected full residual')
 const centres=s.results.flatMap((r:any)=>r.visits.filter((_:any,k:number)=>k%2===0)),train=centres.filter((_:any,k:number)=>k%2===0).flatMap((v:any)=>v.samples),test=centres.filter((_:any,k:number)=>k%2===1).flatMap((v:any)=>v.samples)
 const independent=qrFit(train,corrected.period),full=qrFit(all,corrected.period)
 if(Math.abs(independent.rmse(train)-corrected.trainingRmse)>1e-8||Math.abs(independent.rmse(test)-corrected.validationRmse)>1e-8||Math.abs(full.rmse(all)-rms)>1e-8)throw Error('QR temporal fit disagreement')
 for(const [j,r] of s.results.entries())for(let k=0;k<4;k++){const values=r.visits[2*k+1].samples.map((x:any)=>predict(x.time)-x.value).sort((a:number,b:number)=>a-b),direction=j?s.order[k]:k;if(Math.abs(values[Math.floor(values.length/2)]-corrected.contrasts[j][direction])>1e-10)throw Error('Corrected contrast')}
 const margin=3*run.config.sensorNoise,core=centres.every((v:any)=>{const a=v.samples.map((x:any)=>x.value).sort((a:number,b:number)=>a-b);return a[Math.floor(a.length/2)]>=.16&&v.samples.filter((x:any)=>x.hit).length>=2})
 if(corrected.supported!==(core&&independent.rmse(train)<=margin&&independent.rmse(test)<=margin&&rms<=margin&&corrected.contrasts.every((a:number[])=>a.every(v=>v>margin))))throw Error('Corrected decision disagreement')
 validateSelection(s.results,run.config.sensorNoise,[[0,1,2,3],s.order],s.affine,false,corrected);validateSelection(s.results,run.config.sensorNoise,[[0,1,2,3],s.order],s.piecewise,true,corrected)
 rows.push({field:s.field,signal:s.signal,seed:s.seed,sensor:s.sensor,supported:s.supported,corrected,affine:s.affine,piecewise:s.piecewise,individual:s.results.map((r:any)=>r.status),probeSeconds:s.probeSeconds,path:s.path})
}
const groups=[]
for(const field of ['uniform','peak','plateau','ridge','blank'])for(const sensor of ['nominal','noise3','slow2']){const a=rows.filter(r=>r.field===field&&r.sensor===sensor);groups.push({field,sensor,runs:a.length,original:a.filter(r=>r.supported).length,old:a.filter(r=>r.corrected.supported).length,affine:a.filter(r=>r.affine.supported).length,piecewise:a.filter(r=>r.piecewise.supported).length})}
await mkdir(out,{recursive:true});const body=Buffer.from(JSON.stringify({hashes,ticks,samples,archivedRuns:archived.length,groups,rows},null,2)+'\n'),source=await readFile('scripts/m87-audit.ts')
await writeFile(`${out}/audit.json`,body,{flag:'wx'});await writeFile(`${out}/m87-audit.ts`,source,{flag:'wx'});await writeFile(`${out}/complete.json`,JSON.stringify({complete:true,auditSha256:sha(body),sourceSha256:sha(source)})+'\n',{flag:'wx'})
process.stdout.write(JSON.stringify({hashes,ticks,samples,groups},null,2)+'\n')
