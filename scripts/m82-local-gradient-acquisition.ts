/** Acquisition-only development comparison: proximity is NOT localisation. */
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {gzipSync,gunzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {QuadSoilSniffController} from '../src/sim/algorithms/quadSoilSniff'
import {HalfspaceTransport} from './lib/halfspace-transport'
import {recordResearchRun,summarizeResearchTrace} from './lib/research-recorder'
const parentRoot='research/evidence/m81_rolling_ray_window_2026-09-13'
const parent=JSON.parse(await readFile(`${parentRoot}/manifest.json`,'utf8'))
const root=resolve(process.argv[2]??'research/evidence/m82_local_gradient_acquisition_2026-09-13')
const cases=[]
for(const [parentIndex,spec] of parent.cases.entries()) {
  if(spec.variant!=='rolling')continue
  for(const variant of ['rolling-reference','local-gradient'] as const) {
    const config=structuredClone(spec.config)
    if(variant==='local-gradient')config.localInletSampling.localGradientPolicy='head-step-v1'
    cases.push({...spec,config,variant,parentIndex})
  }
}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const transport='scripts/lib/halfspace-transport.ts'
if(sha(await readFile(transport))!==parent.sourceInventory.find((r:{file:string})=>r.file===transport).sha256)throw new Error('Transport drift')
await mkdir(root,{recursive:true})
const inventory:Array<{file:string;sha256:string;bytes:number}>=[]
async function retain(file:string,value:unknown,compress=false) {
  const json=Buffer.from(JSON.stringify(value)+'\n'),bytes=compress?gzipSync(json):json
  await writeFile(resolve(root,file),bytes,{flag:'wx'});inventory.push({file,sha256:sha(bytes),bytes:bytes.length})
}
const files=['scripts/m82-local-gradient-acquisition.ts',transport,'scripts/lib/research-recorder.ts']
async function collect(dir:string) {
  for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const file=`${dir}/${e.name}`;if(e.isDirectory())await collect(file);else if(file.endsWith('.ts'))files.push(file)
  }
}
await collect('src/sim')
const sourceInventory=[]
for(const file of files) {
  const bytes=await readFile(file),dest=resolve(root,'source-snapshot',file)
  await mkdir(dirname(dest),{recursive:true});await writeFile(dest,bytes,{flag:'wx'});sourceInventory.push({file,sha256:sha(bytes)})
}
await retain('manifest.json',{schemaVersion:'m82-local-gradient-acquisition-v1',cases,sourceInventory,
  parentManifestSha256:sha(await readFile(`${parentRoot}/manifest.json`)),warmupSeconds:parent.warmupSeconds,
  concentrationScaleKgPerM3:parent.concentrationScaleKgPerM3,
  scope:'Acquisition-only. No source ray, estimate or candidate inspection in the gradient branch; no native declaration expected by design. Existing fallback search retained.',
  rules:'One measured 0.10 m head-spacing step per reliable four-channel return, speed <=0.9 max, new settled scan on arrival. Existing common-mean/quality/directional-validity requirements retained. No tuning after execution.',
  comparison:'Changes both the acquisition interpretation and its step length (0.10 m vs 0.22 m). Not a pure angular-direction ablation or a complete-algorithm success comparison.',
  evaluation:'Report closest/end/last-60-second median distance to known release centre and duration within 0.10 m. All emitting starts are already within the 1 m study threshold; proximity is not source localisation. Peak and buried-defect truth are not inferred.',
  runtime:{node:process.version,platform:process.platform,architecture:process.arch}})
