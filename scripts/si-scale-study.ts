/** Development-only dimensional study: prescribed inspections, not discovery.
 * Writes a fresh source/manifest snapshot before any simulation; never overwrites.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { SimulationEngine } from '../src/sim/engine'
import { LocalMaximumProbe } from '../src/sim/algorithms/localMaximumProbe'
import { quadSniffChannelDirections } from '../src/sim/quadSniff'
import { GSL_REFERENCE_DESIGN } from '../src/sim/physicalDesign'
import { SI_HALFSPACE_REFERENCE, withSIResearchDesign } from './lib/si-research-config'
import { siScaleAnalysis } from './lib/si-scale-analysis'
import type { SimulationConfig } from '../src/sim/types'

const root = resolve(process.argv[2] ?? 'research/evidence/si_scale_study_2026-09-14_v2')
const legacy = JSON.parse(await readFile('research/evidence/m87_model_selection_2026-09-13/manifest.json','utf8')).base as SimulationConfig
const reference = { id:'reference',width:.15,speed:.1,dwell:12,wind:.02,period:0,phase:0,domain:100,dt:.25,blank:false }
const variants=[reference,
 ...[.075,.6].map(width=>({...reference,id:`width-${width}`,width})),
 ...[.01,.03].map(speed=>({...reference,id:`speed-${speed}`,speed})),
 {...reference,id:'dwell-24',dwell:24}, {...reference,id:'wind-0.1',wind:.1},
 ...[20,40].flatMap(period=>[0,5].map(phase=>({...reference,id:`pulse-${period}-${phase}`,period,phase}))),
 {...reference,id:'blank',blank:true}]
const cases=variants.flatMap(variant=>[97001,97002].map(seed=>({...variant,seed})))
for(const dt of [.125,.0625])for(const period of [0,20])cases.push({...reference,id:`dt-${dt}-period-${period}`,dt,period,seed:97001})
for(const domain of [10,1000])cases.push({...reference,id:`domain-${domain}`,domain,seed:97001})
const build=(spec:typeof cases[number])=>{
 const atmosphere=structuredClone(SI_HALFSPACE_REFERENCE)
 atmosphere.sourceWidthMetres=spec.width
 atmosphere.emissionRateKgPerSecond=spec.blank?0:spec.period?4e-9:2e-9 // Equal time-mean dose.
 if(spec.period)atmosphere.pulse={periodSeconds:spec.period,phaseSeconds:spec.phase,dutyFraction:.5}
 const config=withSIResearchDesign({...legacy,seed:spec.seed,fixedDt:spec.dt,durationSeconds:600,checkpointSeconds:[600],
   windDirectionDegrees:90,windNoise:0,sourcePositionOverride:{x:.5,y:.5},
   robotStartPositionOverride:{x:.5+.1/spec.domain,y:.5},stopOnNativeDeclaration:false},
   {...GSL_REFERENCE_DESIGN,domainMetres:spec.domain,referenceWindMetresPerSecond:spec.wind,
     robotSpeedMetresPerSecond:spec.speed,dwellSeconds:spec.dwell},atmosphere)
 // Keep the existing research inspection policy, using newly mapped SI geometry/timing.
 for(const key of ['gradientEstimator','candidateLifecycle','acquisitionPolicy','bearingGeometry','rayWindowPolicy',
   'localGradientPolicy','localMaximumPolicy'] as const) {
   Object.assign(config.localInletSampling!,{[key]:legacy.localInletSampling![key]})
 }
 return config
}
const configurations=cases.map(spec=>({spec,config:build(spec)}))
await mkdir(root) // Refuses an existing generation, including incomplete runs.
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),inventory:Array<{file:string;sha256:string}>=[]
const retain=async(file:string,data:unknown,gzip=false)=>{const b=Buffer.from(JSON.stringify(data)+'\n'),out=gzip?gzipSync(b):b;
 await writeFile(resolve(root,file),out,{flag:'wx'});inventory.push({file,sha256:sha(out)})}
const sourceFiles:string[]=[]
async function collect(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const f=`${dir}/${e.name}`;if(e.isDirectory())await collect(f);else if(f.endsWith('.ts'))sourceFiles.push(f)}}
await collect('src/sim');sourceFiles.push('scripts/si-scale-study.ts','scripts/lib/si-research-config.ts','scripts/lib/si-scale-analysis.ts')
const sources=[]
for(const file of sourceFiles){const b=await readFile(file),dest=resolve(root,'source-snapshot',file);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
await retain('manifest.json',{version:'si-scale-study-v2-channel-telemetry',configurations,sources,runtime:{node:process.version},
 protocol:{scope:'Prescribed nine-visit inspection; no autonomous source nomination or leak declaration. Descriptive component results only.',
   design:'One-factor variants paired on two new development seeds, plus deterministic timestep/domain checks. Pulses match continuous time-mean mass rate.',
   held:'Hardware, actual flow, rise/recovery, readout rate, threshold, noise and source age fixed. Dwell does not change calibration.',
   caveats:'Source width changes spatial shape and concentration amplitude at fixed mass rate; sigma is a prescribed feature proxy, not measured plume correlation length. Historical cross support is not a general maximum.',
   observables:'Full tick histories, actual inlet-mean truth for evaluator diagnostics only, measured mean, saturation, visitation and sample timing.',
   acceptance:'Finite fields, preserved units, no native source/absence declarations, and complete archived runs. No performance thresholds or parameter selection.'}})
const rows=[],started=Date.now()
for(const [index,{spec,config}] of configurations.entries()){
 const engine=new SimulationEngine(config),probe=new LocalMaximumProbe(engine.environment),trace:any[]=[]
 const candidate={...config.robotStartPositionOverride!}
 probe.start({time:0,dt:config.fixedDt,position:candidate,heading:0,distance:0,observations:[],
  measurement:{time:0,concentration:0,valid:false,hit:false,sampleMode:'passive',wind:{x:0,y:0}}},candidate)
 engine.controller.step=input=>{const decision=probe.step(input)??{direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase:'PRESCRIBED INSPECTION HOLD'}
  trace.push({time:input.time,position:{...input.position},heading:input.heading,measurement:structuredClone(input.measurement),decision});return decision}
 while(!engine.isCompleted())engine.step()
 const results=probe.snapshot().results
 if(results.length!==1)throw Error(`Missing inspection outcome ${spec.id}`)
 // Truth is queried after the complete trajectory, never supplied to the policy.
 const radius=config.localInletSampling!.opposingInletSpacingMetres/(2*config.domainMeters)
 const samples=trace.filter(r=>r.measurement.valid).map(r=>{
   const inletValues=quadSniffChannelDirections({x:Math.cos(r.heading),y:Math.sin(r.heading)}).map(g=>
     engine.plume.concentrationAt({x:r.position.x+radius*g.direction.x,y:r.position.y+radius*g.direction.y},r.time))
   const mean=inletValues.reduce((a,b)=>a+b,0)/4
   if(!Number.isFinite(mean)||mean<0)throw Error('Invalid SI truth')
   return {time:r.time,meanInlet:mean,measured:r.measurement.concentration,
     phase:r.decision.phase,error:r.measurement.concentration-mean,
     inletReadings:r.measurement.localInletReadings,
     saturated:r.measurement.localInletReadings.some((reading:{saturated:boolean})=>reading.saturated),
     meanSaturated:r.measurement.concentration>=config.sensorSaturation-1e-9}
 })
 const retainedTimes=new Set(results[0]!.visits.flatMap(v=>v.samples.map(s=>s.time)))
 const retained=samples.filter(s=>retainedTimes.has(s.time)),moving=samples.filter(s=>s.phase==='LOCAL HOTSPOT PROBE MOVE')
 const rmse=(values:typeof samples)=>values.length?Math.sqrt(values.reduce((a,r)=>a+r.error*r.error,0)/values.length):null
 const metrics=engine.getFrame().metrics
 if(metrics.nativeDeclaration||metrics.nativeAbstention)throw Error('Inspection must not issue native source/absence claims')
 const row={index,...spec,scales:siScaleAnalysis(config,spec.width,spec.period||undefined),status:results[0]!.status,reason:results[0]!.reason,
  completedAt:results[0]!.completedAt,retainedSamples:retained.length,movingSamples:moving.length,
  retainedInstantaneousMismatchRmse:rmse(retained),movingInstantaneousMismatchRmse:rmse(moving),
  saturatedValidReadouts:samples.filter(s=>s.saturated).length,measurementCount:samples.length,
  retainedReadoutsWithClippedInlet:retained.filter(s=>s.saturated).length,
  fullySaturatedMeanReadouts:samples.filter(s=>s.meanSaturated).length,
  inspectionSpeedCapMetresPerSecond:.46*spec.speed,
  pathMetres:metrics.pathLengthMeters,airLitres:metrics.localSamplingAirLitres,
  note:'RMSE against instantaneous local inlet mean measures temporal registration mismatch plus readout noise/clipping, not response-model integration error.'}
 await retain(`run-${index}.json.gz`,{spec,config,trace,results,samples,row},true);rows.push(row)
 if(index%8===7)process.stdout.write(`${index+1}/${configurations.length}\n`)
}
await retain('summary.json',{rows,elapsedSeconds:(Date.now()-started)/1000})
await writeFile(resolve(root,'complete.json'),JSON.stringify({complete:true,cases:rows.length,inventory})+'\n',{flag:'wx'})
console.log(`Completed ${rows.length} prescribed inspections`)
