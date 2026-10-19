import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {GSL_REFERENCE_DESIGN} from '../src/sim/physicalDesign'
import {SI_HALFSPACE_REFERENCE,withSIResearchDesign} from './lib/si-research-config'
import {SIPoseUncertaintyProbe,type SIPoseUncertaintySpec} from './lib/si-pose-uncertainty-probe'

const root=resolve(process.argv[2]??'research/evidence/si_pose_uncertainty_pilot_2026-09-15'),protocol='research/protocols/si_pose_uncertainty_pilot_2026-09-15.md'
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),legacy=JSON.parse(await readFile('research/evidence/m87_model_selection_2026-09-13/manifest.json','utf8')).base
const fields=['offset-peak','saddle','si-continuous','si-pulse'],seeds=[6101,6102]
type Case={field:string;kind:'baseline'|'position'|'heading';uncertainty:SIPoseUncertaintySpec}
const cases:Case[]=[...fields.map(field=>({field,kind:'baseline' as const,uncertainty:{positionRadiusMetres:0,headingBoundRadians:0,registration:'observed' as const,perturbationSeed:6101}})),...fields.flatMap(field=>[.015,.03,.05].flatMap(positionRadiusMetres=>['observed','commanded'].flatMap(registration=>seeds.map(perturbationSeed=>({field,kind:'position' as const,uncertainty:{positionRadiusMetres,headingBoundRadians:0,registration:registration as 'observed'|'commanded',perturbationSeed}}))))),...fields.flatMap(field=>[10,20].flatMap(degrees=>seeds.map(perturbationSeed=>({field,kind:'heading' as const,uncertainty:{positionRadiusMetres:0,headingBoundRadians:degrees*Math.PI/180,registration:'observed' as const,perturbationSeed}}))))]
const configurations=cases.map(spec=>{const atmosphere=structuredClone(SI_HALFSPACE_REFERENCE);atmosphere.measurement.noiseKgPerCubicMetre=0;if(spec.field==='si-pulse'){atmosphere.pulse={periodSeconds:20,phaseSeconds:0,dutyFraction:.5};atmosphere.emissionRateKgPerSecond=4e-9}const config=withSIResearchDesign({...legacy,seed:98001,fixedDt:.0625,durationSeconds:330,checkpointSeconds:[330],windDirectionDegrees:90,windNoise:0,sourcePositionOverride:{x:.5,y:.5},robotStartPositionOverride:{x:spec.field.startsWith('si-')?.501:.5,y:.5},robotStartHeadingDegrees:0,stopOnNativeDeclaration:false},{...GSL_REFERENCE_DESIGN,referenceWindMetresPerSecond:.02},atmosphere);return {spec,config}})
await mkdir(root);const inventory:any[]=[],sources:any[]=[]
async function retain(file:string,data:unknown,zip=false){const raw=Buffer.from(JSON.stringify(data)+'\n'),b=zip?gzipSync(raw):raw;await writeFile(resolve(root,file),b,{flag:'wx'});inventory.push({file,sha256:sha(b)})}
async function snapshot(file:string){const b=await readFile(file),dest=resolve(root,'source-snapshot',file);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const f=`${dir}/${e.name}`;if(e.isDirectory())await walk(f);else if(f.endsWith('.ts'))await snapshot(f)}}
await walk('src/sim');for(const f of ['scripts/si-pose-uncertainty-pilot.ts','scripts/lib/si-pose-uncertainty-probe.ts','scripts/lib/si-clocked-integrity-probe.ts','scripts/lib/si-research-config.ts',protocol])await snapshot(f)
await retain('manifest.json',{version:'si-pose-uncertainty-pilot-v1',protocol,configurations,sources,caseCount:cases.length,acceptedDt:.0625,sourceWidthConventionMetres:.15,inspectionOffsetMetres:.1,verifierNoiseAllowanceC0:.001,scope:'Scenario-parameter pilot; not empirical robot-error calibration or autonomous GSL.'})
const rows:any[]=[],started=Date.now();let maxRssBytes=0
for(const [index,{spec,config}] of configurations.entries()){
 const engine=new SimulationEngine(config),candidate=config.robotStartPositionOverride!,probe=new SIPoseUncertaintyProbe({...engine.environment,sensorNoise:.001},candidate,config.domainMeters,spec.uncertainty),trace:any[]=[]
 if(!spec.field.startsWith('si-'))engine.plume.concentrationAt=p=>{const x=(p.x-.5)*config.domainMeters,y=(p.y-.5)*config.domainMeters,r=Math.hypot(x,y);return spec.field==='offset-peak'?.01+Math.exp(-((x-.03)**2+(y+.02)**2)/(2*.3**2)):Math.max(0,1-(x*x+y*y)/(2*.3**2)+2*x*y/.3**2)}
 engine.controller.step=input=>{const decision=probe.step(input);trace.push({time:input.time,position:{...input.position},heading:input.heading,measurement:structuredClone(input.measurement),decision});return decision}
 while(!engine.isCompleted())engine.step()
 const result=probe.result??{status:'incomplete',reason:'incomplete-circuit',medians:null,coefficients:null,rmse:null,eigenMax:null,peak:null},end=probe.completedAt??config.durationSeconds
 let path=0;for(let i=1;i<trace.length&&trace[i].time<=end;i++)path+=Math.hypot(trace[i].position.x-trace[i-1].position.x,trace[i].position.y-trace[i-1].position.y)*config.domainMeters
 const actualPositionErrors=probe.visits.flatMap((v,i)=>v.samples.map(s=>{const position=trace[Math.round(s.time/config.fixedDt)]!.position;return Math.hypot(position.x-probe.nominalTargets[i]!.x,position.y-probe.nominalTargets[i]!.y)*config.domainMeters}))
 const realizedTargetErrors=probe.positionOffsetsMetres.map(v=>Math.hypot(v.x,v.y)),headingErrors=probe.headingOffsetsRadians.map(Math.abs)
 const row={index,field:spec.field,kind:spec.kind,...spec.uncertainty,status:result.status,reason:result.reason,completedAt:end,pathMetres:path,retainedSamples:probe.visits.reduce((a,v)=>a+v.samples.length,0),clippedRetained:probe.visits.reduce((a,v)=>a+v.samples.filter(s=>s.clipped).length,0),coefficients:result.coefficients,peak:result.peak,maximumTargetOffsetMetres:Math.max(...realizedTargetErrors),rmsTargetOffsetMetres:Math.sqrt(realizedTargetErrors.reduce((a,v)=>a+v*v,0)/realizedTargetErrors.length),maximumRecordedPositionErrorMetres:Math.max(...actualPositionErrors),maximumHeadingOffsetRadians:Math.max(...headingErrors)}
 await retain(`run-${index}.json.gz`,{spec,config,nominalTargets:probe.nominalTargets,actualTargets:probe.actualTargets,desiredHeadings:probe.desiredHeadings,positionOffsetsMetres:probe.positionOffsetsMetres,headingOffsetsRadians:probe.headingOffsetsRadians,visits:probe.visits,result,trace,row},true);rows.push(row);maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss);if(index%4===3)process.stdout.write(`${index+1}/${cases.length}\n`)
}
await retain('summary.json',{rows,elapsedSeconds:(Date.now()-started)/1000,maxRssBytes});await writeFile(resolve(root,'complete.json'),JSON.stringify({complete:true,cases:rows.length,inventory})+'\n',{flag:'wx'})
