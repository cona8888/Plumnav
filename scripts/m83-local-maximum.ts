/** Frozen paired local-contrast verification, with no source declaration. */
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {gzipSync,gunzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {QuadSoilSniffController} from '../src/sim/algorithms/quadSoilSniff'
import {HalfspaceTransport} from './lib/halfspace-transport'
import {recordResearchRun,summarizeResearchTrace} from './lib/research-recorder'
const parentRoot='research/evidence/m82_local_gradient_acquisition_2026-09-13',parent=JSON.parse(await readFile(`${parentRoot}/manifest.json`,'utf8'))
const root=resolve(process.argv[2]??'research/evidence/m83_local_maximum_v2_2026-09-13'),cases=[]
for(const [parentIndex,spec] of parent.cases.entries()) {
  if(spec.variant!=='local-gradient')continue
  for(const variant of ['gradient-reference','fresh-cross']) {
    const config=structuredClone(spec.config)
    if(variant==='fresh-cross')config.localInletSampling.localMaximumPolicy='fresh-cross-v1'
    cases.push({...spec,config,parentIndex,variant,extra:false})
  }
}
const base=cases.find(r=>r.family==='static'&&!r.blank&&r.variant==='fresh-cross')!
for(const field of ['uniform','plateau','ridge','intermittent'])for(const seed of [83001,83002]) {
  const spec=structuredClone(base);spec.config.seed=seed;spec.seed=seed;spec.schedule=field;spec.extra=true;spec.parentIndex=-1
  cases.push(spec)
}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),transport='scripts/lib/halfspace-transport.ts'
if(sha(await readFile(transport))!==parent.sourceInventory.find((r:{file:string})=>r.file===transport).sha256)throw new Error('Transport drift')
await mkdir(root,{recursive:true})
const inventory:Array<{file:string;sha256:string;bytes:number}>=[]
async function retain(file:string,value:unknown,gzip=false) {
  const json=Buffer.from(JSON.stringify(value)+'\n'),bytes=gzip?gzipSync(json):json
  await writeFile(resolve(root,file),bytes,{flag:'wx'});inventory.push({file,sha256:sha(bytes),bytes:bytes.length})
}
const files=['scripts/m83-local-maximum.ts',transport,'scripts/lib/research-recorder.ts']
async function collect(dir:string) {
  for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const file=`${dir}/${e.name}`;if(e.isDirectory())await collect(file);else if(file.endsWith('.ts'))files.push(file)
  }
}
await collect('src/sim')
const sourceInventory=[]
for(const file of files) {
  const bytes=await readFile(file),target=resolve(root,'source-snapshot',file)
  await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});sourceInventory.push({file,sha256:sha(bytes)})
}
await retain('manifest.json',{schemaVersion:'m83-fresh-local-cross-v1',cases,sourceInventory,
  parentManifestSha256:sha(await readFile(`${parentRoot}/manifest.json`)),warmupSeconds:parent.warmupSeconds,concentrationScaleKgPerM3:parent.concentrationScaleKgPerM3,
  rules:'Three separated rising scan means within 75 s, final direction invalid, mean >=0.16, full unsaturated support. Nine visits C,+x,C,-x,C,+y,C,-y,C at 0.10 m offset; inherited 12 s dwell and settling/cadence. Every flank lower than both adjacent cores by >3 raw-channel noise SD. Adjacent cores vary <=max(3 SD,5% smaller core). Two attempts maximum; mission/travel budget enforced.',
  scope:'Finite local-contrast witness only, no source estimate, ray prior, native source declaration or no-leak decision. Supported result is a historical event, followed by holding pose; not continuously renewed evidence.',
  extraFields:'Uniform=1; plateau radius0.3m with Gaussian shoulders sigma0.6m; ridge Gaussian in x only sigma0.6m; intermittent Gaussian sigma0.6m with 10s on/10s off plus0.01 background. Two new development seeds each.',
  limitations:'Contrast margin and 5% stationarity allowance are engineering gates, not calibrated confidence levels. Fixed visit order remains vulnerable to temporal aliasing.',
  runtime:{node:process.version,platform:process.platform,architecture:process.arch}})
