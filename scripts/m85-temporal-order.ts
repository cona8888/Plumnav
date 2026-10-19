/** Verification-only commissioning. Repeat decisions are offline conjunctions,
 * not integrated source declarations or unseeded acquisition results. */
import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises'
import {dirname} from 'node:path'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {LocalMaximumProbe} from '../src/sim/algorithms/localMaximumProbe'
const root='research/evidence/m85_temporal_order_2026-09-13'
const parent=JSON.parse(await readFile('research/evidence/m84_local_maximum_components_2026-09-13/manifest.json','utf8'))
const base=parent.cases.find((c:any)=>c.family==='static'&&c.schedule==='near-peak'&&c.variant==='reference').config
const cases=[]
for(const field of ['uniform','peak','blank'])for(const period of field==='blank'?[0]:[0,32,40,64])for(const phase of period?[0,Math.PI/2,Math.PI,3*Math.PI/2]:[0])for(const seed of [85001,85002])for(const arm of ['single','same-repeat','reverse-repeat'])cases.push({field,period,phase,seed,arm})
await mkdir(root,{recursive:true})
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),inventory:any[]=[],sources:any[]=[]
async function retain(file:string,data:unknown,gzip=false){const b=Buffer.from(JSON.stringify(data)+'\n'),out=gzip?gzipSync(b):b;await writeFile(`${root}/${file}`,out,{flag:'wx'});inventory.push({file,sha256:sha(out)})}
async function snapshot(file:string){const b=await readFile(file);await mkdir(dirname(`${root}/source-snapshot/${file}`),{recursive:true});await writeFile(`${root}/source-snapshot/${file}`,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const p=`${dir}/${e.name}`;if(e.isDirectory())await walk(p);else if(p.endsWith('.ts'))await snapshot(p)}}
await walk('src/sim');await snapshot('scripts/m85-temporal-order.ts')
await retain('manifest.json',{cases,base,sources,protocol:{duration:600,firstStart:0,repeatStart:240,candidate:{x:.5,y:.5},orders:{first:[0,1,2,3],same:[0,1,2,3],reverse:[3,2,1,0]},amplitude:.08,field:'uniform:1; peak:0.01+exp(-r²/(2*0.6²)); multiply by 1+0.08*sin(2*pi*t/period+phase) when period>0; blank:0',acceptance:'single:first circuit; repeats:both independently supported at same prescribed candidate',scope:'Seeded verification-only, not acquisition. Equal 600 s horizon; repeat arms have equal sampling budget. No transport or soil physics in these synthetic identifiability controls.'}})
const summaries=[]
for(const [index,spec] of cases.entries()){
 const config=structuredClone(base);config.seed=spec.seed;config.durationSeconds=600;config.checkpointSeconds=[600];config.robotStartPositionOverride={x:.5,y:.5}
 const engine=new SimulationEngine(config),probes:LocalMaximumProbe[]=[],trace:any[]=[]
 engine.plume.concentrationAt=(p,t)=>{if(spec.field==='blank')return 0;const r=Math.hypot(p.x-.5,p.y-.5)*config.domainMeters;const c=spec.field==='uniform'?1:.01+Math.exp(-r*r/(2*.6**2));return c*(spec.period?1+.08*Math.sin(2*Math.PI*t/spec.period+spec.phase):1)}
 const start=(time:number,order:number[])=>{const probe=new LocalMaximumProbe(engine.environment,order);probes.push(probe);Object.assign(engine.controller,{localMaximum:probe});probe.start({time,dt:.25,position:engine.getFrame().robot.position,heading:0,distance:0,observations:[],measurement:{time,concentration:0,valid:false,hit:false,sampleMode:'passive',wind:{x:0,y:0}}},{x:.5,y:.5})}
 start(0,[0,1,2,3])
 // Bypass acquisition after rejected probes: a controlled verification fixture
 // holds position until the prescribed repeat, instead of confounding search.
 engine.controller.step=input=>{const decision=probes.at(-1)!.step(input)??{direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase:'VERIFICATION FIXTURE HOLD'};trace.push({time:input.time,position:input.position,measurement:input.measurement,decision});return decision}
 while(!engine.isCompleted()){if(trace.length===960&&spec.arm!=='single')start(240,spec.arm==='reverse-repeat'?[3,2,1,0]:[0,1,2,3]);engine.step()}
 const results=probes.map(p=>p.snapshot().results[0]);if(results.some(r=>!r))throw Error('Incomplete circuit')
 const summary={...spec,index,results,supported:results.every(r=>r.status==='supported'),path:engine.getFrame().metrics.pathLengthMeters,probeSeconds:results.reduce((s,r)=>s+r.completedAt-r.startedAt,0)}
 summaries.push(summary);await retain(`run-${index}.json.gz`,{config,summary,trace},true)
 if(index%18===17)process.stdout.write(`${index+1}/${cases.length}\n`)
}
await retain('summary.json',{summaries});await writeFile(`${root}/complete.json`,JSON.stringify({complete:true,runs:cases.length,inventory})+'\n',{flag:'wx'})
