/** Independent artifact/trace audit and descriptive paired summaries. */
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
const root='research/evidence/m81_rolling_ray_window_2026-09-13',out='research/evidence/m81_rolling_ray_audit_2026-09-13'
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const manifest=JSON.parse(await readFile(`${root}/manifest.json`,'utf8'))
const completed=JSON.parse(await readFile(`${root}/complete.json`,'utf8'))
if(!completed.complete)throw new Error('Incomplete packet')
let verifiedHashes=0,ticks=0,cachedExpiredTicksAfterInspectionBudgetStop=0
for(const r of completed.inventory) {
  if(sha(await readFile(`${root}/${r.file}`))!==r.sha256)throw new Error(`Artifact hash ${r.file}`)
  verifiedHashes++
}
for(const r of manifest.sourceInventory) {
  if(sha(await readFile(`${root}/source-snapshot/${r.file}`))!==r.sha256)throw new Error(`Source hash ${r.file}`)
  if(sha(await readFile(r.file))!==r.sha256)throw new Error(`Working source drift ${r.file}`)
  verifiedHashes+=2
}
const quantiles=(a:number[])=>{
  a.sort((x,y)=>x-y);const at=(q:number)=>a[Math.min(a.length-1,Math.floor(q*a.length))]??null
  return {count:a.length,min:at(0),median:at(.5),p90:at(.9),max:at(1)}
}
const rows=[]
for(let index=0;index<manifest.cases.length;index++) {
  const run=JSON.parse(gunzipSync(await readFile(`${root}/run-${index}.json.gz`)).toString())
  if(run.trace.length!==run.telemetry.length)throw new Error(`Telemetry length ${index}`)
  const fitChi:number[]=[],fitRadius:number[]=[]
  for(let k=0;k<run.trace.length;k++) {
    const r=run.trace[k],t=run.telemetry[k]
    if(t.time!==r.inputTimeSeconds)throw new Error(`Telemetry clock ${index}/${k}`)
    if(!Number.isFinite(r.measurement.concentration)||r.measurement.concentration<0||
      ![r.inputPosition.x,r.inputPosition.y,r.outputPosition.x,r.outputPosition.y].every((x:number)=>Number.isFinite(x)&&x>=0&&x<=1))throw new Error('Invalid trace value')
    if(t.rayTimes.some((time:number)=>time>t.time))throw new Error('Future evidence')
    const expired=t.rayTimes.some((time:number)=>t.time-time>t.retentionSeconds+1e-9)
    if(expired) {
      if(!t.inspectionBudgetExhausted||t.rawRayEligible||r.decision.nativeTerminated)throw new Error('Expired live raw evidence')
      cachedExpiredTicksAfterInspectionBudgetStop++
    }
    const u=t.rayEstimate?.physicalUncertainty
    if(u) {
      if(!Number.isFinite(u.reducedChiSquare)||!Number.isFinite(u.nominalRadius95))throw new Error('Nonfinite physical fit')
      fitChi.push(u.reducedChiSquare);fitRadius.push(u.nominalRadius95*run.config.domainMeters)
    }
    ticks++
  }
  rows.push({...run.summary,fitReducedChiSquare:quantiles(fitChi),fitNominalRadius95Metres:quantiles(fitRadius)})
}
const groups=[]
for(const family of ['transport','static'])for(const variant of ['reference','rolling']) {
  const r=rows.filter(x=>x.family===family&&x.variant===variant)
  groups.push({family,variant,runs:r.length,declarations:r.filter(x=>x.nativeDeclaration).length,
    successful:r.filter(x=>x.sourceWithinStudyTolerance).length,falseDeclarations:r.filter(x=>x.falseDeclarationOnBlank).length,
    abstentions:r.filter(x=>x.nativeAbstention).length,brackets:r.reduce((s,x)=>s+x.bracketAttempts.length,0),
    scans:r.reduce((s,x)=>s+x.quadReturns,0),oldestRayBudgetWaitSeconds:r.reduce((s,x)=>s+x.oldestRayBudgetWaitSeconds,0)})
}
const pairs=[]
for(const r of rows.filter(x=>x.variant==='reference')) {
  const treatment=rows.find(x=>x.variant==='rolling'&&x.parentIndex===r.parentIndex&&x.family===r.family)!
  pairs.push({family:r.family,parentIndex:r.parentIndex,wind:r.wind,schedule:r.schedule,start:r.start,seed:r.seed,
    reference:r.index,rolling:treatment.index,scanDifference:treatment.quadReturns-r.quadReturns,
    distanceDifferenceMetres:treatment.pathLengthMetres-r.pathLengthMetres,
    oldRayWaitRemovedSeconds:r.oldestRayBudgetWaitSeconds-treatment.oldestRayBudgetWaitSeconds})
}
await mkdir(out,{recursive:true})
const source=await readFile('scripts/m81-audit.ts')
await writeFile(`${out}/m81-audit.ts`,source,{flag:'wx'})
const result=Buffer.from(JSON.stringify({verifiedHashes,ticks,cachedExpiredTicksAfterInspectionBudgetStop,groups,pairs,rows,
  interpretation:'Descriptive development pairs. Tick-level fit quantiles reuse retained fits and are not independent statistical replicates. Expired cached state after an inspection-budget stop is excluded from raw eligibility and is not a declaration.'},null,2)+'\n')
await writeFile(`${out}/audit.json`,result,{flag:'wx'})
await writeFile(`${out}/complete.json`,JSON.stringify({complete:true,sourceSha256:sha(source),auditSha256:sha(result),parentManifestSha256:sha(await readFile(`${root}/manifest.json`))})+'\n',{flag:'wx'})
process.stdout.write(JSON.stringify({verifiedHashes,ticks,cachedExpiredTicksAfterInspectionBudgetStop,groups},null,2)+'\n')
