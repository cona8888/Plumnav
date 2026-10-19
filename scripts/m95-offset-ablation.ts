import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {gunzipSync,gzipSync} from 'node:zlib'
import {fitOffset,selectOffsetPeriod} from './lib/offset-inverse'
import {fitPeriodic} from './lib/periodic-inverse'
const root='research/evidence/m95_offset_ablation_2026-09-14',sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
await mkdir(root,{recursive:true})
const inventory:any[]=[],sources=[]
async function retain(file:string,value:unknown,zip=false){const raw=Buffer.from(JSON.stringify(value)+'\n'),b=zip?gzipSync(raw):raw;await writeFile(`${root}/${file}`,b,{flag:'wx'});inventory.push({file,sha256:sha(b)})}
for(const f of ['scripts/m95-offset-ablation.ts','scripts/lib/offset-inverse.ts','scripts/lib/periodic-inverse.ts','scripts/lib/channel-reference.ts']){const b=await readFile(f);const name=f.replaceAll('/','__');await writeFile(`${root}/${name}`,b,{flag:'wx'});sources.push({file:f,snapshot:name,sha256:sha(b)})}
const parents=['m94_transport_inverse_2026-09-14','m93_response_safety_2026-09-14']
await retain('protocol.json',{sources,parents,scope:'Development ablation after M94 failure; archived observation rescoring, not new simulations or independent confirmation.',model:'M91 plus linear x/y gradients. Maximum must lie in convex hull of cross: abs(gx/(2kx))+abs(gy/(2ky))<=1. Same residual and curvature thresholds, temporal grid, train/test split, response grid and solver bounds. No gradient/peak-offset truth passed into fitting.',noAws:true})
const rows=[];let replayMax=0,maxRssBytes=0;const start=Date.now()
for(const parent of parents){const dir=`research/evidence/${parent}`,complete=JSON.parse(await readFile(`${dir}/complete.json`,'utf8'));for(const item of complete.inventory.filter((r:any)=>/^run-\d+\.json\.gz$/.test(r.file))){const b=await readFile(`${dir}/${item.file}`);if(sha(b)!==item.sha256)throw Error('Parent checksum');const run=JSON.parse(gunzipSync(b).toString()),noise=run.config.sensorNoise,selection=selectOffsetPeriod(run.data,noise),fits=[]
 for(const old of run.fits){const replay=fitPeriodic(run.data,old.response,noise,old.period);const d=Math.max(...replay.predictions.map((v:number,i:number)=>Math.abs(v-old.predictions[i])));replayMax=Math.max(replayMax,d);if(d>1e-10||replay.supported!==old.supported)throw Error('Frozen baseline replay failed');fits.push({scale:old.scale,response:old.response,...fitOffset(run.data,old.response,noise,selection.period)})}
 const plausible=fits.filter(f=>f.scale!==null&&f.trainingPlausible),row={parent,file:item.file,parentSha256:item.sha256,original:run.summary,selection,instantaneous:fits[0].supported,fixed:fits.find(f=>f.scale===1)!.supported,uncertainty:plausible.length>0&&plausible.every(f=>f.supported)}
 await retain(`fit-${rows.length}.json.gz`,{row,fits},true);rows.push(row);maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
 if(rows.length%25===0)process.stdout.write(`${rows.length} cases\n`)
}}
await retain('summary.json',{rows,replayMax});await retain('runtime.json',{elapsedSeconds:(Date.now()-start)/1000,maxRssBytes});await writeFile(`${root}/complete.json`,JSON.stringify({complete:true,cases:rows.length,inventory})+'\n',{flag:'wx'})
