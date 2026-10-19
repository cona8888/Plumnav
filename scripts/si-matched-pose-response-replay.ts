import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {gunzipSync,gzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {quadSniffChannelDirections} from '../src/sim/quadSniff'
import {channelReference} from './lib/channel-reference'
import type {Vec2} from '../src/sim/types'
const parent='research/evidence/si_clocked_arrival_2026-09-14',root=resolve(process.argv[2]??'research/evidence/si_matched_pose_response_replay_2026-09-14'),sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const pc=await readFile(`${parent}/complete.json`),complete=JSON.parse(pc.toString()),parentSummary=JSON.parse(await readFile(`${parent}/summary.json`,'utf8'))
if(!complete.complete||complete.cases!==66)throw Error('Incomplete parent')
const parentInventory=new Map(complete.inventory.map((e:{file:string;sha256:string})=>[e.file,e.sha256]))
async function parentRun(index:number){const name=`run-${index}.json.gz`,b=await readFile(`${parent}/${name}`);if(sha(b)!==parentInventory.get(name))throw Error('Parent hash');return JSON.parse(gunzipSync(b).toString())}
await mkdir(root)
const sources:any[]=[],inventory:any[]=[]
async function snapshot(file:string){const b=await readFile(file),dest=resolve(root,'source-snapshot',file);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const f=`${dir}/${e.name}`;if(e.isDirectory())await walk(f);else if(f.endsWith('.ts'))await snapshot(f)}}
await walk('src/sim');for(const f of ['scripts/si-matched-pose-response-replay.ts','scripts/lib/channel-reference.ts','scripts/si-clocked-arrival-study.ts','research/protocols/si_matched_pose_response_replay_2026-09-14.md'])await snapshot(f)
async function retain(file:string,value:unknown,zip=false){const b=Buffer.from(JSON.stringify(value)+'\n'),out=zip?gzipSync(b):b;await writeFile(resolve(root,file),out,{flag:'wx'});inventory.push({file,sha256:sha(out)})}
await retain('manifest.json',{version:'si-stage-1d-matched-replay',parent,parentCompleteSha256:sha(pc),sources,protocol:'research/protocols/si_matched_pose_response_replay_2026-09-14.md',selectedReplayFields:['offset-peak','si-continuous','si-narrow','si-pulse'],selectedReplayDt:[.25,.0625],channelToleranceC0:1e-6,scope:'Evaluator-only known-input decomposition. No algorithm receives true field, source position, sensor input history or period.'})
function fieldFor(run:any){const config=run.config,field=run.spec.field,engine=new SimulationEngine(config);if(field.startsWith('si-'))return (p:Vec2,t:number)=>engine.plume.concentrationAt(p,t)
 return (p:Vec2,_t:number)=>{const x=(p.x-.5)*config.domainMeters,y=(p.y-.5)*config.domainMeters,r=Math.hypot(x,y);switch(field){case 'peak':return .01+Math.exp(-r*r/(2*.3**2));case 'offset-peak':return .01+Math.exp(-((x-.03)**2+(y+.02)**2)/(2*.3**2));case 'ridge':return .01+Math.exp(-x*x/(2*.3**2));case 'saddle':return Math.max(0,1-(x*x+y*y)/(2*.3**2)+2*x*y/.3**2);case 'plateau':return r<=.3?1:.01+.99*Math.exp(-((r-.3)**2)/(2*.3**2));case 'uniform':return 1;case 'clipped-peak':return 3*Math.exp(-r*r/(2*.3**2));default:return 0}}
}
function inletValues(config:any,field:(p:Vec2,t:number)=>number,position:Vec2,heading:number,time:number){const rad=config.localInletSampling.opposingInletSpacingMetres/(2*config.domainMeters);return quadSniffChannelDirections({x:Math.cos(heading),y:Math.sin(heading)}).map(g=>field({x:position.x+rad*g.direction.x,y:position.y+rad*g.direction.y},time))}
const mean=(v:number[])=>v.reduce((a,b)=>a+b,0)/v.length,rows:any[]=[],replays:any[]=[],started=Date.now();let maxRssBytes=0
for(const field of [...new Set(parentSummary.rows.map((r:any)=>r.field))]){
 const fineIndex=parentSummary.rows.findIndex((r:any)=>r.field===field&&r.noiseMode==='zero'&&r.dt===.0625),fine=await parentRun(fineIndex),evalField=fieldFor(fine)
 for(const dt of [.25,.125]){const index=parentSummary.rows.findIndex((r:any)=>r.field===field&&r.noiseMode==='zero'&&r.dt===dt),coarse=await parentRun(index),samples:any[]=[]
  for(const [visit,cv] of coarse.visits.entries()){const fv=fine.visits[visit];if(cv.samples.length!==fv.samples.length)throw Error('Unequal sample count')
   for(const [k,cs] of cv.samples.entries()){const fs=fv.samples[k];if(cs.time!==fs.time)throw Error('Unmatched clock');const t=cs.time,c=coarse.trace[Math.round(t/dt)],f=fine.trace[Math.round(t/.0625)],C=c.position,F=f.position,ch=c.heading,fh=f.heading
    const cc=mean(inletValues(coarse.config,evalField,C,ch,t)),ff=mean(inletValues(fine.config,evalField,F,fh,t)),cf=mean(inletValues(coarse.config,evalField,C,fh,t)),fc=mean(inletValues(fine.config,evalField,F,ch,t))
    const measuredDelta=cs.value-fs.value,directDelta=cc-ff,positionComponent=((cc-fc)+(cf-ff))/2,headingComponent=((cc-cf)+(fc-ff))/2
    samples.push({visit,time:t,measuredDelta,directDelta,positionComponent,headingComponent,residual:measuredDelta-directDelta,coarseInstantaneous:cc,fineInstantaneous:ff,clipped:cs.clipped||fs.clipped})
   }
  }
  const clean=samples.filter(s=>!s.clipped),rms=(a:any[],key:string)=>Math.sqrt(a.reduce((v,s)=>v+s[key]**2,0)/a.length)
  const row={field,coarseDt:dt,coarseIndex:index,fineIndex,samples:samples.length,cleanSamples:clean.length,clippedSamples:samples.length-clean.length,
   cleanRmsMeasured:clean.length?rms(clean,'measuredDelta'):null,cleanRmsInstantaneous:clean.length?rms(clean,'directDelta'):null,
   cleanRmsPosition:clean.length?rms(clean,'positionComponent'):null,cleanRmsHeading:clean.length?rms(clean,'headingComponent'):null,
   cleanRmsResidual:clean.length?rms(clean,'residual'):null,
   maxAbsolutePointwiseResidual:clean.length?Math.max(...clean.map(s=>Math.abs(s.residual))):null}
  await retain(`pair-${rows.length}.json.gz`,{row,samples},true);rows.push(row);maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
 }
 if(['offset-peak','si-continuous','si-narrow','si-pulse'].includes(field))for(const dt of [.25,.0625]){const index=parentSummary.rows.findIndex((r:any)=>r.field===field&&r.noiseMode==='zero'&&r.dt===dt),run=await parentRun(index),evalRun=fieldFor(run),config=run.config,p=config.localInletSampling,last=Math.round(run.row.completedAt/dt),inputs=[[],[],[],[]] as Array<Array<{time:number;value:number}>>
  for(let j=0;j<=last;j++){const tick=run.trace[j],values=inletValues(config,evalRun,tick.position,tick.heading,tick.time);for(let k=0;k<4;k++)inputs[k]!.push({time:tick.time,value:values[k]!})}
  const delay=Math.PI*(p.tubeInnerDiameterMetres/2)**2*p.tubeLengthMetres/(p.flowLitresPerMinutePerChannel*1e-3/60),settings={delay,rise:p.riseTimeConstantSeconds,recovery:p.recoveryTimeConstantSeconds,average:p.averagingSeconds},predictions=inputs.map(input=>channelReference(input,settings,.05)),errors:number[]=[],clippedErrors:number[]=[]
  for(let j=0;j<=last;j++){const m=run.trace[j].measurement;if(!m.valid)continue;for(let k=0;k<4;k++){const expected=Math.min(config.sensorSaturation,Math.max(0,predictions[k]![j]!)),error=Math.abs(expected-m.localInletReadings[k].concentration);(m.localInletReadings[k].saturated?clippedErrors:errors).push(error)}}
  const row={field,dt,index,readouts:errors.length+clippedErrors.length,unclippedReadouts:errors.length,clippedReadouts:clippedErrors.length,maxUnclippedError:Math.max(0,...errors),maxClippedError:Math.max(0,...clippedErrors),tolerance:1e-6,withinTolerance:Math.max(0,...errors,...clippedErrors)<=1e-6}
  await retain(`replay-${replays.length}.json.gz`,{row,settings,inputs,predictions},true);replays.push(row);maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss)
 }
 process.stdout.write(`${field}: ${rows.length} pairs, ${replays.length} replays\n`)
}
await retain('summary.json',{rows,replays,elapsedSeconds:(Date.now()-started)/1000,maxRssBytes});await writeFile(resolve(root,'complete.json'),JSON.stringify({complete:true,pairs:rows.length,replays:replays.length,inventory})+'\n',{flag:'wx'})
