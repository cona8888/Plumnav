import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {LocalInletChannel} from '../src/sim/localInletSampling'
const root='research/evidence/m90_observation_inverse_2026-09-13',out='research/evidence/m90_observation_inverse_audit_2026-09-13',sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const m=JSON.parse(await readFile(`${root}/manifest.json`,'utf8')),done=JSON.parse(await readFile(`${root}/complete.json`,'utf8'))
if(!done.complete)throw Error('Incomplete')
let hashes=0,observations=0,poses=0,fitCount=0,maxForwardDisagreement=0
for(const r of done.inventory){if(sha(await readFile(`${root}/${r.file}`))!==r.sha256)throw Error('Artifact hash');hashes++}
for(const r of m.sources){if(sha(await readFile(r.file))!==r.sha256||sha(await readFile(`${root}/source-snapshot/${r.file}`))!==r.sha256)throw Error('Source hash');hashes+=2}
const rows=[]
for(let i=0;i<m.cases.length;i++){
 const r=JSON.parse(await readFile(`${root}/run-${i}.json`,'utf8')),c=m.cases[i],bytes=await readFile(`${m.parentRoot}/run-${c.index}.json.gz`)
 if(sha(bytes)!==c.sha256)throw Error('Parent hash');hashes++
 const parent=JSON.parse(gunzipSync(bytes).toString()),centre=parent.summary.results[0].candidate,offset=parent.config.localInletSampling.inspection.offsetNormalized
 if(Object.keys(r.data).sort().join(',')!=='poses,samples')throw Error('Unapproved estimator input')
 for(const [j,p] of r.data.poses.entries()){const t=parent.trace[j];if(p.time!==t.time||p.x!==(t.position.x-centre.x)/offset||p.y!==(t.position.y-centre.y)/offset)throw Error('Pose mismatch');poses++}
 const expected=[]
 for(const [round,result] of parent.summary.results.entries())for(const [visit,v] of result.visits.entries())for(const s of v.samples){const index=Math.round(s.time/.25),o=parent.trace[index].measurement;expected.push({index,value:o.concentration,hit:o.hit,train:(round?[0,3,4,7,8]:[0,1,4,5,8]).includes(visit)})}
 if(JSON.stringify(expected)!==JSON.stringify(r.data.samples)||r.noise!==parent.config.sensorNoise)throw Error('Measurement/split mismatch');observations+=expected.length
 for(const f of r.fits){
  const coef=f.coefficients;if(coef.length!==4||!coef.every(Number.isFinite)||coef[0]<0||coef[0]>2||Math.abs(coef[1])>1||coef.slice(2).some((v:number)=>Math.abs(v)>.2))throw Error('Coefficient bounds')
  const settings={...parent.config.localInletSampling,riseTimeConstantSeconds:m.response.rise*(f.scale??1),recoveryTimeConstantSeconds:m.response.recovery*(f.scale??1),averagingSeconds:m.response.average}
  // Parent tube geometry is unchanged; response constants intentionally come
  // from the nominal supplied calibration, never the slow2 truth setting.
  const channel=new LocalInletChannel(settings)
  if(f.scale!==null&&(f.response.rise!==settings.riseTimeConstantSeconds||f.response.recovery!==settings.recoveryTimeConstantSeconds||f.response.delay!==m.response.delay))throw Error('Calibration leakage')
  for(const [k,p] of r.data.poses.entries()){const q=Math.max(0,coef[0]+coef[1]*p.time/600-coef[2]*p.x*p.x-coef[3]*p.y*p.y),v=f.scale===null?q:channel.update(p.time,q),error=Math.abs(v-f.predictions[k]);if(!Number.isFinite(error)||error>1e-6)throw Error('Independent analytical forward check');maxForwardDisagreement=Math.max(maxForwardDisagreement,error)}
  const rms=(train:boolean)=>{const a=expected.filter(s=>s.train===train);return Math.sqrt(a.reduce((v,s)=>v+(f.predictions[s.index]-s.value)**2,0)/a.length)},margin=3*r.noise,core=expected.filter(s=>s.train&&r.data.poses[s.index].x**2+r.data.poses[s.index].y**2<.01).some(s=>s.hit&&s.value>=.16)
  if(Math.abs(rms(true)-f.trainingRmse)>1e-12||Math.abs(rms(false)-f.validationRmse)>1e-12||f.trainingPlausible!==(rms(true)<=margin)||f.supported!==(core&&rms(true)<=margin&&rms(false)<=margin&&coef[2]>margin&&coef[3]>margin))throw Error('Score disagreement')
  fitCount++
 }
 const plausible=r.fits.filter((f:any)=>f.scale!==null&&f.trainingPlausible)
 if(r.summary.uncertainty!==(plausible.length>0&&plausible.every((f:any)=>f.supported))||r.summary.fixed!==r.fits.find((f:any)=>f.scale===1).supported||r.summary.instantaneous!==r.fits[0].supported)throw Error('Ensemble decision')
 rows.push({...r.summary,fits:r.fits.map(({predictions,...f}:any)=>f)})
}
await mkdir(out,{recursive:true});const body=Buffer.from(JSON.stringify({hashes,observations,poses,fitCount,maxForwardDisagreement,rows},null,2)+'\n'),source=await readFile('scripts/m90-audit.ts')
await writeFile(`${out}/audit.json`,body,{flag:'wx'});await writeFile(`${out}/m90-audit.ts`,source,{flag:'wx'});await writeFile(`${out}/complete.json`,JSON.stringify({complete:true,auditSha256:sha(body),sourceSha256:sha(source)})+'\n',{flag:'wx'})
for(const field of ['uniform','peak','plateau','ridge','blank']){const a=rows.filter(r=>r.field===field);process.stdout.write(JSON.stringify({field,runs:a.length,instantaneous:a.filter(r=>r.instantaneous).length,fixed:a.filter(r=>r.fixed).length,uncertainty:a.filter(r=>r.uncertainty).length})+'\n')}
process.stdout.write(JSON.stringify({hashes,observations,poses,fitCount,maxForwardDisagreement})+'\n')
