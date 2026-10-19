import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {LocalInletChannel} from '../src/sim/localInletSampling'
const root='research/evidence/m92_inverse_transfer_2026-09-14',out='research/evidence/m92_inverse_transfer_audit_2026-09-14',sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const m=JSON.parse(await readFile(`${root}/manifest.json`,'utf8')),d=JSON.parse(await readFile(`${root}/complete.json`,'utf8')),pm=JSON.parse(await readFile(`${m.parentRoot}/manifest.json`,'utf8')),physical=pm.base.localInletSampling
if(!d.complete)throw Error('Incomplete');let hashes=0,fits=0,observations=0,maxForwardError=0
for(const e of d.inventory){if(sha(await readFile(`${root}/${e.file}`))!==e.sha256)throw Error('Artifact hash');hashes++}
for(const e of m.sources){if(sha(await readFile(e.file))!==e.sha256||sha(await readFile(`${root}/source-snapshot/${e.file}`))!==e.sha256)throw Error('Source hash');hashes+=2}
const rows=[]
for(let i=0;i<m.cases.length;i++){
 const r=JSON.parse(await readFile(`${root}/run-${i}.json`,'utf8')),c=m.cases[i],bytes=await readFile(`${m.parentRoot}/run-${c.index}.json.gz`),old=JSON.parse(gunzipSync(bytes).toString());if(sha(bytes)!==c.sha256||r.noise!==old.config.sensorNoise)throw Error('Input changed');hashes++;observations+=r.data.samples.length
 const centre=old.summary.results[0].candidate,offset=old.config.localInletSampling.inspection.offsetNormalized,expected=[]
 for(const [round,result] of old.summary.results.entries())for(const [visit,v] of result.visits.entries())for(const sample of v.samples){const index=Math.round(sample.time/.25),o=old.trace[index].measurement;expected.push({index,value:o.concentration,hit:o.hit,train:(round?[0,3,4,7,8]:[0,1,4,5,8]) .includes(visit)})}
 if(JSON.stringify(expected)!==JSON.stringify(r.data.samples))throw Error('Split/value leakage')
 for(const [j,p] of r.data.poses.entries()){const t=old.trace[j];if(p.time!==t.time||p.x!==(t.position.x-centre.x)/offset||p.y!==(t.position.y-centre.y)/offset)throw Error('Pose mismatch')}
 for(const f of r.fits){
  const c=f.coefficients;if(c.length!==(f.period?6:4)||!c.every(Number.isFinite)||c[0]<0||c[0]>2||Math.abs(c[1])>1||c.slice(2,4).some((v:number)=>Math.abs(v)>.2)||c.slice(4).some((v:number)=>Math.abs(v)>.3))throw Error('Coefficient bounds')
  const response=f.scale===null?null:{...m.response,rise:m.response.rise*f.scale,recovery:m.response.recovery*f.scale}
  if(JSON.stringify(f.response)!==JSON.stringify(response)||f.period!==(f.arm==='reference'?0:r.summary.selection.period))throw Error('Unapproved model setting')
  const channel=f.response?new LocalInletChannel({...physical,riseTimeConstantSeconds:f.response.rise,recoveryTimeConstantSeconds:f.response.recovery}):null
  for(const [k,p] of r.data.poses.entries()){const q=Math.max(0,c[0]+c[1]*p.time/600-c[2]*p.x*p.x-c[3]*p.y*p.y+(f.period?c[4]*Math.sin(2*Math.PI*p.time/f.period)+c[5]*Math.cos(2*Math.PI*p.time/f.period):0)),v=channel?channel.update(p.time,q):q,error=Math.abs(v-f.predictions[k]);if(!Number.isFinite(error)||error>1e-6)throw Error('Forward integration');maxForwardError=Math.max(maxForwardError,error)}
  const rms=(train:boolean)=>{const a=r.data.samples.filter((s:any)=>s.train===train);return Math.sqrt(a.reduce((v:number,s:any)=>v+(f.predictions[s.index]-s.value)**2,0)/a.length)},margin=3*r.noise,core=r.data.samples.some((s:any)=>s.train&&r.data.poses[s.index].x**2+r.data.poses[s.index].y**2<.01&&s.hit&&s.value>=.16)
  if(Math.abs(rms(true)-f.trainingRmse)>1e-12||Math.abs(rms(false)-f.validationRmse)>1e-12||f.trainingPlausible!==(rms(true)<=margin)||f.supported!==(core&&rms(true)<=margin&&rms(false)<=margin&&c[2]>margin&&c[3]>margin))throw Error('Residual/decision');fits++
 }
 for(const o of r.summary.outcomes){const a=r.fits.filter((f:any)=>f.arm===o.arm),p=a.filter((f:any)=>f.scale!==null&&f.trainingPlausible);if(o.fixed!==a.find((f:any)=>f.scale===1).supported||o.instantaneous!==a[0].supported||o.uncertainty!==(p.length>0&&p.every((f:any)=>f.supported)))throw Error('Ensemble')}
 rows.push({...r.summary,fits:r.fits.map(({predictions,...f}:any)=>f)})
}
await mkdir(out,{recursive:true});const body=Buffer.from(JSON.stringify({hashes,fits,observations,maxForwardError,rows},null,2)+'\n'),source=await readFile('scripts/m92-audit.ts');await writeFile(`${out}/audit.json`,body,{flag:'wx'});await writeFile(`${out}/m92-audit.ts`,source,{flag:'wx'});await writeFile(`${out}/complete.json`,JSON.stringify({complete:true,auditSha256:sha(body),sourceSha256:sha(source)})+'\n',{flag:'wx'})
for(const field of ['peak','uniform','plateau','ridge','blank'])for(const arm of ['reference','periodic']){const a=rows.filter(r=>r.field===field).map(r=>r.outcomes.find((o:any)=>o.arm===arm));process.stdout.write(JSON.stringify({field,arm,n:a.length,instantaneous:a.filter(r=>r.instantaneous).length,fixed:a.filter(r=>r.fixed).length,uncertainty:a.filter(r=>r.uncertainty).length})+'\n')}
process.stdout.write(JSON.stringify({hashes,fits,observations,maxForwardError})+'\n')
