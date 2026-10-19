/** Frozen transport integration witness; no controller tuning or paid compute. */
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {gzipSync} from 'node:zlib'
import {HalfspaceTransport,type HalfspaceSettings,type Point3} from './lib/halfspace-transport'
import {SimulationEngine} from '../src/sim/engine'
import type {SimulationConfig} from '../src/sim/types'
import {recordResearchRun,summarizeResearchTrace} from './lib/research-recorder'
import {requirePhysicalAcquisitionBudget} from './lib/physical-acquisition-budget'

const root=resolve(process.argv[2]??'research/evidence/m80_halfspace_integration_2026-09-13')
const baseManifest=JSON.parse(await readFile('research/evidence/m79_bearing_ablations_2026-09-13/manifest.json','utf8'))
const base=baseManifest.cases.find((c:{variant:string})=>c.variant==='full').config as SimulationConfig
const seeds=[80001,80002],warmupSeconds=300,concentrationScaleKgPerM3=1e-6
const defaultSettings:HalfspaceSettings={source:{x:0,y:0,z:0.025},wind:{x:0.02,y:0},diffusivity:0.001,
  sigma:0.15,rateKgPerSecond:2e-9,panelSeconds:2}
const schedules=[{id:'continuous',pulse:undefined},{id:'pulse-phase0',pulse:{periodSeconds:20,phaseSeconds:0}},
  {id:'pulse-phase5',pulse:{periodSeconds:20,phaseSeconds:5}}]
const cases=[]
for(const wind of [0.02,0.1])for(const schedule of schedules)for(const start of [0.4,0.8])for(const seed of seeds) {
  const config=structuredClone(base)
  config.seed=seed;config.windDirectionDegrees=90
  config.localInletSampling!.referenceWindMetresPerSecond=wind
  config.robotStartPositionOverride={x:0.5+start/config.domainMeters,y:0.5}
  const settings={...defaultSettings,source:{x:50,y:50,z:0.025},wind:{x:wind,y:0},pulse:schedule.pulse}
  cases.push({config,settings,start,seed,schedule:schedule.id,blank:false})
}
for(const seed of seeds) {
  const spec=structuredClone(cases.find(c=>c.seed===seed)!)
  spec.settings.rateKgPerSecond=0;spec.blank=true;spec.schedule='blank';cases.push(spec)
}
await mkdir(root,{recursive:true})
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const inventory:Array<{file:string;sha256:string;bytes:number}>=[]
async function retain(file:string,value:unknown,gzip=false) {
  const json=Buffer.from(JSON.stringify(value)+'\n'),bytes=gzip?gzipSync(json):json
  await writeFile(resolve(root,file),bytes,{flag:'wx'});inventory.push({file,sha256:sha(bytes),bytes:bytes.length})
}
const files=['scripts/m80-halfspace-integration.ts','scripts/m80_python_reference.py','scripts/m54_source_reference.py',
  'scripts/m54_source_reference_test.py','scripts/halfspace-transport.test.ts','scripts/lib/halfspace-transport.ts',
  'scripts/lib/research-recorder.ts','scripts/lib/physical-acquisition-budget.ts']
async function collect(dir:string) {
  for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const path=`${dir}/${entry.name}`;if(entry.isDirectory())await collect(path);else if(path.endsWith('.ts'))files.push(path)
  }
}
await collect('src/sim')
const sourceInventory=[]
for(const file of files) {
  const bytes=await readFile(file),dest=resolve(root,'source-snapshot',file)
  await mkdir(dirname(dest),{recursive:true});await writeFile(dest,bytes,{flag:'wx'});sourceInventory.push({file,sha256:sha(bytes)})
}
const gates={pulseRelative:1e-12,pythonRefinementRelative:1e-4,continuousRelative:1e-4,
  panelRefinementConcentrationRelative:1e-4,panelRefinementInletDifferenceRelative:1e-4}
