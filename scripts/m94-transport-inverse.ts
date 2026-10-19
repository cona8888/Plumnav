import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises'
import {dirname} from 'node:path'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {HalfspaceTransport} from './lib/halfspace-transport'
import {SimulationEngine} from '../src/sim/engine'
import {LocalMaximumProbe} from '../src/sim/algorithms/localMaximumProbe'
import {fitPeriodic,selectPeriod,type VisibleInverseData} from './lib/periodic-inverse'
const root='research/evidence/m94_transport_inverse_2026-09-14',sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const parent=JSON.parse(await readFile('research/evidence/m87_model_selection_2026-09-13/manifest.json','utf8')),base=parent.base,p=base.localInletSampling,delay=Math.PI*(p.tubeInnerDiameterMetres/2)**2*p.tubeLengthMetres/(p.flowLitresPerMinutePerChannel*1e-3/60),response={delay,rise:p.riseTimeConstantSeconds,recovery:p.recoveryTimeConstantSeconds,average:p.averagingSeconds}
const transportRoot='research/evidence/m84_local_maximum_components_2026-09-13',tm=JSON.parse(await readFile(`${transportRoot}/manifest.json`,'utf8')),ts=JSON.parse(await readFile(`${transportRoot}/summary.json`,'utf8')).runs,cases=[]
for(const [parentIndex,c] of tm.cases.entries()){const r=ts[parentIndex];if(c.variant==='combined'&&(c.family==='transport'&&(r.attempts.length||c.blank)||c.family==='static'&&c.schedule==='near-peak'))cases.push({...c,parentIndex,candidate:r.attempts[0]?.candidate??c.config.robotStartPositionOverride,fieldStart:r.attempts[0]?.startedAt??0})}
const transportHash=sha(await readFile('scripts/lib/halfspace-transport.ts'));if(transportHash!==tm.sourceInventory.find((r:any)=>r.file==='scripts/lib/halfspace-transport.ts').sha256)throw Error('Transport changed')
await mkdir(root,{recursive:true});const sources=[],inventory:any[]=[]
async function snapshot(file:string){const b=await readFile(file);await mkdir(dirname(`${root}/source-snapshot/${file}`),{recursive:true});await writeFile(`${root}/source-snapshot/${file}`,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const f=`${dir}/${e.name}`;if(e.isDirectory())await walk(f);else if(f.endsWith('.ts'))await snapshot(f)}}
await walk('src/sim');for(const f of ['scripts/m94-transport-inverse.ts','scripts/lib/periodic-inverse.ts','scripts/lib/channel-reference.ts','scripts/lib/halfspace-transport.ts'])await snapshot(f)
async function retain(file:string,data:unknown,gzip=false){const b=Buffer.from(JSON.stringify(data)+'\n'),out=gzip?gzipSync(b):b;await writeFile(`${root}/${file}`,out,{flag:'wx'});inventory.push({file,sha256:sha(out)})}
await retain('manifest.json',{cases,base,response,sources,transportRoot,parentManifestSha256:sha(await readFile(`${transportRoot}/manifest.json`)),warmup:tm.warmupSeconds,concentrationScale:tm.concentrationScaleKgPerM3,protocol:{duration:600,repeatStart:240,scope:'Seeded verification at first measured M84 nominated poses; two blanks at original start; two static positive controls. New clean instrument starts at recorded nomination field time, not continuation of original sensor state. Non-nominated emitting cases remain untested; no discovery or leak-source success claim.',estimator:'Frozen M91 inputs/scorers; no transport parameters passed to fitting.'}})
const rows=[],started=Date.now();let maxRssBytes=0
for(const [index,spec] of cases.entries()){
 const config=structuredClone(spec.config);config.durationSeconds=600;config.checkpointSeconds=[600];config.robotStartPositionOverride=spec.candidate;const p=config.localInletSampling
 const engine=new SimulationEngine(config),trace:any[]=[],probes:LocalMaximumProbe[]=[]
 if(spec.family==='transport'){const field=new HalfspaceTransport(spec.settings),L=config.domainMeters;engine.plume.windAt=()=>({x:spec.settings.wind.x/L,y:spec.settings.wind.y/L});engine.plume.transportAt=engine.plume.windAt;engine.plume.concentrationAt=(p,t)=>field.evaluate({x:p.x*L,y:p.y*L,z:config.localInletSampling.inletHeightMetres},tm.warmupSeconds+spec.fieldStart+t).concentration/tm.concentrationScaleKgPerM3}else engine.plume.concentrationAt=p=>.01+Math.exp(-((Math.hypot(p.x-.5,p.y-.5)*config.domainMeters)**2)/(2*.6**2))
 const start=(time:number)=>{const probe=new LocalMaximumProbe(engine.environment);probes.push(probe);probe.start({time,dt:.25,position:engine.getFrame().robot.position,heading:0,distance:0,observations:[],measurement:{time,concentration:0,valid:false,hit:false,sampleMode:'passive',wind:{x:0,y:0}}},spec.candidate)}
 start(0);engine.controller.step=input=>{const decision=probes.at(-1)!.step(input)??{direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase:'VERIFICATION FIXTURE HOLD'};trace.push({time:input.time,position:input.position,measurement:input.measurement,decision});return decision}
 while(!engine.isCompleted()){if(trace.length===960)start(240);engine.step()}
 const results=probes.map(p=>p.snapshot().results[0]);if(results.some(r=>!r)||results[0].completedAt>=240)throw Error('Incomplete/overlapping rounds')
 const data:VisibleInverseData={poses:trace.map(t=>({time:t.time,x:(t.position.x-spec.candidate.x)/p.inspection.offsetNormalized,y:(t.position.y-spec.candidate.y)/p.inspection.offsetNormalized})),samples:[]}
 for(const [round,result] of results.entries())for(const [visit,v] of result.visits.entries())for(const s of v.samples){const k=Math.round(s.time/.25);data.samples.push({index:k,value:trace[k].measurement.concentration,hit:trace[k].measurement.hit,train:(round?[0,3,4,7,8]:[0,1,4,5,8]).includes(visit)})}
 data.poses=data.poses.slice(0,Math.max(...data.samples.map(s=>s.index))+1);const selection=selectPeriod(data,config.sensorNoise),fits=[]
 for(const scale of [null,.8,1,1.2]){const settings=scale===null?null:{...response,rise:response.rise*scale,recovery:response.recovery*scale};fits.push({scale,response:settings,period:selection.period,...fitPeriodic(data,settings,config.sensorNoise,selection.period)})}
 const plausible=fits.filter(f=>f.scale!==null&&f.trainingPlausible),summary={parentIndex:spec.parentIndex,family:spec.family,schedule:spec.schedule,wind:spec.wind,seed:spec.seed,candidate:spec.candidate,fieldStart:spec.fieldStart,index,original:results.every(r=>r.status==='supported'),selection,instantaneous:fits[0]!.supported,fixed:fits.find(f=>f.scale===1)!.supported,uncertainty:plausible.length>0&&plausible.every(f=>f.supported),plausible:plausible.map(f=>f.scale)}
 await retain(`run-${index}.json.gz`,{summary,config,results,trace,data,fits},true);rows.push(summary);maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss);if(true)process.stdout.write(`${index+1}/${cases.length}\n`)
}
await retain('summary.json',{rows});await retain('runtime.json',{elapsedSeconds:(Date.now()-started)/1000,maxRssBytes});await writeFile(`${root}/complete.json`,JSON.stringify({complete:true,cases:cases.length,inventory})+'\n',{flag:'wx'})
