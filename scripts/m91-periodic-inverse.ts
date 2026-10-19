import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fitPeriodic,selectPeriod} from './lib/periodic-inverse'
const root='research/evidence/m91_periodic_inverse_2026-09-14',parentRoot='research/evidence/m90_observation_inverse_2026-09-13',sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const parent=JSON.parse(await readFile(`${parentRoot}/manifest.json`,'utf8')),done=JSON.parse(await readFile(`${parentRoot}/complete.json`,'utf8'))
if(!done.complete)throw Error('Incomplete parent');for(const r of done.inventory)if(sha(await readFile(`${parentRoot}/${r.file}`))!==r.sha256)throw Error('Parent drift')
await mkdir(root,{recursive:true});const sources=[],inventory:any[]=[]
for(const file of ['scripts/m91-periodic-inverse.ts','scripts/lib/periodic-inverse.ts','scripts/lib/channel-reference.ts']){const b=await readFile(file);await mkdir(`${root}/source-snapshot/${file.split('/').slice(0,-1).join('/')}`,{recursive:true});await writeFile(`${root}/source-snapshot/${file}`,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
async function retain(file:string,data:unknown){const b=Buffer.from(JSON.stringify(data)+'\n');await writeFile(`${root}/${file}`,b,{flag:'wx'});inventory.push({file,sha256:sha(b)})}
await retain('manifest.json',{parentRoot,parentCompleteSha256:sha(await readFile(`${parentRoot}/complete.json`)),sources,cases:parent.cases,protocol:{scope:'30 reused observation-only records;120 frozen reference fit replays and120 temporal-extension fits. No new missions or held-out field benchmark.',selection:'Training-only instantaneous quadratic/spatial affine-time least squares; retain affine if RMSE<=3noise else screen periods20..120s step0.5. Same selected period for all response arms. No validation values used.',model:'a+b*t/600-kx*x²-ky*y²+u*sin(2pi*t/P)+v*cos(2pi*t/P); clamped nonnegative. Harmonic coefficients bounded +-0.3. Other bounds, optimisation and support guards unchanged. Frequency selection is approximate, not joint calibration-frequency optimisation.'}})
const rows=[]
for(let i=0;i<parent.cases.length;i++){
 const bytes=await readFile(`${parentRoot}/run-${i}.json`),r=JSON.parse(bytes.toString()),selection=selectPeriod(r.data,r.noise),fits=[]
 for(const arm of ['reference','periodic'])for(const f of r.fits){const period=arm==='reference'?0:selection.period,result=fitPeriodic(r.data,f.response,r.noise,period);if(arm==='reference'&&JSON.stringify(result)!==JSON.stringify(Object.fromEntries(Object.entries(f).filter(([k])=>!['scale','response'].includes(k)))))throw Error('Frozen fit drift');fits.push({arm,scale:f.scale,response:f.response,period,...result})}
 const outcomes=['reference','periodic'].map(arm=>{const a=fits.filter(f=>f.arm===arm),p=a.filter(f=>f.scale!==null&&f.trainingPlausible);return {arm,instantaneous:a[0]!.supported,fixed:a.find(f=>f.scale===1)!.supported,uncertainty:p.length>0&&p.every(f=>f.supported),plausible:p.map(f=>f.scale)}})
 const summary={index:i,field:r.summary.field,signal:r.summary.signal,sensor:r.summary.sensor,selection,outcomes};await retain(`run-${i}.json`,{parentSha256:sha(bytes),data:r.data,noise:r.noise,summary,fits});rows.push(summary);process.stdout.write(`${i+1}/${parent.cases.length}\n`)
}
await retain('summary.json',{rows});await writeFile(`${root}/complete.json`,JSON.stringify({complete:true,cases:rows.length,inventory})+'\n',{flag:'wx'})
