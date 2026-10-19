/** Fixed local ablations and robustness diagnostics; no tuning from run outcomes. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { SimulationEngine } from '../src/sim/engine'
import { recordResearchRun, summarizeResearchTrace, compareScientificMetrics } from './lib/research-recorder'
import { requirePhysicalAcquisitionBudget } from './lib/physical-acquisition-budget'
import type { SimulationConfig, BatchResult, MetricSnapshot, LocalInletSamplingConfig } from '../src/sim/types'
const root = resolve(process.argv[2] ?? 'research/evidence/m79_bearing_ablations_2026-09-13')
const m78 = 'research/evidence/m78_physical_bearing_geometry_2026-09-13'
const oldManifest = JSON.parse(await readFile(`${m78}/manifest.json`, 'utf8'))
const base = oldManifest.cases.find((r: {field:string;revised:boolean}) => r.field === 'near-peak' && r.revised).config as SimulationConfig
const seeds = [79001, 79002, 79003, 79004]
const variants: Array<{id:string; ablation?:LocalInletSamplingConfig['bearingAblation']}> = [
  {id:'full'}, {id:'legacy-spacing',ablation:'legacy-spacing'}, {id:'wind-bearing',ablation:'wind-bearing'},
  {id:'legacy-geometry',ablation:'legacy-geometry'}, {id:'no-radius-gate',ablation:'no-radius-gate'}]
const conditions = [
  {id:'reference',width:0.6,offset:{x:0.8,y:0},noise:0.001},
  {id:'rotated-start',width:0.6,offset:{x:0,y:0.8},noise:0.001},
  {id:'higher-noise',width:0.6,offset:{x:0.8,y:0},noise:0.01},
  {id:'narrower-peak',width:0.3,offset:{x:0.8,y:0},noise:0.001},
  {id:'broad-peak',width:3,offset:{x:4,y:0},noise:0.001},
  {id:'intermittent',width:0.6,offset:{x:0.8,y:0},noise:0.001},
  {id:'displaced-peak',width:0.6,offset:{x:0.8,y:0},noise:0.001},
  {id:'blank',width:0.6,offset:{x:0.8,y:0},noise:0.001},
  {id:'uniform',width:0.6,offset:{x:0.8,y:0},noise:0.001},
]
const cases = []
for (const condition of conditions) for (const seed of seeds) for (const variant of variants) {
  const config = structuredClone(base)
  const peak = {x:condition.id === 'displaced-peak' ? 0.52 : 0.5,y:0.5}
  config.seed = seed; config.sensorNoise = condition.noise
  config.robotStartPositionOverride = {x:peak.x+condition.offset.x/config.domainMeters,y:peak.y+condition.offset.y/config.domainMeters}
  if (variant.ablation) config.localInletSampling!.bearingAblation = variant.ablation
  cases.push({config,condition,seed,variant:variant.id,peak,designatedSource:{x:0.5,y:0.5}})
}
await mkdir(root, {recursive:true})
const hash = (b:Buffer) => createHash('sha256').update(b).digest('hex')
const writeNew = (file:string,value:unknown) => writeFile(resolve(root,file),JSON.stringify(value,null,2)+'\n',{flag:'wx'})
const files = ['scripts/m79-bearing-ablations.ts','scripts/lib/research-recorder.ts','scripts/lib/physical-acquisition-budget.ts']
async function collect(dir:string) {
  for (const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const file=`${dir}/${e.name}`
    if(e.isDirectory()) await collect(file)
    else if(file.endsWith('.ts')) files.push(file)
  }
}
await collect('src/sim')
const sourceInventory=[]
for(const file of files) {
  const bytes=await readFile(file),target=resolve(root,'source-snapshot',file)
  await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'})
  sourceInventory.push({file,sha256:hash(bytes)})
}
await writeNew('manifest.json',{schemaVersion:'m79-local-bearing-ablations-v1',cases,seeds,variants,conditions,sourceInventory,
  rules:{missionSeconds:600,inspectionToleranceMetres:0.1,studyToleranceDomainFraction:0.01,
    intermittency:'20-second square period; first 10 seconds on, next 10 off; background 0.01 remains',
    displacedPeak:'Peak and robot start translated together by 2 m; designated source stays fixed. Falsification fixture, not soil transport.',
    noRadiusGate:'Removes only the hard nominal-95%-radius condition. Residual consistency, soft uncertainty score and fresh confirmation remain.',
    windBearing:'Deliberately restores the old wind direction transform while retaining the local-gradient uncertainty. Misspecification ablation, not a calibrated physical model.'},
  scope:'Four new development seeds; neither a held-out general benchmark nor commercial-sensor validation. No parameter tuning in this packet.',
  runtime:{node:process.version,platform:process.platform,architecture:process.arch}})
const inventory:Array<{file:string;sha256:string;bytes:number}>=[]
async function retain(file:string,value:unknown,compressed=false) {
  const json=Buffer.from(JSON.stringify(value)+'\n'),bytes=compressed?gzipSync(json):json
  await writeFile(resolve(root,file),bytes,{flag:'wx'});inventory.push({file,sha256:hash(bytes),bytes:bytes.length})
}
const summaries=[]
for(const [index,spec] of cases.entries()) {
  const {config,condition,peak,designatedSource}=spec
  const preflight=requirePhysicalAcquisitionBudget(config)
  const engine=new SimulationEngine(config)
  engine.plume.concentrationAt=(p,t)=>{
    if(condition.id==='blank') return 0
    if(condition.id==='uniform') return 0.5
    const amplitude=condition.id==='intermittent' && t%20>=10 ? 0 : 1
    const r=Math.hypot(p.x-peak.x,p.y-peak.y)*config.domainMeters
    return 0.01+amplitude*Math.exp(-r*r/(2*condition.width**2))
  }
  const {trace,frame}=recordResearchRun(engine)
  const declared=trace.find(r=>r.decision.nativeTerminated),estimate=declared?.decision.estimate
  const peakError=estimate?Math.hypot(estimate.x-peak.x,estimate.y-peak.y)*config.domainMeters:null
  const sourceError=estimate?Math.hypot(estimate.x-designatedSource.x,estimate.y-designatedSource.y)*config.domainMeters:null
  const gasPresent=!['blank','uniform'].includes(condition.id)
  const summary={index,condition:condition.id,seed:spec.seed,variant:spec.variant,...summarizeResearchTrace(trace),
    nativeDeclaration:frame.metrics.nativeDeclaration,nativeAbstention:frame.metrics.nativeAbstention,
    declarationTime:declared?.inputTimeSeconds??null,peakErrorMetres:peakError,designatedSourceErrorMetres:sourceError,
    peakWithinInspectionRadius:gasPresent&&peakError!==null&&peakError<=0.1,
    sourceWithinStudyTolerance:gasPresent&&sourceError!==null&&sourceError<=config.domainMeters*0.01,
    falseDeclarationOnNegativeControl:!gasPresent&&Boolean(declared),
    pathLengthMetres:frame.metrics.pathLengthMeters,
    maxRayPool:frame.metrics.quadCandidateMaxGradientRayPoolCount,maxProvisionalRays:frame.metrics.quadCandidateMaxProvisionalRayCount}
  await retain(`run-${index}.json.gz`,{...spec,preflight,summary,trace},true)
  summaries.push(summary)
  if((index+1)%20===0||index+1===cases.length) process.stdout.write(`Completed ${index+1}/${cases.length} local cases\n`)
}
const groups=[]
for(const condition of conditions)for(const variant of variants) {
  const rows=summaries.filter(r=>r.condition===condition.id&&r.variant===variant.id)
  groups.push({condition:condition.id,variant:variant.id,runs:rows.length,
    declarations:rows.filter(r=>r.nativeDeclaration).length,
    peakWithinInspectionRadius:rows.filter(r=>r.peakWithinInspectionRadius).length,
    sourceWithinStudyTolerance:rows.filter(r=>r.sourceWithinStudyTolerance).length,
    falseDeclarations:rows.filter(r=>r.falseDeclarationOnNegativeControl).length,
    abstentions:rows.filter(r=>r.nativeAbstention).length,
    unresolved:rows.filter(r=>!r.nativeDeclaration&&!r.nativeAbstention).length})
}
await retain('summary.json',{runs:summaries,groups})
const traceReplays=[]
for(const [index,spec] of oldManifest.cases.entries()) {
  const e=new SimulationEngine(spec.config)
  const width=spec.field==='broad-peak'?3:spec.field==='near-peak'?0.6:0.06
  e.plume.concentrationAt=p=>{
    const r=Math.hypot(p.x-0.5,p.y-0.5)*spec.config.domainMeters
    return spec.field==='blank'?0:spec.field==='uniform'?0.5:0.01+(spec.field==='weak'?0.0001:1)*Math.exp(-r*r/(2*width**2))
  }
  const {trace}=recordResearchRun(e)
  const old=JSON.parse(await readFile(`${m78}/run-${index}.json`,'utf8'))
  if(JSON.stringify(trace)!==JSON.stringify(old.trace))throw new Error(`M78 trace mismatch ${index}`)
  traceReplays.push({index,exact:true})
}
const legacy=JSON.parse(await readFile('research/evidence/m72_diagnostic_replay_2026-09-13/manifest.json','utf8')) as {inputs:Array<{run:BatchResult}>}
const refs:Array<{config:SimulationConfig;metrics:MetricSnapshot;checkpoint:number}>=legacy.inputs.map(i=>({config:i.run.config,metrics:i.run.metrics,checkpoint:i.run.checkpointSeconds}))
for(let i=0;i<8;i++) {
  const a=JSON.parse(await readFile(`research/evidence/m73_local_inlet_commissioning_2026-09-13/run-${i}.json`,'utf8'))
  const b=JSON.parse(await readFile(`research/evidence/m74_bounded_scan_diagnostic_2026-09-13/pair-${i}.json`,'utf8'))
  refs.push({config:a.config,metrics:a.metrics,checkpoint:120},{config:b.treatmentConfig,metrics:b.treatmentMetrics,checkpoint:120})
}
const metricReplays=[]
for(const ref of refs) {
  const e=new SimulationEngine(ref.config);while(!e.isCompleted())e.step()
  const comparison=compareScientificMetrics(e.getFrame().checkpoints[ref.checkpoint]!,ref.metrics)
  if(!comparison.exact)throw new Error('Archived metric mismatch')
  metricReplays.push(comparison)
}
await retain('compatibility.json',{traceReplays,metricReplays})
const bytes=await readFile(resolve(root,'manifest.json'));inventory.push({file:'manifest.json',sha256:hash(bytes),bytes:bytes.length})
await writeNew('complete.json',{complete:true,cases:cases.length,metricReplays:metricReplays.length,traceReplays:traceReplays.length,inventory})
process.stdout.write('All cases and compatibility checks completed.\n')
