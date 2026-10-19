/** Verification-only commissioning. Repeat decisions are offline conjunctions,
 * not integrated source declarations or unseeded acquisition results. */
import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises'
import {dirname} from 'node:path'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {LocalMaximumProbe} from '../src/sim/algorithms/localMaximumProbe'
import {temporalContrast} from './lib/temporal-contrast'
const root='research/evidence/m86_temporal_nuisance_2026-09-13'
const parent=JSON.parse(await readFile('research/evidence/m84_local_maximum_components_2026-09-13/manifest.json','utf8'))
const base=parent.cases.find((c:any)=>c.family==='static'&&c.schedule==='near-peak'&&c.variant==='reference').config
const cases=[]
for(const field of ['uniform','peak','blank'])for(const signal of field==='blank'?['steady']:['steady','sine29','sine47','sine83','chirp','drift','step'])for(const seed of [86001,86002])for(const arm of ['same240','same211','permuted211'])cases.push({field,signal,seed,arm})
await mkdir(root,{recursive:true})
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),inventory:any[]=[],sources:any[]=[]
async function retain(file:string,data:unknown,gzip=false){const b=Buffer.from(JSON.stringify(data)+'\n'),out=gzip?gzipSync(b):b;await writeFile(`${root}/${file}`,out,{flag:'wx'});inventory.push({file,sha256:sha(out)})}
async function snapshot(file:string){const b=await readFile(file);await mkdir(dirname(`${root}/source-snapshot/${file}`),{recursive:true});await writeFile(`${root}/source-snapshot/${file}`,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const p=`${dir}/${e.name}`;if(e.isDirectory())await walk(p);else if(p.endsWith('.ts'))await snapshot(p)}}
await walk('src/sim');await snapshot('scripts/m86-temporal-nuisance.ts');await snapshot('scripts/lib/temporal-contrast.ts')
await retain('manifest.json',{cases,base,sources,protocol:{duration:600,firstStart:0,repeatStarts:[240,211],candidate:{x:.5,y:.5},amplitude:.08,phase:.37,signals:'sine periods29/47/83; chirp phase 2pi(t/25+t²/12000)+.37; drift .08*t/600; step +.08 at t=180; steady 0. Modulation multiplies spatial field.',scoring:'Both original circuits supported versus centre-only affine/sinusoid fit on alternating whole centre visits; validate on remaining centres; refit at chosen frequency; both rounds four model-minus-flank median contrasts >3noise. RMSE gates 3noise. No field labels/true period passed to scoring.',scope:'Seeded verification only. 90 missions; reused spatial fixtures, new temporal conditions and seeds. Not held-out performance after broad prior development; no new hardware or soil model.'}})
const summaries=[]
for(const [index,spec] of cases.entries()){
 const config=structuredClone(base);config.seed=spec.seed;config.durationSeconds=600;config.checkpointSeconds=[600];config.robotStartPositionOverride={x:.5,y:.5}
 const engine=new SimulationEngine(config),probes:LocalMaximumProbe[]=[],trace:any[]=[]
 engine.plume.concentrationAt=(p,t)=>{if(spec.field==='blank')return 0;const r=Math.hypot(p.x-.5,p.y-.5)*config.domainMeters,c=spec.field==='uniform'?1:.01+Math.exp(-r*r/(2*.6**2));const signal=spec.signal;const variation=signal.startsWith('sine')?.08*Math.sin(2*Math.PI*t/Number(signal.slice(4))+.37):signal==='chirp'?.08*Math.sin(2*Math.PI*(t/25+t*t/12000)+.37):signal==='drift'?.08*t/600:signal==='step'&&t>=180?.08:0;return c*(1+variation)}
 const start=(time:number,order:number[])=>{const probe=new LocalMaximumProbe(engine.environment,order);probes.push(probe);Object.assign(engine.controller,{localMaximum:probe});probe.start({time,dt:.25,position:engine.getFrame().robot.position,heading:0,distance:0,observations:[],measurement:{time,concentration:0,valid:false,hit:false,sampleMode:'passive',wind:{x:0,y:0}}},{x:.5,y:.5})}
 start(0,[0,1,2,3])
 // Bypass acquisition after rejected probes: a controlled verification fixture
 // holds position until the prescribed repeat, instead of confounding search.
 engine.controller.step=input=>{const decision=probes.at(-1)!.step(input)??{direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase:'VERIFICATION FIXTURE HOLD'};trace.push({time:input.time,position:input.position,measurement:input.measurement,decision});return decision}
 const repeatStart=spec.arm==='same240'?240:211,order=spec.arm==='permuted211'?[2,0,3,1]:[0,1,2,3]
 while(!engine.isCompleted()){if(trace.length===repeatStart*4)start(repeatStart,order);engine.step()}
 const results=probes.map(p=>p.snapshot().results[0]);if(results.some(r=>!r))throw Error('Incomplete circuit')
 const corrected=temporalContrast(results,config.sensorNoise,[[0,1,2,3],order])
 const summary={...spec,index,repeatStart,order,corrected,results,supported:results.every(r=>r.status==='supported'),path:engine.getFrame().metrics.pathLengthMeters,probeSeconds:results.reduce((s,r)=>s+r.completedAt-r.startedAt,0)}
 summaries.push(summary);await retain(`run-${index}.json.gz`,{config,summary,trace},true)
 if(index%18===17)process.stdout.write(`${index+1}/${cases.length}\n`)
}
await retain('summary.json',{summaries});await writeFile(`${root}/complete.json`,JSON.stringify({complete:true,runs:cases.length,inventory})+'\n',{flag:'wx'})
