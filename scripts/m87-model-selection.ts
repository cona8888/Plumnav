/** Verification-only commissioning. Repeat decisions are offline conjunctions,
 * not integrated source declarations or unseeded acquisition results. */
import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises'
import {dirname} from 'node:path'
import {createHash} from 'node:crypto'
import {gzipSync,gunzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {LocalMaximumProbe} from '../src/sim/algorithms/localMaximumProbe'
import {temporalContrast} from './lib/temporal-contrast'
import {selectedTemporalContrast} from './lib/temporal-selection'
const root='research/evidence/m87_model_selection_2026-09-13'
const parent=JSON.parse(await readFile('research/evidence/m84_local_maximum_components_2026-09-13/manifest.json','utf8'))
const base=parent.cases.find((c:any)=>c.family==='static'&&c.schedule==='near-peak'&&c.variant==='reference').config
const cases=[]
for(const field of ['uniform','peak','plateau','ridge','blank'])for(const signal of field==='blank'?['steady']:['plateau','ridge'].includes(field)?['steady','sine53']:['steady','sine31','sine53','sine97','chirp','drift','step-inside','asymmetric'])for(const seed of [87001,87002])for(const sensor of ['nominal','noise3','slow2'])cases.push({field,signal,seed,sensor,phase:seed===87001?.91:2.13,arm:'same240'})
await mkdir(root,{recursive:true})
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),inventory:any[]=[],sources:any[]=[]
async function retain(file:string,data:unknown,gzip=false){const b=Buffer.from(JSON.stringify(data)+'\n'),out=gzip?gzipSync(b):b;await writeFile(`${root}/${file}`,out,{flag:'wx'});inventory.push({file,sha256:sha(out)})}
async function snapshot(file:string){const b=await readFile(file);await mkdir(dirname(`${root}/source-snapshot/${file}`),{recursive:true});await writeFile(`${root}/source-snapshot/${file}`,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const p=`${dir}/${e.name}`;if(e.isDirectory())await walk(p);else if(p.endsWith('.ts'))await snapshot(p)}}
await walk('src/sim');await snapshot('scripts/m87-model-selection.ts');await snapshot('scripts/lib/temporal-contrast.ts');await snapshot('scripts/lib/temporal-selection.ts')
const archiveSources=[]
for(const stage of ['m85_temporal_order','m86_temporal_nuisance']){const dir=`research/evidence/${stage}_2026-09-13`,done=JSON.parse(await readFile(`${dir}/complete.json`,'utf8'));if(!done.complete)throw Error('Incomplete parent');for(const entry of done.inventory){const bytes=await readFile(`${dir}/${entry.file}`);if(sha(bytes)!==entry.sha256)throw Error('Parent drift')}archiveSources.push({dir,completeSha256:sha(await readFile(`${dir}/complete.json`))})}
await retain('manifest.json',{cases,base,sources,archiveSources,protocol:{duration:600,repeatStart:240,order:[0,1,2,3],amplitude:.08,phaseLinkedToSeed:true,models:['M86','affine-first','affine-first-with-per-round-fallback'],rules:'Global affine gets priority if alternating-visit train/test/full RMS <=3noise. Optional per-round affine priority next. Otherwise unchanged M86 harmonic. No fallback triggered by flank rejection. Contrast3noise retained. Frozen before archived rescoring and validation.',validation:'126 new runs; two phase/seed pairings, nominal/noise3/slow2 profiles separately. Slow2 doubles both sensor time constants and increases settling and dwell to retain physical validity. Timing/order fixed, not selected from prior results.',scope:'Complete bounded model-selection experiment; no source-localisation, field-safety or universal-identifiability claim. No source truth supplied to scoring.'}})
const archived=[]
for(const {dir} of archiveSources){const manifest=JSON.parse(await readFile(`${dir}/manifest.json`,'utf8'));for(let i=0;i<manifest.cases.length;i++){const bytes=await readFile(`${dir}/run-${i}.json.gz`),r=JSON.parse(gunzipSync(bytes).toString()),summary=r.summary;if(summary.results.length!==2)continue;const orders=[[0,1,2,3],summary.order??(summary.arm==='reverse-repeat'?[3,2,1,0]:[0,1,2,3])],old=temporalContrast(summary.results,r.config.sensorNoise,orders);if(summary.corrected&&JSON.stringify(old)!==JSON.stringify(summary.corrected))throw Error('M86 score replay mismatch');archived.push({parent:dir,index:i,sha256:sha(bytes),field:summary.field,signal:summary.signal??`${summary.period}:${summary.phase}`,arm:summary.arm,original:summary.supported,old,affine:selectedTemporalContrast(summary.results,r.config.sensorNoise,orders),piecewise:selectedTemporalContrast(summary.results,r.config.sensorNoise,orders,true)})}}
await retain('archived.json',{rows:archived})
const summaries=[]
for(const [index,spec] of cases.entries()){
 const config=structuredClone(base);config.seed=spec.seed;config.durationSeconds=600;config.checkpointSeconds=[600];config.robotStartPositionOverride={x:.5,y:.5}
 if(spec.sensor==='noise3')config.sensorNoise*=3
 if(spec.sensor==='slow2'){const p=config.localInletSampling;p.riseTimeConstantSeconds*=2;p.recoveryTimeConstantSeconds*=2;config.sensorLag=p.riseTimeConstantSeconds;p.inspection.settlingSeconds+=-Math.log(.05)*2;p.inspection.dwellSeconds=Math.ceil(p.inspection.settlingSeconds+4);config.activeSniffCycleSeconds=p.inspection.dwellSeconds;p.inspection.maximumPairSeparationSeconds=2*p.inspection.dwellSeconds+2}
 const engine=new SimulationEngine(config),probes:LocalMaximumProbe[]=[],trace:any[]=[]
 engine.plume.concentrationAt=(p,t)=>{if(spec.field==='blank')return 0;const r=Math.hypot(p.x-.5,p.y-.5)*config.domainMeters,x=Math.abs(p.x-.5)*config.domainMeters,d=spec.field==='ridge'?x:spec.field==='plateau'?Math.max(0,r-.3):r,c=spec.field==='uniform'?1:.01+Math.exp(-d*d/(2*.6**2)),signal=spec.signal;const variation=signal.startsWith('sine')?.08*Math.sin(2*Math.PI*t/Number(signal.slice(4))+spec.phase):signal==='chirp'?.08*Math.sin(2*Math.PI*(t/37+t*t/18000)+spec.phase):signal==='drift'?.08*t/600:signal==='step-inside'?(t>=75?.08:0):signal==='asymmetric'?.08*(Math.sin(2*Math.PI*t/53+spec.phase)+.35*Math.sin(4*Math.PI*t/53+spec.phase))/1.35:0;return c*(1+variation)}
 const start=(time:number,order:number[])=>{const probe=new LocalMaximumProbe(engine.environment,order);probes.push(probe);Object.assign(engine.controller,{localMaximum:probe});probe.start({time,dt:.25,position:engine.getFrame().robot.position,heading:0,distance:0,observations:[],measurement:{time,concentration:0,valid:false,hit:false,sampleMode:'passive',wind:{x:0,y:0}}},{x:.5,y:.5})}
 start(0,[0,1,2,3])
 // Bypass acquisition after rejected probes: a controlled verification fixture
 // holds position until the prescribed repeat, instead of confounding search.
 engine.controller.step=input=>{const decision=probes.at(-1)!.step(input)??{direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase:'VERIFICATION FIXTURE HOLD'};trace.push({time:input.time,position:input.position,measurement:input.measurement,decision});return decision}
 const repeatStart=240,order=[0,1,2,3]
 while(!engine.isCompleted()){if(trace.length===repeatStart*4)start(repeatStart,order);engine.step()}
 const results=probes.map(p=>p.snapshot().results[0]);if(results.some(r=>!r))throw Error('Incomplete circuit')
 const corrected=temporalContrast(results,config.sensorNoise,[[0,1,2,3],order])
 const summary={...spec,index,repeatStart,order,corrected,affine:selectedTemporalContrast(results,config.sensorNoise,[[0,1,2,3],order]),piecewise:selectedTemporalContrast(results,config.sensorNoise,[[0,1,2,3],order],true),results,supported:results.every(r=>r.status==='supported'),path:engine.getFrame().metrics.pathLengthMeters,probeSeconds:results.reduce((s,r)=>s+r.completedAt-r.startedAt,0)}
 summaries.push(summary);await retain(`run-${index}.json.gz`,{config,summary,trace},true)
 if(index%18===17)process.stdout.write(`${index+1}/${cases.length}\n`)
}
await retain('summary.json',{summaries});await writeFile(`${root}/complete.json`,JSON.stringify({complete:true,runs:cases.length,inventory})+'\n',{flag:'wx'})
