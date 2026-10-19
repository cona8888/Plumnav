/** Artifact audit and independent re-evaluation of retained probe samples. */
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {estimateQuadGradient} from '../src/sim/algorithms/quadSoilSniff'
const root='research/evidence/m84_local_maximum_components_2026-09-13',out='research/evidence/m84_local_maximum_audit_2026-09-13'
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const m=JSON.parse(await readFile(`${root}/manifest.json`,'utf8')),done=JSON.parse(await readFile(`${root}/complete.json`,'utf8'))
if(!done.complete)throw new Error('Incomplete packet')
let hashes=0,ticks=0,verifiedSamples=0
for(const r of done.inventory){if(sha(await readFile(`${root}/${r.file}`))!==r.sha256)throw new Error(`Hash ${r.file}`);hashes++}
for(const r of m.sourceInventory){if(sha(await readFile(`${root}/source-snapshot/${r.file}`))!==r.sha256||sha(await readFile(r.file))!==r.sha256)throw new Error(`Source hash ${r.file}`);hashes+=2}
const med=(values:number[])=>{const a=[...values].sort((x,y)=>x-y);return a[Math.floor(a.length/2)]??null}
const oldSource=await readFile('research/evidence/m83_local_maximum_v2_2026-09-13/source-snapshot/src/sim/algorithms/localMaximumProbe.ts','utf8')
const newSource=await readFile('src/sim/algorithms/localMaximumProbe.ts','utf8')
const acceptance=(s:string)=>s.slice(s.indexOf('export function evaluateLocalMaximumVisits'),s.indexOf('export class LocalMaximumProbe'))
if(acceptance(oldSource)!==acceptance(newSource))throw new Error('Acceptance rule changed')
let recenteredAttempts=0
const rows=[]
for(let index=0;index<m.cases.length;index++) {
  const run=JSON.parse(gunzipSync(await readFile(`${root}/run-${index}.json.gz`)).toString()),c=run.config.localInletSampling.inspection
  const byTime=new Map<number,any>(run.trace.map((r:any)=>[r.inputTimeSeconds,r]))
  for(let k=0;k<run.trace.length;k++) {
    const r=run.trace[k],t=run.telemetry[k]
    if(r.inputTimeSeconds!==t.time||r.decision.nativeTerminated||r.decision.estimate!==null||t.rayTimes.length||t.rayEstimate||t.heldPrior)throw new Error('Source/clock contract')
    if(!Number.isFinite(r.measurement.concentration)||r.measurement.concentration<0||![r.inputPosition.x,r.inputPosition.y,r.outputPosition.x,r.outputPosition.y].every((v:number)=>Number.isFinite(v)&&v>=0&&v<=1))throw new Error('Invalid trace')
    ticks++
  }
  const attempts=[]
  const usedSampleTimes=new Set<number>()
  for(const [attemptIndex,result] of run.summary.attempts.entries()) {
    const previousResult=run.summary.attempts[attemptIndex-1]
    if(previousResult&&result.startedAt<=previousResult.completedAt)throw new Error('Overlapping probe attempts')
    const startRecord=run.telemetry.find((t:any)=>t.time===result.startedAt)
    const recentered=startRecord?.localMaximum?.nominationReason==='higher-flank-half-step-proposal'
    if(recentered) {
      if(!previousResult||previousResult.status!=='rejected'||!run.config.localInletSampling.localMaximumRecentering)throw new Error('Invalid recenter provenance')
      const flanks=[1,3,5,7].map(i=>({i,gain:previousResult.medians[i]-Math.max(previousResult.medians[i-1],previousResult.medians[i+1])})).sort((a,b)=>b.gain-a.gain)
      const best=flanks[0]!,centre=previousResult.candidate,target=previousResult.visits[best.i].target
      if(!(best.gain>0)||Math.hypot(result.candidate.x-(centre.x+(target.x-centre.x)*.5),result.candidate.y-(centre.y+(target.y-centre.y)*.5))>1e-12)throw new Error('Invalid recenter target')
      recenteredAttempts++
    }
    for(const visit of result.visits) {
      let previous=-Infinity
      for(const sample of visit.samples) {
        if(sample.time<result.startedAt||usedSampleTimes.has(sample.time))throw new Error('Reused/pre-candidate sample')
        usedSampleTimes.add(sample.time)
        const r=byTime.get(sample.time)
        if(!r||!r.measurement.valid||r.measurement.sampleMode!=='passive'||r.measurement.concentration!==sample.value||r.measurement.hit!==sample.hit||
          sample.time<visit.arrivedAt+c.settlingSeconds-1e-9||sample.time-previous<c.sampleSpacingSeconds-1e-9||
          Math.hypot(r.inputPosition.x-visit.target.x,r.inputPosition.y-visit.target.y)>c.arrivalRadiusNormalized+1e-9)throw new Error('Probe sample provenance/settling')
        previous=sample.time;verifiedSamples++
      }
    }
    const values=result.visits.map((v:any)=>med(v.samples.map((s:any)=>s.value))),margin=3*run.config.sensorNoise
    const differences=[1,3,5,7].map(i=>values[i-1]!==null&&values[i]!==null&&values[i+1]!==null?Math.min(values[i-1],values[i+1])-values[i]:null)
    const eligible=values.every((v:any)=>v!==null)&&result.visits.every((v:any)=>v.samples.length>=c.minimumSamplesPerWaypoint)&&
      [0,2,4,6,8].every(i=>values[i]>=.16&&result.visits[i].samples.filter((s:any)=>s.hit).length>=c.minimumSamplesPerWaypoint)&&
      [1,3,5,7].every(i=>Math.abs(values[i-1]-values[i+1])<=Math.max(margin,.05*Math.min(values[i-1],values[i+1])))&&
      differences.every(d=>d!==null&&d>margin)
    if(result.status==='supported'&&!eligible)throw new Error('Unsupported positive witness')
    attempts.push({recentered,status:result.status,reason:result.reason,candidate:result.candidate,completedAt:result.completedAt,values,differences,eligible})
  }
  // Post-hoc trigger diagnostics: identify which nomination tests fail at
  // strong, full-support scan returns where the array direction is invalid.
  const triggerChecks=[]
  const scans=run.trace.filter((r:any)=>r.measurement.quadSniff?.readings)
  for(let i=0;i<scans.length;i++) {
    const r=scans[i],g=estimateQuadGradient(r.measurement.quadSniff.readings,run.config.sensorNoise,run.config.localInletSampling.gradientEstimator)
    if(g.validDirection||g.commonMean<.16||g.usableChannels!==4)continue
    const recent=scans.slice(0,i+1).filter((s:any)=>s.inputTimeSeconds>=r.inputTimeSeconds-75).slice(-3)
    const means=recent.map((s:any)=>s.measurement.quadSniff.readings.reduce((a:number,b:any)=>a+b.concentration,0)/4)
    triggerChecks.push({time:r.inputTimeSeconds,means,threeRecent:recent.length===3,
      netRise:means.length===3?means[2]-means[0]:null,
      separated:recent.length===3&&[1,2].every(j=>Math.hypot(recent[j].inputPosition.x-recent[j-1].inputPosition.x,recent[j].inputPosition.y-recent[j-1].inputPosition.y)>=run.config.localInletSampling.opposingInletSpacingMetres/run.config.domainMeters/2),
      commonMean:g.commonMean,gradientSnr:g.gradientSnr})
  }
  rows.push({...run.summary,attemptAudit:attempts,triggerChecks})
}
const groups=[]
for(const family of ['transport','static'])for(const variant of ['reference','nomination','recentering','combined'])for(const schedule of [...new Set(rows.filter(r=>r.family===family).map(r=>r.schedule))]) {
  const a=rows.filter(r=>r.family===family&&r.variant===variant&&r.schedule===schedule)
  if(a.length)groups.push({family,variant,schedule,runs:a.length,attemptedRuns:a.filter(r=>r.attempts.length).length,
    supported:a.filter(r=>r.localContrastSupported).length,rejectedAttempts:a.reduce((s,r)=>s+r.attempts.filter((t:any)=>t.status==='rejected').length,0)})
}
await mkdir(out,{recursive:true})
const source=await readFile('scripts/m84-audit.ts'),body=Buffer.from(JSON.stringify({hashes,ticks,verifiedSamples,recenteredAttempts,acceptanceUnchanged:true,groups,rows,
  scope:'Independent checks of actual passive sensor provenance and numerical contrast conditions. No inference that a finite cross pattern proves spatial origin or a buried leak.'},null,2)+'\n')
await writeFile(`${out}/m84-audit.ts`,source,{flag:'wx'});await writeFile(`${out}/audit.json`,body,{flag:'wx'})
await writeFile(`${out}/complete.json`,JSON.stringify({complete:true,sourceSha256:sha(source),auditSha256:sha(body),parentManifestSha256:sha(await readFile(`${root}/manifest.json`))})+'\n',{flag:'wx'})
process.stdout.write(JSON.stringify({hashes,ticks,verifiedSamples,groups},null,2)+'\n')

