import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {fitPeriodic,selectPeriod,type VisibleInverseData} from './lib/periodic-inverse'
const root='research/evidence/m92_inverse_transfer_2026-09-14',parentRoot='research/evidence/m87_model_selection_2026-09-13',sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const parent=JSON.parse(await readFile(`${parentRoot}/manifest.json`,'utf8')),p=parent.base.localInletSampling
const response={delay:Math.PI*(p.tubeInnerDiameterMetres/2)**2*p.tubeLengthMetres/(p.flowLitresPerMinutePerChannel*1e-3/60),rise:p.riseTimeConstantSeconds,recovery:p.recoveryTimeConstantSeconds,average:p.averagingSeconds}
const used=new Set(JSON.parse(await readFile('research/evidence/m90_observation_inverse_2026-09-13/manifest.json','utf8')).cases.map((c:any)=>c.index))
const cases=[]
for(const [index,c] of parent.cases.entries())if(!used.has(index)){const bytes=await readFile(`${parentRoot}/run-${index}.json.gz`);cases.push({index,...c,sha256:sha(bytes)})}
await mkdir(root,{recursive:true});const sources=[],inventory:any[]=[]
for(const file of ['scripts/m92-inverse-transfer.ts','scripts/lib/periodic-inverse.ts','scripts/lib/channel-reference.ts']){const b=await readFile(file);await mkdir(`${root}/source-snapshot/${file.split('/').slice(0,-1).join('/')}`,{recursive:true});await writeFile(`${root}/source-snapshot/${file}`,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
async function retain(file:string,v:unknown){const b=Buffer.from(JSON.stringify(v)+'\n');await writeFile(`${root}/${file}`,b,{flag:'wx'});inventory.push({file,sha256:sha(b)})}
await retain('manifest.json',{cases,sources,parentRoot,response,protocol:{scope:'96 archived records excluded from M90/91 inverse fitting. All previously used elsewhere in development; not paper-level held-out validation. No new simulations.',trainingVisits:[[0,1,4,5,8],[0,3,4,7,8]],methods:'Frozen M91 period screen and fitter; reference period0 versus training-selected periodic. Four response arms. No thresholds changed.',fitInput:'Only measured samples, training split and candidate-relative robot poses; nominal calibration shared across all profiles.'}})
const rows=[],started=Date.now();let maxRssBytes=0
for(const [caseIndex,c] of cases.entries()){
 const r=JSON.parse(gunzipSync(await readFile(`${parentRoot}/run-${c.index}.json.gz`)).toString()),candidate=r.summary.results[0].candidate,offset=r.config.localInletSampling.inspection.offsetNormalized
 const data:VisibleInverseData={poses:r.trace.map((t:any)=>({time:t.time,x:(t.position.x-candidate.x)/offset,y:(t.position.y-candidate.y)/offset})),samples:[]}
 for(const [round,result] of r.summary.results.entries())for(const [visit,v] of result.visits.entries())for(const s of v.samples){const index=Math.round(s.time/.25),observed=r.trace[index].measurement;if(!observed.valid||observed.concentration!==s.value)throw Error('Observation provenance');data.samples.push({index,value:observed.concentration,hit:observed.hit,train:(round?[0,3,4,7,8]:[0,1,4,5,8]).includes(visit)})}
 data.poses=data.poses.slice(0,Math.max(...data.samples.map(s=>s.index))+1)
 const selection=selectPeriod(data,r.config.sensorNoise),fits=[]
 for(const arm of ['reference','periodic'])for(const scale of [null,.8,1,1.2]){const settings=scale===null?null:{...response,rise:response.rise*scale,recovery:response.recovery*scale},period=arm==='reference'?0:selection.period;fits.push({arm,scale,response:settings,period,...fitPeriodic(data,settings,r.config.sensorNoise,period)})}
 const outcomes=['reference','periodic'].map(arm=>{const a=fits.filter(f=>f.arm===arm),plausible=a.filter(f=>f.scale!==null&&f.trainingPlausible);return {arm,instantaneous:a[0]!.supported,fixed:a.find(f=>f.scale===1)!.supported,uncertainty:plausible.length>0&&plausible.every(f=>f.supported),plausible:plausible.map(f=>f.scale)}})
 const summary={...c,caseIndex,selection,outcomes};maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
 await retain(`run-${caseIndex}.json`,{summary,data,noise:r.config.sensorNoise,fits});rows.push(summary);process.stdout.write(`${caseIndex+1}/${cases.length}\n`)
}
await retain('summary.json',{rows});await retain('runtime.json',{elapsedSeconds:(Date.now()-started)/1000,maxRssBytes,node:process.version,architecture:process.arch,platform:process.platform});await writeFile(`${root}/complete.json`,JSON.stringify({complete:true,cases:cases.length,inventory})+'\n',{flag:'wx'})
