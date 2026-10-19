/** Verification-only commissioning. Repeat decisions are offline conjunctions,
 * not integrated source declarations or unseeded acquisition results. */
import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises'
import {dirname} from 'node:path'
import {createHash} from 'node:crypto'
import {gzipSync,gunzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {channelReference} from './lib/channel-reference'
import {LocalMaximumProbe} from '../src/sim/algorithms/localMaximumProbe'
import {temporalContrast} from './lib/temporal-contrast'
import {selectedTemporalContrast} from './lib/temporal-selection'
const root='research/evidence/m89_channel_history_2026-09-13'
const parentRoot='research/evidence/m87_model_selection_2026-09-13',parent=JSON.parse(await readFile(`${parentRoot}/manifest.json`,'utf8')),base=parent.base,cases=[]
for(const [parentIndex,c] of parent.cases.entries())if(c.seed===87001&&c.sensor!=='noise3'&&['uniform','peak'].includes(c.field)&&['sine53','sine97','step-inside'].includes(c.signal))cases.push({...c,parentIndex,timing:'reference'})
await mkdir(root,{recursive:true})
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),inventory:any[]=[],sources:any[]=[]
async function retain(file:string,data:unknown,gzip=false){const b=Buffer.from(JSON.stringify(data)+'\n'),out=gzip?gzipSync(b):b;await writeFile(`${root}/${file}`,out,{flag:'wx'});inventory.push({file,sha256:sha(out)})}
async function snapshot(file:string){const b=await readFile(file);await mkdir(dirname(`${root}/source-snapshot/${file}`),{recursive:true});await writeFile(`${root}/source-snapshot/${file}`,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const p=`${dir}/${e.name}`;if(e.isDirectory())await walk(p);else if(p.endsWith('.ts'))await snapshot(p)}}
await walk('src/sim');await snapshot('scripts/m89-channel-history.ts');await snapshot('scripts/lib/temporal-contrast.ts');await snapshot('scripts/lib/temporal-selection.ts');await snapshot('scripts/lib/channel-reference.ts')
const parentComplete=JSON.parse(await readFile(`${parentRoot}/complete.json`,'utf8'));if(!parentComplete.complete)throw Error('Incomplete parent')
for(const e of parentComplete.inventory)if(sha(await readFile(`${parentRoot}/${e.file}`))!==e.sha256)throw Error('Parent hash')
await retain('manifest.json',{cases,base,sources,parentRoot,parentCompleteSha256:sha(await readFile(`${parentRoot}/complete.json`)),protocol:{duration:600,repeatStart:240,scope:'12 exact archived replays with instrumented local-channel inputs and clean outputs. Independent event-split RK4 prediction uses known true inlet history, not observations alone. Oracle commissioning only; never supplied to controller.',steps:[.01,.005],matchedTolerance:1e-7,variants:['matched','tau0.8','tau1.2','delay0.8','delay1.2'],model:'Clean prehistory, plug delay, asymmetric first-order response, trailing average. No new physical validation.'}})
const replays=[]
const summaries=[]
for(const [index,spec] of cases.entries()){
 const config=structuredClone(base);config.seed=spec.seed;config.durationSeconds=600;config.checkpointSeconds=[600];config.robotStartPositionOverride={x:.5,y:.5}
 if(spec.sensor==='noise3')config.sensorNoise*=3
 if(spec.sensor==='slow2'){const p=config.localInletSampling;p.riseTimeConstantSeconds*=2;p.recoveryTimeConstantSeconds*=2;config.sensorLag=p.riseTimeConstantSeconds;p.inspection.settlingSeconds+=-Math.log(.05)*2;p.inspection.dwellSeconds=Math.ceil(p.inspection.settlingSeconds+4);config.activeSniffCycleSeconds=p.inspection.dwellSeconds;p.inspection.maximumPairSeparationSeconds=2*p.inspection.dwellSeconds+2}
 if(spec.timing!=='reference'){const p=config.localInletSampling,tau=Math.max(p.riseTimeConstantSeconds,p.recoveryTimeConstantSeconds);p.inspection.dwellSeconds+=tau;if(spec.timing==='extra-settle')p.inspection.settlingSeconds+=tau;config.activeSniffCycleSeconds=p.inspection.dwellSeconds;p.inspection.maximumPairSeparationSeconds=2*p.inspection.dwellSeconds+2}
 const engine=new SimulationEngine(config),probes:LocalMaximumProbe[]=[],trace:any[]=[],histories:any[][]=Array.from({length:4},()=>[])
 ;(engine as any).localChannels.forEach((ch:any,j:number)=>{const update=ch.update.bind(ch);ch.update=(time:number,value:number)=>{const output=update(time,value);histories[j]!.push({time,value,output});return output}})
 engine.plume.concentrationAt=(p,t)=>{if(spec.field==='blank')return 0;const r=Math.hypot(p.x-.5,p.y-.5)*config.domainMeters,x=Math.abs(p.x-.5)*config.domainMeters,d=spec.field==='ridge'?x:spec.field==='plateau'?Math.max(0,r-.3):r,c=spec.field==='uniform'?1:.01+Math.exp(-d*d/(2*.6**2)),signal=spec.signal;const variation=signal.startsWith('sine')?.08*Math.sin(2*Math.PI*t/Number(signal.slice(4))+spec.phase):signal==='chirp'?.08*Math.sin(2*Math.PI*(t/37+t*t/18000)+spec.phase):signal==='drift'?.08*t/600:signal==='step-inside'?(t>=75?.08:0):signal==='asymmetric'?.08*(Math.sin(2*Math.PI*t/53+spec.phase)+.35*Math.sin(4*Math.PI*t/53+spec.phase))/1.35:0;return c*(1+variation)}
 const start=(time:number,order:number[])=>{const probe=new LocalMaximumProbe(engine.environment,order);probes.push(probe);Object.assign(engine.controller,{localMaximum:probe});probe.start({time,dt:.25,position:engine.getFrame().robot.position,heading:0,distance:0,observations:[],measurement:{time,concentration:0,valid:false,hit:false,sampleMode:'passive',wind:{x:0,y:0}}},{x:.5,y:.5})}
 start(0,[0,1,2,3])
 // Bypass acquisition after rejected probes: a controlled verification fixture
 // holds position until the prescribed repeat, instead of confounding search.
 engine.controller.step=input=>{const decision=probes.at(-1)!.step(input)??{direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase:'VERIFICATION FIXTURE HOLD'};trace.push({time:input.time,position:input.position,measurement:input.measurement,decision});return decision}
 const repeatStart=240,order=[0,1,2,3]
 while(!engine.isCompleted()){if(trace.length===repeatStart*4)start(repeatStart,order);engine.step()}
 const results=probes.map(p=>p.snapshot().results[0]);if(results.some(r=>!r))throw Error('Incomplete circuit')
 if(spec.timing==='reference'){const old=JSON.parse(gunzipSync(await readFile(`${parentRoot}/run-${spec.parentIndex}.json.gz`)).toString());if(JSON.stringify(trace)!==JSON.stringify(old.trace))throw Error('Reference replay drift');replays.push({index,parentIndex:spec.parentIndex,exact:true})}
 const corrected=temporalContrast(results,config.sensorNoise,[[0,1,2,3],order])
 const p=config.localInletSampling,delay=Math.PI*(p.tubeInnerDiameterMetres/2)**2*p.tubeLengthMetres/(p.flowLitresPerMinutePerChannel*1e-3/60),oracle=[]
 for(const variant of ['matched','tau0.8','tau1.2','delay0.8','delay1.2']){const settings={delay:delay*(variant==='delay0.8'?.8:variant==='delay1.2'?1.2:1),rise:p.riseTimeConstantSeconds*(variant==='tau0.8'?.8:variant==='tau1.2'?1.2:1),recovery:p.recoveryTimeConstantSeconds*(variant==='tau0.8'?.8:variant==='tau1.2'?1.2:1),average:p.averagingSeconds},predictions=histories.map(h=>channelReference(h,settings,.005)),coarse=variant==='matched'?histories.map(h=>channelReference(h,settings,.01)):null
 const errors=predictions.flatMap((a,j)=>a.map((v,k)=>v-histories[j]![k].output)),maxError=Math.max(...errors.map(Math.abs)),refinementMax=coarse?Math.max(...predictions.flatMap((a,j)=>a.map((v,k)=>Math.abs(v-coarse[j]![k]!)))):null
 if(variant==='matched'&&(maxError>1e-7||refinementMax!>1e-7))throw Error('Independent channel reconstruction failed')
 const times=results.flatMap(r=>r.visits.flatMap(v=>v.samples.map(s=>s.time))),retainedErrors=times.map(t=>{const k=Math.round(t/config.fixedDt);return predictions.reduce((a,c)=>a+c[k]!,0)/4-histories.reduce((a,c)=>a+c[k].output,0)/4})
 oracle.push({variant,settings,predictions,maxError,refinementMax,retainedRmse:Math.sqrt(retainedErrors.reduce((a,v)=>a+v*v,0)/retainedErrors.length),retainedMax:Math.max(...retainedErrors.map(Math.abs))})}
 const summary={...spec,index,repeatStart,order,corrected,affine:selectedTemporalContrast(results,config.sensorNoise,[[0,1,2,3],order]),piecewise:selectedTemporalContrast(results,config.sensorNoise,[[0,1,2,3],order],true),results,supported:results.every(r=>r.status==='supported'),path:engine.getFrame().metrics.pathLengthMeters,probeSeconds:results.reduce((s,r)=>s+r.completedAt-r.startedAt,0)}
 summaries.push(summary);await retain(`run-${index}.json.gz`,{config,summary,trace,histories,oracle},true)
 if(true)process.stdout.write(`${index+1}/${cases.length}\n`)
}
await retain('summary.json',{summaries});await retain('replays.json',{replays});await writeFile(`${root}/complete.json`,JSON.stringify({complete:true,runs:cases.length,inventory})+'\n',{flag:'wx'})