const summaries=[],replays=[]
const median=(a:number[])=>{const b=[...a].sort((x,y)=>x-y);return b.length?b[Math.floor(b.length/2)]!:null}
for(const [index,spec] of cases.entries()) {
  const {config}=spec,L=config.domainMeters,engine=new SimulationEngine(config)
  if(spec.family==='transport') {
    const field=new HalfspaceTransport(spec.settings)
    engine.plume.windAt=()=>({x:spec.settings.wind.x/L,y:spec.settings.wind.y/L})
    engine.plume.transportAt=engine.plume.windAt
    engine.plume.concentrationAt=(p,t)=>field.evaluate({x:p.x*L,y:p.y*L,z:config.localInletSampling.inletHeightMetres},parent.warmupSeconds+t).concentration/parent.concentrationScaleKgPerM3
  } else engine.plume.concentrationAt=p=>spec.blank?0:0.01+Math.exp(-((Math.hypot(p.x-.5,p.y-.5)*L)**2)/(2*.6**2))
  const controller=engine.controller as QuadSoilSniffController,step=controller.step.bind(controller)
  const telemetry:Array<ReturnType<QuadSoilSniffController['getPhysicalDiagnostics']>>=[]
  controller.step=input=>{const decision=step(input);telemetry.push(controller.getPhysicalDiagnostics());return decision}
  const {trace,frame}=recordResearchRun(engine)
  if(telemetry.length!==trace.length)throw new Error('Telemetry clock mismatch')
  if(spec.variant==='rolling-reference') {
    const old=JSON.parse(gunzipSync(await readFile(`${parentRoot}/run-${spec.parentIndex}.json.gz`)).toString())
    if(JSON.stringify(trace)!==JSON.stringify(old.trace))throw new Error(`Original trace drift ${index}`)
    replays.push({index,parentIndex:spec.parentIndex,exact:true})
  } else if(trace.some(r=>r.decision.estimate!==null||r.decision.nativeTerminated)||
      telemetry.some(t=>t.rayTimes.length||t.rayEstimate||t.heldPrior))throw new Error('Gradient cue leaked into source inference')
  const distances=trace.map(r=>Math.hypot(r.inputPosition.x-.5,r.inputPosition.y-.5)*L)
  const endDistance=Math.hypot(frame.robot.position.x-.5,frame.robot.position.y-.5)*L
  const tail=trace.flatMap((r,i)=>r.inputTimeSeconds>=config.durationSeconds-60?[distances[i]!]:[])
  // Native-declaration controls end early; no frozen checkpoint padding is
  // treated as post-declaration robot behaviour in proximity statistics.
  const summary={index,parentIndex:spec.parentIndex,family:spec.family,variant:spec.variant,seed:spec.seed,
    schedule:spec.schedule,wind:spec.wind,start:spec.start,blank:spec.blank,...summarizeResearchTrace(trace),
    nativeDeclaration:frame.metrics.nativeDeclaration,nativeAbstention:frame.metrics.nativeAbstention,
    proximityInterpretation:spec.blank?'no-target; distances null':'oracle robot proximity only, not an inferred source location',
    initialDistanceMetres:spec.blank?null:distances[0],closestDistanceMetres:spec.blank?null:Math.min(...distances,endDistance),
    endDistanceMetres:spec.blank?null:endDistance,tailMedianDistanceMetres:spec.blank?null:median(tail),
    secondsWithinPointOneMetre:spec.blank?null:distances.filter(d=>d<=.1).length*config.fixedDt,
    pathLengthMetres:frame.metrics.pathLengthMeters,
    gradientMoveSeconds:trace.filter(r=>r.decision.phase==='LOCAL GRADIENT HEAD STEP').length*config.fixedDt,
    validScalarMedian:median(trace.filter(r=>r.measurement.valid).map(r=>r.measurement.concentration)),
    privateFieldAtStartAtMissionEnd:spec.blank?null:engine.plume.concentrationAt(config.robotStartPositionOverride,config.durationSeconds),
    privateFieldAtEndAtMissionEnd:spec.blank?null:engine.plume.concentrationAt(frame.robot.position,config.durationSeconds)}
  summaries.push(summary);await retain(`run-${index}.json.gz`,{...spec,summary,trace,telemetry},true)
  process.stdout.write(`${index+1}/${cases.length} ${spec.variant} ${spec.schedule}: end-distance=${summary.endDistanceMetres?.toFixed(3)??'N/A'}m\n`)
}
await retain('summary.json',{runs:summaries});await retain('compatibility.json',{replays})
await writeFile(resolve(root,'complete.json'),JSON.stringify({complete:true,cases:cases.length,exactReplays:replays.length,inventory},null,2)+'\n',{flag:'wx'})