const summaries=[],replays=[]
for(const [index,spec] of cases.entries()) {
  const {config}=spec,L=config.domainMeters,engine=new SimulationEngine(config)
  if(spec.family==='transport') {
    const field=new HalfspaceTransport(spec.settings)
    engine.plume.windAt=()=>({x:spec.settings.wind.x/L,y:spec.settings.wind.y/L});engine.plume.transportAt=engine.plume.windAt
    engine.plume.concentrationAt=(p,t)=>field.evaluate({x:p.x*L,y:p.y*L,z:config.localInletSampling.inletHeightMetres},parent.warmupSeconds+t).concentration/parent.concentrationScaleKgPerM3
  } else engine.plume.concentrationAt=(p,t)=>{
    // Match archived peak arithmetic bit-for-bit; rescaling before hypot
    // changes floating-point rounding and fails exact decision-trace replay.
    const x=(p.x-.5)*L,r=Math.hypot(p.x-.5,p.y-.5)*L
    if(spec.blank)return 0
    if(spec.schedule==='uniform')return 1
    const d=spec.schedule==='plateau'?Math.max(0,r-.3):spec.schedule==='ridge'?Math.abs(x):r
    return .01+(spec.schedule==='intermittent'&&t%20>=10?0:1)*Math.exp(-d*d/(2*.6**2))
  }
  const controller=engine.controller as QuadSoilSniffController,step=controller.step.bind(controller)
  const telemetry:Array<ReturnType<QuadSoilSniffController['getPhysicalDiagnostics']>>=[]
  controller.step=input=>{const decision=step(input);telemetry.push(controller.getPhysicalDiagnostics());return decision}
  const {trace,frame}=recordResearchRun(engine)
  if(spec.variant==='gradient-reference') {
    const old=JSON.parse(gunzipSync(await readFile(`${parentRoot}/run-${spec.parentIndex}.json.gz`)).toString())
    if(JSON.stringify(trace)!==JSON.stringify(old.trace))throw new Error(`Original trace changed ${index}`)
    replays.push({index,parentIndex:spec.parentIndex,exact:true})
  }
  if(trace.some(r=>r.decision.nativeTerminated||r.decision.estimate!==null)||telemetry.some(t=>t.rayTimes.length||t.rayEstimate||t.heldPrior))throw new Error('Hotspot mislabeled as source')
  const results=telemetry.at(-1)?.localMaximum?.results??[],supported=results.find(r=>r.status==='supported')
  const summary={index,parentIndex:spec.parentIndex,family:spec.family,schedule:spec.schedule,variant:spec.variant,seed:spec.seed,wind:spec.wind,start:spec.start,
    blank:spec.blank,extra:spec.extra,...summarizeResearchTrace(trace),attempts:results,
    localContrastSupported:Boolean(supported),supportedAt:supported?.completedAt??null,
    supportedCandidateReleaseDistanceMetres:supported?Math.hypot(supported.candidate.x-.5,supported.candidate.y-.5)*L:null,
    endRobotReleaseDistanceMetres:spec.blank||['uniform','plateau','ridge'].includes(spec.schedule)?null:Math.hypot(frame.robot.position.x-.5,frame.robot.position.y-.5)*L,
    nativeDeclaration:frame.metrics.nativeDeclaration,nativeAbstention:frame.metrics.nativeAbstention,pathLengthMetres:frame.metrics.pathLengthMeters}
  summaries.push(summary);await retain(`run-${index}.json.gz`,{...spec,summary,trace,telemetry},true)
  process.stdout.write(`${index+1}/${cases.length} ${spec.variant} ${spec.schedule}: attempts=${results.length}, support=${Boolean(supported)}\n`)
}
await retain('summary.json',{runs:summaries});await retain('compatibility.json',{replays})
await writeFile(resolve(root,'complete.json'),JSON.stringify({complete:true,cases:cases.length,exactReplays:replays.length,inventory},null,2)+'\n',{flag:'wx'})
