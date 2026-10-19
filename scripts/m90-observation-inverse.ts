import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {fitVisible,type VisibleInverseData} from './lib/observation-inverse'
const root='research/evidence/m90_observation_inverse_2026-09-13',parentRoot='research/evidence/m87_model_selection_2026-09-13',sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const parent=JSON.parse(await readFile(`${parentRoot}/manifest.json`,'utf8')),p=parent.base.localInletSampling
const response={delay:Math.PI*(p.tubeInnerDiameterMetres/2)**2*p.tubeLengthMetres/(p.flowLitresPerMinutePerChannel*1e-3/60),rise:p.riseTimeConstantSeconds,recovery:p.recoveryTimeConstantSeconds,average:p.averagingSeconds}
const cases=[]
for(const [index,c] of parent.cases.entries())if(c.seed===87001&&c.sensor!=='noise3'&&['steady','drift','sine53','chirp','step-inside'].includes(c.signal)){const bytes=await readFile(`${parentRoot}/run-${index}.json.gz`);cases.push({index,...c,sha256:sha(bytes)})}
await mkdir(root,{recursive:true});const sources=[],inventory:any[]=[]
for(const file of ['scripts/m90-observation-inverse.ts','scripts/lib/observation-inverse.ts','scripts/lib/channel-reference.ts']){const b=await readFile(file);await mkdir(`${root}/source-snapshot/${file.split('/').slice(0,-1).join('/')}`,{recursive:true});await writeFile(`${root}/source-snapshot/${file}`,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
async function retain(file:string,v:unknown){const b=Buffer.from(JSON.stringify(v)+'\n');await writeFile(`${root}/${file}`,b,{flag:'wx'});inventory.push({file,sha256:sha(b)})}
await retain('manifest.json',{cases,sources,parentRoot,response,protocol:{models:['instantaneous','tau0.8','tau1','tau1.2'],trainingVisits:[[0,1,4,5,8],[0,3,4,7,8]],uncertainty:'Plausibility based on training RMSE only; all training-plausible candidates must pass withheld visits and two-axis contrast. Empty set unresolved.',fitting:'12 damped finite-difference Gauss-Newton iterations with fixed coefficient bounds; scalar effective channel, clean prehistory. Field labels and true calibration excluded. No global optimum claim.',scope:'30 archived observation-only commissioning cases, not new missions or end-to-end GSL. Truth slow2 is outside supplied uncertainty range. No oscillatory term in latent model; mismatch tests deliberately retained.'}})
const rows=[]
for(const [caseIndex,c] of cases.entries()){
 const r=JSON.parse(gunzipSync(await readFile(`${parentRoot}/run-${c.index}.json.gz`)).toString()),candidate=r.summary.results[0].candidate,offset=r.config.localInletSampling.inspection.offsetNormalized
 const data:VisibleInverseData={poses:r.trace.map((t:any)=>({time:t.time,x:(t.position.x-candidate.x)/offset,y:(t.position.y-candidate.y)/offset})),samples:[]}
 for(const [round,result] of r.summary.results.entries())for(const [visit,v] of result.visits.entries())for(const s of v.samples){const index=Math.round(s.time/.25),observed=r.trace[index].measurement;if(!observed.valid||observed.concentration!==s.value)throw Error('Observation provenance');data.samples.push({index,value:observed.concentration,hit:observed.hit,train:(round?[0,3,4,7,8]:[0,1,4,5,8]).includes(visit)})}
 data.poses=data.poses.slice(0,Math.max(...data.samples.map(s=>s.index))+1)
 const fits=[]
 for(const scale of [null,.8,1,1.2]){const settings=scale===null?null:{...response,rise:response.rise*scale,recovery:response.recovery*scale};fits.push({scale,response:settings,...fitVisible(data,settings,r.config.sensorNoise)})}
 const plausible=fits.filter(f=>f.scale!==null&&f.trainingPlausible),summary={...c,caseIndex,fixed:fits.find(f=>f.scale===1)!.supported,instantaneous:fits[0]!.supported,uncertainty:plausible.length>0&&plausible.every(f=>f.supported),plausibleScales:plausible.map(f=>f.scale)}
 await retain(`run-${caseIndex}.json`,{summary,data,noise:r.config.sensorNoise,fits});rows.push(summary);process.stdout.write(`${caseIndex+1}/${cases.length}\n`)
}
await retain('summary.json',{rows});await writeFile(`${root}/complete.json`,JSON.stringify({complete:true,cases:cases.length,inventory})+'\n',{flag:'wx'})
