import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {GSL_REFERENCE_DESIGN} from '../src/sim/physicalDesign'
import {SI_HALFSPACE_REFERENCE,withSIResearchDesign} from './lib/si-research-config'
import {SIClockedIntegrityProbe} from './lib/si-clocked-integrity-probe'
import {siScaleAnalysis} from './lib/si-scale-analysis'
const root=resolve(process.argv[2]??'research/evidence/si_clocked_arrival_2026-09-14'),sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const legacy=JSON.parse(await readFile('research/evidence/m87_model_selection_2026-09-13/manifest.json','utf8')).base
const fields=['peak','offset-peak','ridge','saddle','plateau','uniform','blank','clipped-peak','si-continuous','si-narrow','si-pulse']
const cases=fields.flatMap(field=>['nominal','zero'].flatMap(noiseMode=>[.25,.125,.0625].map(dt=>({field,noiseMode,seed:98001,dt}))))
const configurations=cases.map(spec=>{const a=structuredClone(SI_HALFSPACE_REFERENCE);if(spec.noiseMode==='zero')a.measurement.noiseKgPerCubicMetre=0;if(spec.field==='si-narrow')a.sourceWidthMetres=.075;if(spec.field==='si-pulse'){a.pulse={periodSeconds:20,phaseSeconds:0,dutyFraction:.5};a.emissionRateKgPerSecond=4e-9}const config=withSIResearchDesign({...legacy,seed:spec.seed,fixedDt:spec.dt,durationSeconds:600,checkpointSeconds:[600],windDirectionDegrees:90,windNoise:0,sourcePositionOverride:{x:.5,y:.5},robotStartPositionOverride:{x:spec.field.startsWith('si-')?.501:.5,y:.5},stopOnNativeDeclaration:false},{...GSL_REFERENCE_DESIGN,referenceWindMetresPerSecond:.02},a);return {spec,config}})
await mkdir(root)
const inventory:any[]=[],sources=[]
async function retain(file:string,data:unknown,zip=false){const raw=Buffer.from(JSON.stringify(data)+'\n'),b=zip?gzipSync(raw):raw;await writeFile(resolve(root,file),b,{flag:'wx'});inventory.push({file,sha256:sha(b)})}
async function snapshot(file:string){const b=await readFile(file),dest=resolve(root,'source-snapshot',file);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const f=`${dir}/${e.name}`;if(e.isDirectory())await walk(f);else if(f.endsWith('.ts'))await snapshot(f)}}
await walk('src/sim');for(const f of ['scripts/si-clocked-arrival-study.ts','scripts/lib/si-clocked-integrity-probe.ts','scripts/lib/si-research-config.ts','scripts/lib/si-scale-analysis.ts','research/protocols/si_clocked_arrival_2026-09-14.md'])await snapshot(f)
await retain('manifest.json',{version:'si-clocked-arrival',configurations,sources,node:process.version,protocol:'research/protocols/si_integrity_round1_2026-09-14.md',tolerances:{circuitSeconds:2,arrivalSeconds:2,closureSeconds:2,perVisitCount:1,medianC0:.003,coefficient:.006,decisionIdentical:true},scope:'Stage 1c hardware-clock-aligned arrival intervention, crossed with nominal and zero readout noise. Same frozen numerical tolerances. Seeded verification only.'})
const rows=[],started=Date.now();let maxRssBytes=0
for(const [index,{spec,config}] of configurations.entries()){
 const engine=new SimulationEngine(config),candidate=config.robotStartPositionOverride!,probe=new SIClockedIntegrityProbe({...engine.environment,sensorNoise:.001},candidate),trace:any[]=[]
 if(!spec.field.startsWith('si-'))engine.plume.concentrationAt=(p)=>{const x=(p.x-.5)*config.domainMeters,y=(p.y-.5)*config.domainMeters,r=Math.hypot(x,y);switch(spec.field){case 'peak':return .01+Math.exp(-r*r/(2*.3**2));case 'offset-peak':return .01+Math.exp(-((x-.03)**2+(y+.02)**2)/(2*.3**2));case 'ridge':return .01+Math.exp(-x*x/(2*.3**2));case 'saddle':return Math.max(0,1-(x*x+y*y)/(2*.3**2)+2*x*y/.3**2);case 'plateau':return r<=.3?1:.01+.99*Math.exp(-((r-.3)**2)/(2*.3**2));case 'uniform':return 1;case 'clipped-peak':return 3*Math.exp(-r*r/(2*.3**2));default:return 0}}
 engine.controller.step=input=>{const decision=probe.step(input);trace.push({time:input.time,position:{...input.position},heading:input.heading,measurement:structuredClone(input.measurement),decision});return decision}
 while(!engine.isCompleted())engine.step()
 if(!probe.result||probe.completedAt===null)throw Error(`Incomplete ${spec.field}`)
 const metrics=engine.getFrame().metrics;if(metrics.nativeDeclaration||metrics.nativeAbstention)throw Error('Native claim')
 let path=0,movingTime=0,maxSpeed=0
 for(let i=1;i<trace.length&&trace[i].time<=probe.completedAt;i++){const d=Math.hypot(trace[i].position.x-trace[i-1].position.x,trace[i].position.y-trace[i-1].position.y)*config.domainMeters;path+=d;if(d>1e-12){movingTime+=spec.dt;maxSpeed=Math.max(maxSpeed,d/spec.dt)}}
 const ell=spec.field.startsWith('si-')?config.physicalAtmosphere!.sourceWidthMetres:.3,scales=siScaleAnalysis(config,ell,spec.field==='si-pulse'?20:undefined),q=scales.quantities
 const row={index,...spec,scoringNoiseC0:.001,status:probe.result.status,reason:probe.result.reason,completedAt:probe.completedAt,retainedSamples:probe.visits.reduce((a,v)=>a+v.samples.length,0),clippedRetained:probe.visits.reduce((a,v)=>a+v.samples.filter(s=>s.clipped).length,0),coefficients:probe.result.coefficients,rmse:probe.result.rmse,eigenMax:probe.result.eigenMax,peak:probe.result.peak,scales,actual:{pathMetres:path,movingSeconds:movingTime,meanMovingSpeed:movingTime?path/movingTime:0,maxStepSpeed:maxSpeed,circuitAverageSpeed:path/probe.completedAt,motionMemoryRise:movingTime?path/movingTime*q.riseMemorySeconds/ell:0,motionMemoryRecovery:movingTime?path/movingTime*q.recoveryMemorySeconds/ell:0,circuitToVariation:spec.field==='si-pulse'?probe.completedAt/20:null},lengthConvention:spec.field.startsWith('si-')?'prescribed release width, not local feature width':'prescribed synthetic fixture width, not inferred from observations'}
 await retain(`run-${index}.json.gz`,{spec,config,trace,visits:probe.visits,result:probe.result,row},true);rows.push(row);maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss);if(index%4===3)process.stdout.write(`${index+1}/${cases.length}\n`)
}
await retain('summary.json',{rows,elapsedSeconds:(Date.now()-started)/1000,maxRssBytes});await writeFile(resolve(root,'complete.json'),JSON.stringify({complete:true,cases:rows.length,inventory})+'\n',{flag:'wx'})
