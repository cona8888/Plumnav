import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {LocalInletChannel} from '../src/sim/localInletSampling'
const root='research/evidence/m95_offset_ablation_2026-09-14',out='research/evidence/m95_offset_ablation_audit_2026-09-14',sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const complete=JSON.parse(await readFile(`${root}/complete.json`,'utf8')),protocol=JSON.parse(await readFile(`${root}/protocol.json`,'utf8')),summary=JSON.parse(await readFile(`${root}/summary.json`,'utf8'))
if(!complete.complete||complete.cases!==206||summary.rows.length!==206||summary.replayMax!==0)throw Error('Completeness/replay')
let hashes=0,fits=0,maxForwardError=0
for(const e of complete.inventory){if(sha(await readFile(`${root}/${e.file}`))!==e.sha256)throw Error('Artifact hash');hashes++}
for(const e of protocol.sources){if(sha(await readFile(e.file))!==e.sha256||sha(await readFile(`${root}/${e.snapshot}`))!==e.sha256)throw Error('Source hash');hashes+=2}
for(const [index,row] of summary.rows.entries()){
 const bytes=await readFile(`research/evidence/${row.parent}/${row.file}`);if(sha(bytes)!==row.parentSha256)throw Error('Parent hash');hashes++
 const run=JSON.parse(gunzipSync(bytes).toString()),packet=JSON.parse(gunzipSync(await readFile(`${root}/fit-${index}.json.gz`)).toString());if(JSON.stringify(packet.row)!==JSON.stringify(row))throw Error('Summary mismatch')
 const period=row.selection.period,margin=3*run.config.sensorNoise
 for(const [j,f] of packet.fits.entries()){
  if(JSON.stringify(f.response)!==JSON.stringify(run.fits[j].response)||f.scale!==run.fits[j].scale)throw Error('Calibration mismatch')
  const c=f.coefficients;if(c.length!==(period?8:6)||!c.every(Number.isFinite)||c[0]<0||c[0]>2||Math.abs(c[1])>1||c.slice(2,4).some((v:number)=>Math.abs(v)>.2)||c.slice(4).some((v:number)=>Math.abs(v)>.3))throw Error('Bounds')
  const channel=f.response?new LocalInletChannel({...run.config.localInletSampling,riseTimeConstantSeconds:f.response.rise,recoveryTimeConstantSeconds:f.response.recovery}):null
  for(const [k,p] of run.data.poses.entries()){const q=Math.max(0,c[0]+c[1]*p.time/600-c[2]*p.x*p.x-c[3]*p.y*p.y+c[4]*p.x+c[5]*p.y+(period?c[6]*Math.sin(2*Math.PI*p.time/period)+c[7]*Math.cos(2*Math.PI*p.time/period):0)),v=channel?channel.update(p.time,q):q,e=Math.abs(v-f.predictions[k]);if(!Number.isFinite(e)||e>1e-6)throw Error('Forward prediction');maxForwardError=Math.max(maxForwardError,e)}
  const rms=(train:boolean)=>{const a=run.data.samples.filter((s:any)=>s.train===train);return Math.sqrt(a.reduce((v:number,s:any)=>v+(f.predictions[s.index]-s.value)**2,0)/a.length)},core=run.data.samples.some((s:any)=>s.train&&run.data.poses[s.index].x**2+run.data.poses[s.index].y**2<.01&&s.hit&&s.value>=.16),x=c[4]/(2*c[2]),y=c[5]/(2*c[3]),inside=Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x)+Math.abs(y)<=1
  if(Math.abs(rms(true)-f.trainingRmse)>1e-12||Math.abs(rms(false)-f.validationRmse)>1e-12||f.trainingPlausible!==(rms(true)<=margin)||f.peakInside!==inside||f.supported!==(inside&&core&&rms(true)<=margin&&rms(false)<=margin&&c[2]>margin&&c[3]>margin))throw Error('Decision/residual')
  fits++
 }
 const a=packet.fits,p=a.filter((f:any)=>f.scale!==null&&f.trainingPlausible);if(row.fixed!==a.find((f:any)=>f.scale===1).supported||row.instantaneous!==a[0].supported||row.uncertainty!==(p.length>0&&p.every((f:any)=>f.supported)))throw Error('Ensemble')
}
await mkdir(out,{recursive:true});const body=Buffer.from(JSON.stringify({hashes,fits,maxForwardError,baselineReplayMax:summary.replayMax})+'\n'),source=await readFile('scripts/m95-audit.ts');await writeFile(`${out}/audit.json`,body,{flag:'wx'});await writeFile(`${out}/m95-audit.ts`,source,{flag:'wx'});await writeFile(`${out}/complete.json`,JSON.stringify({complete:true,auditSha256:sha(body),sourceSha256:sha(source)})+'\n',{flag:'wx'});process.stdout.write(body)
