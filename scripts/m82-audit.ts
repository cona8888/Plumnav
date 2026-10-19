/** Post-hoc approach audit; no oracle information reaches the controller. */
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {HalfspaceTransport} from './lib/halfspace-transport'
const root='research/evidence/m82_local_gradient_acquisition_2026-09-13',out='research/evidence/m82_local_gradient_audit_2026-09-13'
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const m=JSON.parse(await readFile(`${root}/manifest.json`,'utf8')),c=JSON.parse(await readFile(`${root}/complete.json`,'utf8'))
if(!c.complete)throw new Error('Incomplete packet')
let hashes=0,ticks=0
for(const r of c.inventory){if(sha(await readFile(`${root}/${r.file}`))!==r.sha256)throw new Error(`Artifact hash ${r.file}`);hashes++}
for(const r of m.sourceInventory){
  if(sha(await readFile(`${root}/source-snapshot/${r.file}`))!==r.sha256||sha(await readFile(r.file))!==r.sha256)throw new Error(`Source hash ${r.file}`)
  hashes+=2
}
const steadyPeaks=[]
for(const wind of [.02,.1]) {
  const spec=m.cases.find((r:{wind:number;schedule:string;family:string})=>r.family==='transport'&&r.schedule==='continuous'&&r.wind===wind)
  const f=new HalfspaceTransport(spec.settings),time=m.warmupSeconds+spec.config.durationSeconds,z=spec.config.localInletSampling.inletHeightMetres
  const levels=[.01,.005].map(spacing=>{
    const lo=spec.settings.source.x,hi=lo+wind*time,n=Math.ceil((hi-lo)/spacing)
    let best={x:lo,y:spec.settings.source.y,z,concentration:-Infinity}
    for(let k=0;k<=n;k++) {
      const p={x:Math.min(hi,lo+k*spacing),y:spec.settings.source.y,z},value=f.evaluate(p,time).concentration
      if(value>best.concentration)best={...p,concentration:value}
    }
    return {...best,spacing,searchBounds:[lo,hi]}
  })
  steadyPeaks.push({wind,time,levels,gridLocationChangeMetres:Math.abs(levels[0]!.x-levels[1]!.x),
    releaseToPeakMetres:levels[1]!.x-spec.settings.source.x})
}
const rows=[]
for(let index=0;index<m.cases.length;index++) {
  const r=JSON.parse(gunzipSync(await readFile(`${root}/run-${index}.json.gz`)).toString())
  const grad=r.variant==='local-gradient'
  for(let k=0;k<r.trace.length;k++) {
    const t=r.trace[k],d=r.telemetry[k]
    if(t.inputTimeSeconds!==d.time||![t.inputPosition.x,t.inputPosition.y,t.outputPosition.x,t.outputPosition.y].every((x:number)=>Number.isFinite(x)&&x>=0&&x<=1)||
      !Number.isFinite(t.measurement.concentration)||t.measurement.concentration<0)throw new Error('Invalid trace')
    if(grad&&(t.decision.estimate!==null||t.decision.nativeTerminated||d.rayTimes.length||d.rayEstimate||d.heldPrior))throw new Error('Cue became a source hypothesis')
    if(grad&&t.decision.phase==='LOCAL GRADIENT HEAD STEP') {
      const speed=Math.hypot(t.outputPosition.x-t.inputPosition.x,t.outputPosition.y-t.inputPosition.y)/r.config.fixedDt
      if(speed>r.config.robotSpeed*.9+1e-10)throw new Error('Excess gradient-step speed')
    }
    ticks++
  }
  const peak=r.family==='transport'&&r.schedule==='continuous'?steadyPeaks.find(p=>p.wind===r.wind)!.levels[1]:null
  const end=r.trace.at(-1).outputPosition
  rows.push({...r.summary,steadyEndPeakErrorMetres:peak?Math.hypot(end.x*r.config.domainMeters-peak.x,end.y*r.config.domainMeters-peak.y):null})
}
const median=(a:number[])=>{a.sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]!:null}
const groups=[]
for(const wind of [.02,.1])for(const schedule of ['continuous','pulse-phase0','pulse-phase5'])for(const variant of ['rolling-reference','local-gradient']) {
  const r=rows.filter(x=>x.family==='transport'&&x.wind===wind&&x.schedule===schedule&&x.variant===variant)
  groups.push({wind,schedule,variant,runs:r.length,
    everWithinPointOneMetre:r.filter(x=>x.closestDistanceMetres<=.1).length,
    endWithinPointOneMetre:r.filter(x=>x.endDistanceMetres<=.1).length,
    medianEndDistanceMetres:median(r.map(x=>x.endDistanceMetres)),
    medianTailDistanceMetres:median(r.map(x=>x.tailMedianDistanceMetres)),
    medianPathLengthMetres:median(r.map(x=>x.pathLengthMetres)),
    medianSteadyPeakErrorMetres:schedule==='continuous'?median(r.map(x=>x.steadyEndPeakErrorMetres)):null})
}
const pairs=[]
for(const r of rows.filter(x=>x.variant==='rolling-reference'&&!x.blank)) {
  const g=rows.find(x=>x.parentIndex===r.parentIndex&&x.variant==='local-gradient')!
  pairs.push({family:r.family,parentIndex:r.parentIndex,endDistanceChangeMetres:g.endDistanceMetres-r.endDistanceMetres,
    tailDistanceChangeMetres:g.tailMedianDistanceMetres!==null&&r.tailMedianDistanceMetres!==null?g.tailMedianDistanceMetres-r.tailMedianDistanceMetres:null})
}
await mkdir(out,{recursive:true})
const source=await readFile('scripts/m82-audit.ts'),body=Buffer.from(JSON.stringify({hashes,ticks,steadyPeaks,groups,pairs,rows,
  conventions:'Upper empirical median; proximity is robot position versus private truth, never localisation success. Peak search is post-hoc, at mission end, continuous releases only. Positive kernels have y maximum at source y and x maximum within the hull of packet centres; the discrete search is not a certified continuous optimiser.'},null,2)+'\n')
await writeFile(`${out}/m82-audit.ts`,source,{flag:'wx'});await writeFile(`${out}/audit.json`,body,{flag:'wx'})
await writeFile(`${out}/complete.json`,JSON.stringify({complete:true,sourceSha256:sha(source),auditSha256:sha(body),parentManifestSha256:sha(await readFile(`${root}/manifest.json`))})+'\n',{flag:'wx'})
process.stdout.write(JSON.stringify({hashes,ticks,steadyPeaks,groups},null,2)+'\n')
