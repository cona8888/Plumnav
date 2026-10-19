/** Scheduling-only paired development test. Frozen before any trial executes. */
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {dirname,resolve} from 'node:path'
import {gzipSync,gunzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {QuadSoilSniffController} from '../src/sim/algorithms/quadSoilSniff'
import {HalfspaceTransport,type HalfspaceSettings} from './lib/halfspace-transport'
import {recordResearchRun,summarizeResearchTrace} from './lib/research-recorder'
import {requirePhysicalAcquisitionBudget} from './lib/physical-acquisition-budget'
import type {SimulationConfig} from '../src/sim/types'
const root=resolve(process.argv[2]??'research/evidence/m81_rolling_ray_window_2026-09-13')
const m80='research/evidence/m80_halfspace_integration_2026-09-13',m78='research/evidence/m78_physical_bearing_geometry_2026-09-13'
const parent=JSON.parse(await readFile(`${m80}/manifest.json`,'utf8')),staticParent=JSON.parse(await readFile(`${m78}/manifest.json`,'utf8'))
type Case={config:SimulationConfig;family:'transport'|'static';parentIndex:number;variant:'reference'|'rolling';
  seed:number;blank:boolean;schedule:string;wind:number;start:number;settings?:HalfspaceSettings}
const cases:Case[]=[]
for(const [parentIndex,spec] of parent.cases.entries())for(const variant of ['reference','rolling'] as const) {
  const config=structuredClone(spec.config)
  if(variant==='rolling')config.localInletSampling.rayWindowPolicy='rolling-expiry-v1'
  cases.push({config,family:'transport',parentIndex,variant,seed:spec.seed,blank:spec.blank,
    schedule:spec.schedule,wind:spec.settings.wind.x,start:spec.start,settings:spec.settings})
}
for(const [parentIndex,spec] of staticParent.cases.entries()) {
  if(!spec.revised||!['near-peak','blank'].includes(spec.field))continue
  for(const variant of ['reference','rolling'] as const) {
    const config=structuredClone(spec.config)
    if(variant==='rolling')config.localInletSampling.rayWindowPolicy='rolling-expiry-v1'
    cases.push({config,family:'static',parentIndex,variant,seed:config.seed,blank:spec.field==='blank',
      schedule:spec.field,wind:config.localInletSampling.referenceWindMetresPerSecond,start:0.8})
  }
}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
// Reject changed transport math before interpreting paired trials.
const transportFile='scripts/lib/halfspace-transport.ts'
if(sha(await readFile(transportFile))!==parent.sourceInventory.find((r:{file:string})=>r.file===transportFile).sha256)throw new Error('M80 transport source drift')
if(!JSON.parse(await readFile(`${m80}/transport-verification.json`,'utf8')).passed)throw new Error('M80 transport verification missing')
await mkdir(root,{recursive:true})
const inventory:Array<{file:string;sha256:string;bytes:number}>=[]
async function retain(file:string,data:unknown,gzip=false) {
  const json=Buffer.from(JSON.stringify(data)+'\n'),bytes=gzip?gzipSync(json):json
  await writeFile(resolve(root,file),bytes,{flag:'wx'});inventory.push({file,sha256:sha(bytes),bytes:bytes.length})
}
const files=['scripts/m81-rolling-ray-window.ts',transportFile,'scripts/lib/research-recorder.ts','scripts/lib/physical-acquisition-budget.ts']
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
await retain('manifest.json',{schemaVersion:'m81-rolling-expiry-v1',cases,sourceInventory,
  parentManifestSha256:sha(await readFile(`${m80}/manifest.json`)),staticParentManifestSha256:sha(await readFile(`${m78}/manifest.json`)),
  warmupSeconds:parent.warmupSeconds,concentrationScaleKgPerM3:parent.concentrationScaleKgPerM3,
  rules:'Only rolling acquisition policy changes. Source-bearing model, actual 75 s ray lifetime, geometry thresholds and fresh confirmation remain unchanged. Original decision traces must match exactly with telemetry enabled.',
  scope:'26 paired M80 transport cases plus four paired M78 static controls. Existing development cases, not new held-out evidence. Acquisition repair is not source-bearing validation.',
  runtime:{node:process.version,platform:process.platform,architecture:process.arch}})
const summaries=[],replays=[]
for(const [index,spec] of cases.entries()) {
  const {config}=spec,L=config.domainMeters,engine=new SimulationEngine(config)
  const preflight=requirePhysicalAcquisitionBudget(config)
  if(spec.family==='transport') {
    const field=new HalfspaceTransport(spec.settings!)
    engine.plume.windAt=()=>({x:spec.settings!.wind.x/L,y:spec.settings!.wind.y/L})
    engine.plume.transportAt=engine.plume.windAt
    engine.plume.concentrationAt=(p,t)=>field.evaluate({x:p.x*L,y:p.y*L,z:config.localInletSampling!.inletHeightMetres},parent.warmupSeconds+t).concentration/parent.concentrationScaleKgPerM3
  } else engine.plume.concentrationAt=p=>spec.blank?0:0.01+Math.exp(-((Math.hypot(p.x-0.5,p.y-0.5)*L)**2)/(2*0.6**2))
  const controller=engine.controller as QuadSoilSniffController,step=controller.step.bind(controller)
  const telemetry:Array<ReturnType<QuadSoilSniffController['getPhysicalDiagnostics']>>=[]
  controller.step=input=>{const decision=step(input);telemetry.push(controller.getPhysicalDiagnostics());return decision}
  const {trace,frame}=recordResearchRun(engine)
  if(telemetry.length!==trace.length)throw new Error('Telemetry clock mismatch')
  if(spec.variant==='reference') {
    const old=spec.family==='transport'
      ?JSON.parse(gunzipSync(await readFile(`${m80}/run-${spec.parentIndex}.json.gz`)).toString())
      :JSON.parse(await readFile(`${m78}/run-${spec.parentIndex}.json`,'utf8'))
    if(JSON.stringify(trace)!==JSON.stringify(old.trace))throw new Error(`Reference drift ${index}`)
    replays.push({index,parentIndex:spec.parentIndex,family:spec.family,exact:true})
  }
  const declaration=trace.find(r=>r.decision.nativeTerminated),estimate=declaration?.decision.estimate
  const sourceError=estimate?Math.hypot(estimate.x-0.5,estimate.y-0.5)*L:null
  const failedGateTicks:Record<string,number>={}
  for(const t of telemetry)for(const [gate,pass] of Object.entries(t.gates))if(!pass)failedGateTicks[gate]=(failedGateTicks[gate]??0)+1
  const finiteRadius=telemetry.filter(t=>t.rayEstimate?.physicalUncertainty).map(t=>t.rayEstimate!.physicalUncertainty!.nominalRadius95*L)
  const summary={index,parentIndex:spec.parentIndex,family:spec.family,variant:spec.variant,seed:spec.seed,
    schedule:spec.schedule,wind:spec.wind,start:spec.start,...summarizeResearchTrace(trace),
    nativeDeclaration:frame.metrics.nativeDeclaration,nativeAbstention:frame.metrics.nativeAbstention,
    declarationTime:declaration?.inputTimeSeconds??null,releaseCentreErrorMetres:sourceError,
    buriedDefectErrorMetres:null,peakErrorMetres:spec.family==='static'?sourceError:null,
    sourceWithinStudyTolerance:!spec.blank&&sourceError!==null&&sourceError<=L*0.01,
    sourceWithinInspectionRadius:!spec.blank&&sourceError!==null&&sourceError<=0.1,
    falseDeclarationOnBlank:spec.blank&&Boolean(declaration),pathLengthMetres:frame.metrics.pathLengthMeters,
    oldestRayBudgetWaitSeconds:trace.filter(r=>r.decision.phase==='INSUFFICIENT BEARING ACQUISITION BUDGET').length*config.fixedDt,
    missionBudgetWaitSeconds:trace.filter(r=>r.decision.phase==='INSUFFICIENT MISSION ACQUISITION BUDGET').length*config.fixedDt,
    inspectionBudgetWaitSeconds:trace.filter(r=>r.decision.phase==='INSUFFICIENT PHYSICAL INSPECTION BUDGET').length*config.fixedDt,
    rawEligibleTicks:telemetry.filter(t=>t.rawRayEligible).length,
    heldPriorTicks:telemetry.filter(t=>t.heldPrior!==null).length,
    finitePhysicalFitTicks:finiteRadius.length,minNominalRadius95Metres:finiteRadius.length?Math.min(...finiteRadius):null,
    failedGateTicks,maxRayPool:frame.metrics.quadCandidateMaxGradientRayPoolCount}
  summaries.push(summary);await retain(`run-${index}.json.gz`,{...spec,preflight,summary,trace,telemetry},true)
  process.stdout.write(`${index+1}/${cases.length} ${spec.family} ${spec.variant}: declaration=${Boolean(declaration)}, old-ray wait=${summary.oldestRayBudgetWaitSeconds}s\n`)
}
await retain('summary.json',{runs:summaries});await retain('compatibility.json',{replays})
await writeFile(resolve(root,'complete.json'),JSON.stringify({complete:true,cases:cases.length,exactReplays:replays.length,inventory},null,2)+'\n',{flag:'wx'})