await retain('manifest.json',{schemaVersion:'m80-halfspace-integration-v1',cases,seeds,warmupSeconds,concentrationScaleKgPerM3,
  gates,sourceInventory,missionSeconds:600,primaryToleranceMetres:1,diagnosticToleranceMetres:0.1,
  rules:'Frozen full M79 controller. 24 emitting + 2 blank development runs, no tuning. Four local channels at 5 cm height; no remote suction.',
  scope:'Analytical 3-D constant-coefficient passive transport sampled by a 2-D robot, not obstacle CFD, soil coupling, field data or commercial sensor calibration.',
  truth:'Gaussian near-ground volumetric release centre. Buried defect and surface flux are not modelled. Peak location is separately computed only on declarations.',
  runtime:{node:process.version,platform:process.platform,architecture:process.arch}})
const python=JSON.parse(execFileSync('python3',['scripts/m80_python_reference.py'],{encoding:'utf8'})) as Array<{
  wind:number;point:Point3;time:number;pulse:number;midpoint65536:number;midpoint131072:number}>
const rel=(a:number,b:number)=>Math.abs(a-b)/Math.max(Math.abs(b),1e-30)
const oracle=python.map(r=>{
  const f=new HalfspaceTransport({...defaultSettings,wind:{x:r.wind,y:0}})
  return {...r,pulseRelative:rel(f.pulseAt(r.point,3,2e-9).concentration,r.pulse),
    pythonRefinementRelative:rel(r.midpoint65536,r.midpoint131072),
    continuousRelative:rel(f.evaluate(r.point,r.time).concentration,r.midpoint131072)}
})
const refinement=[]
for(const wind of [0.02,0.1])for(const schedule of schedules)for(const time of [300,307,900])for(const x of [0.05,0.4,0.8]) {
  const values=[4,2,1].map(panelSeconds=>{
    const f=new HalfspaceTransport({...defaultSettings,wind:{x:wind,y:0},pulse:schedule.pulse,panelSeconds})
    const a=f.evaluate({x:x-0.05,y:0.1,z:0.05},time).concentration
    const b=f.evaluate({x:x+0.05,y:0.1,z:0.05},time).concentration
    return {panelSeconds,a,b,difference:a-b}
  })
  refinement.push({wind,schedule:schedule.id,time,x,values,
    concentrationRelative:Math.max(rel(values[1]!.a,values[2]!.a),rel(values[1]!.b,values[2]!.b)),
    inletDifferenceRelative:rel(values[1]!.difference,values[2]!.difference)})
}
const passed=oracle.every(r=>r.pulseRelative<=gates.pulseRelative&&r.pythonRefinementRelative<=gates.pythonRefinementRelative&&r.continuousRelative<=gates.continuousRelative)&&
  refinement.every(r=>r.concentrationRelative<=gates.panelRefinementConcentrationRelative&&r.inletDifferenceRelative<=gates.panelRefinementInletDifferenceRelative)
await retain('transport-verification.json',{passed,oracle,refinement})
if(!passed)throw new Error('Frozen transport gates failed; no controller cases executed')
process.stdout.write('Independent transport and 54 inlet-refinement checks passed.\n')

