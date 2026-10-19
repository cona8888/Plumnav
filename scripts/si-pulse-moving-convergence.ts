import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {GSL_REFERENCE_DESIGN} from '../src/sim/physicalDesign'
import {SI_HALFSPACE_REFERENCE,withSIResearchDesign} from './lib/si-research-config'
import {SIPrecisionIntegrityProbe} from './lib/si-precision-integrity-probe'

const root=resolve(process.argv[2]??'research/evidence/si_pulse_moving_convergence_2026-09-15')
const protocol='research/protocols/si_pulse_moving_convergence_2026-09-15.md',sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const legacy=JSON.parse(await readFile('research/evidence/m87_model_selection_2026-09-13/manifest.json','utf8')).base
const cases=['nominal','zero'].flatMap(noiseMode=>[.0625,.03125,.015625].map(dt=>({field:'si-pulse',noiseMode,seed:98001,dt})))
const configurations=cases.map(spec=>{const atmosphere=structuredClone(SI_HALFSPACE_REFERENCE);atmosphere.pulse={periodSeconds:20,phaseSeconds:0,dutyFraction:.5};atmosphere.emissionRateKgPerSecond=4e-9;if(spec.noiseMode==='zero')atmosphere.measurement.noiseKgPerCubicMetre=0;const config=withSIResearchDesign({...legacy,seed:spec.seed,fixedDt:spec.dt,durationSeconds:600,checkpointSeconds:[600],windDirectionDegrees:90,windNoise:0,sourcePositionOverride:{x:.5,y:.5},robotStartPositionOverride:{x:.501,y:.5},stopOnNativeDeclaration:false},{...GSL_REFERENCE_DESIGN,referenceWindMetresPerSecond:.02},atmosphere);return {spec,config}})
await mkdir(root);const inventory:any[]=[],sources:any[]=[]
async function retain(file:string,data:unknown,zip=false){const raw=Buffer.from(JSON.stringify(data)+'\n'),b=zip?gzipSync(raw):raw;await writeFile(resolve(root,file),b,{flag:'wx'});inventory.push({file,sha256:sha(b)})}
async function snapshot(file:string){const b=await readFile(file),dest=resolve(root,'source-snapshot',file);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const f=`${dir}/${e.name}`;if(e.isDirectory())await walk(f);else if(f.endsWith('.ts'))await snapshot(f)}}
await walk('src/sim');for(const f of ['scripts/si-pulse-moving-convergence.ts','scripts/lib/si-precision-integrity-probe.ts','scripts/lib/si-clocked-integrity-probe.ts','scripts/lib/si-research-config.ts',protocol])await snapshot(f)
await retain('manifest.json',{version:'si-pulse-moving-convergence-v1',protocol,configurations,sources,referenceDt:.015625,effectiveArrivalRadiusMetres:.001,tolerances:{circuitSeconds:2,arrivalSeconds:2,closureSeconds:2,perVisitCount:1,medianC0:.003,coefficient:.006,decisionIdentical:true},scope:'Moving fine-step confirmation for the current 20 s pulse; prescribed verification only.'})
const rows:any[]=[],started=Date.now();let maxRssBytes=0
for(const [index,{spec,config}] of configurations.entries()){
 const engine=new SimulationEngine(config),candidate=config.robotStartPositionOverride!,probe=new SIPrecisionIntegrityProbe({...engine.environment,sensorNoise:.001},candidate,config.domainMeters),trace:any[]=[]
 engine.controller.step=input=>{const decision=probe.step(input);trace.push({time:input.time,position:{...input.position},heading:input.heading,measurement:structuredClone(input.measurement),decision});return decision}
 while(!engine.isCompleted())engine.step()
 const result=probe.result??{status:'incomplete',reason:'incomplete-circuit',medians:null,coefficients:null,rmse:null,eigenMax:null,peak:null},end=probe.completedAt??config.durationSeconds
 let path=0;for(let i=1;i<trace.length&&trace[i].time<=end;i++)path+=Math.hypot(trace[i].position.x-trace[i-1].position.x,trace[i].position.y-trace[i-1].position.y)*config.domainMeters
 const row={index,...spec,effectiveArrivalRadiusMetres:.001,status:result.status,reason:result.reason,completedAt:end,pathMetres:path,retainedSamples:probe.visits.reduce((a,v)=>a+v.samples.length,0),coefficients:result.coefficients,medians:result.medians}
 await retain(`run-${index}.json.gz`,{spec,config,trace,visits:probe.visits,result,row},true);rows.push(row);maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss);process.stdout.write(`${index+1}/${cases.length}\n`)
}
await retain('summary.json',{rows,elapsedSeconds:(Date.now()-started)/1000,maxRssBytes});await writeFile(resolve(root,'complete.json'),JSON.stringify({complete:true,cases:rows.length,inventory})+'\n',{flag:'wx'})