// Every positive Gaussian component peaks at y=source.y; all x component centres
// lie within [source.x,source.x+u*t]. Sample that enclosing interval at 5 mm.
// Report grid localisation, not a mathematically certified global optimiser.
function airbornePeak(field:HalfspaceTransport,time:number,z:number) {
  const s=field.settings,lo=s.source.x,hi=s.source.x+s.wind.x*time,step=0.005
  let best={x:lo,y:s.source.y,z,concentration:-Infinity}
  for(let x=lo;x<hi+step;x+=step) {
    const q={x:Math.min(x,hi),y:s.source.y,z},c=field.evaluate(q,time).concentration
    if(c>best.concentration)best={...q,concentration:c}
  }
  return {...best,gridSpacingMetres:step,searchIntervalMetres:[lo,hi]}
}
const summaries=[]
for(const [index,spec] of cases.entries()) {
  const {config,settings}=spec,field=new HalfspaceTransport(settings),L=config.domainMeters
  const preflight=requirePhysicalAcquisitionBudget(config),engine=new SimulationEngine(config)
  engine.plume.windAt=()=>({x:settings.wind.x/L,y:settings.wind.y/L})
  engine.plume.transportAt=engine.plume.windAt
  engine.plume.concentrationAt=(p,t)=>field.evaluate({x:p.x*L,y:p.y*L,z:config.localInletSampling!.inletHeightMetres},warmupSeconds+t).concentration/concentrationScaleKgPerM3
  const {trace,frame}=recordResearchRun(engine),declared=trace.find(r=>r.decision.nativeTerminated),estimate=declared?.decision.estimate
  const declarationTime=declared?.inputTimeSeconds??null
  const sourceError=estimate?Math.hypot(estimate.x*L-settings.source.x,estimate.y*L-settings.source.y):null
  const peak=declared?airbornePeak(field,warmupSeconds+declared.inputTimeSeconds,config.localInletSampling!.inletHeightMetres):null
  const peakError=estimate&&peak?Math.hypot(estimate.x*L-peak.x,estimate.y*L-peak.y):null
  const summary={index,seed:spec.seed,wind:settings.wind.x,schedule:spec.schedule,start:spec.start,...summarizeResearchTrace(trace),
    nativeDeclaration:frame.metrics.nativeDeclaration,nativeAbstention:frame.metrics.nativeAbstention,declarationTime,
    releaseCentreErrorMetres:sourceError,buriedDefectErrorMetres:null,airbornePeak:peak,peakErrorMetres:peakError,
    sourceWithinStudyTolerance:!spec.blank&&sourceError!==null&&sourceError<=1,
    sourceWithinInspectionRadius:!spec.blank&&sourceError!==null&&sourceError<=0.1,
    falseDeclarationOnBlank:spec.blank&&Boolean(declared),pathLengthMetres:frame.metrics.pathLengthMeters,
    maxRayPool:frame.metrics.quadCandidateMaxGradientRayPoolCount,maxProvisionalRays:frame.metrics.quadCandidateMaxProvisionalRayCount}
  summaries.push(summary);await retain(`run-${index}.json.gz`,{...spec,preflight,summary,trace},true)
  process.stdout.write(`Completed ${index+1}/${cases.length}: ${spec.schedule}, u=${settings.wind.x}, start=${spec.start}, declared=${Boolean(declared)}\n`)
}
await retain('summary.json',{runs:summaries})
// Representative exact full-history replay: two original successes and two controls.
const m78='research/evidence/m78_physical_bearing_geometry_2026-09-13'
const archived=JSON.parse(await readFile(`${m78}/manifest.json`,'utf8')),replays=[]
for(const [index,spec] of archived.cases.entries()) {
  if(!spec.revised||!['near-peak','blank'].includes(spec.field))continue
  const e=new SimulationEngine(spec.config)
  e.plume.concentrationAt=p=>spec.field==='blank'?0:0.01+Math.exp(-((Math.hypot(p.x-0.5,p.y-0.5)*100)**2)/(2*0.6**2))
  const {trace}=recordResearchRun(e),old=JSON.parse(await readFile(`${m78}/run-${index}.json`,'utf8'))
  if(JSON.stringify(trace)!==JSON.stringify(old.trace))throw new Error(`M78 trace mismatch ${index}`)
  replays.push({index,field:spec.field,exact:true})
}
await retain('compatibility.json',{replays})
await writeFile(resolve(root,'complete.json'),JSON.stringify({complete:true,cases:cases.length,inventory},null,2)+'\n',{flag:'wx'})
process.stdout.write('Completed frozen local transport integration packet.\n')
