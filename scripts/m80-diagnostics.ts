/** Read-only analysis of frozen M80 runs; oracle information never enters control. */
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {HalfspaceTransport} from './lib/halfspace-transport'
import type {ResearchTraceRow} from './lib/research-recorder'
const root='research/evidence/m80_halfspace_integration_2026-09-13'
const out='research/evidence/m80_halfspace_diagnostics_2026-09-13'
const manifest=JSON.parse(await readFile(`${root}/manifest.json`,'utf8'))
const completed=JSON.parse(await readFile(`${root}/complete.json`,'utf8'))
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
let verified=0
for(const item of completed.inventory) {
  if(sha(await readFile(`${root}/${item.file}`))!==item.sha256)throw new Error(`Artifact hash: ${item.file}`)
  verified++
}
for(const item of manifest.sourceInventory) {
  if(sha(await readFile(`${root}/source-snapshot/${item.file}`))!==item.sha256)throw new Error(`Source hash: ${item.file}`)
  verified++
}
const angle=(a:{x:number;y:number},b:{x:number;y:number})=>{
  const scale=Math.hypot(a.x,a.y)*Math.hypot(b.x,b.y)
  return scale>1e-30?Math.acos(Math.max(-1,Math.min(1,(a.x*b.x+a.y*b.y)/scale)))*180/Math.PI:null
}
const quantiles=(values:number[])=>{
  values.sort((a,b)=>a-b)
  const at=(q:number)=>values[Math.min(values.length-1,Math.floor(q*values.length))]??null
  return {count:values.length,min:at(0),median:at(0.5),p90:at(0.9),max:at(1)}
}
const diagnostics=[]
for(let index=0;index<manifest.cases.length;index++) {
  const run=JSON.parse(gunzipSync(await readFile(`${root}/run-${index}.json.gz`)).toString())
  const trace=run.trace as ResearchTraceRow[],L=run.config.domainMeters,field=new HalfspaceTransport(run.settings)
  const scans=[],failedFormation:Record<string,number>={},failedTerminal:Record<string,number>={}
  let firstBudgetStop:number|null=null,anyTrusted=false
  for(const row of trace) {
    if(row.decision.phase.startsWith('INSUFFICIENT')&&firstBudgetStop===null)firstBudgetStop=row.inputTimeSeconds
    const evidence=row.decision.quadDeclarationEvidence
    if(evidence) {
      anyTrusted ||= evidence.candidateFormation?.trustedCandidate??false
      for(const [key,pass] of Object.entries(evidence.candidateFormation?.gates??{}))if(!pass)failedFormation[key]=(failedFormation[key]??0)+1
      for(const [key,pass] of Object.entries(evidence.gates))if(!pass)failedTerminal[key]=(failedTerminal[key]??0)+1
    }
    const readings=row.measurement.quadSniff?.readings
    if(!readings||readings.length!==4)continue
    const p={x:row.inputPosition.x*L,y:row.inputPosition.y*L,z:run.config.localInletSampling.inletHeightMetres}
    const truth=field.evaluate(p,manifest.warmupSeconds+row.inputTimeSeconds)
    const toSource={x:run.settings.source.x-p.x,y:run.settings.source.y-p.y}
    const observed=readings.reduce((g,r)=>({x:g.x+r.direction.x*r.concentration,y:g.y+r.direction.y*r.concentration}),{x:0,y:0})
    const saturated=readings.some(r=>r.saturated)
    scans.push({time:row.inputTimeSeconds,position:p,meanReading:row.measurement.concentration,saturated,
      trueGradientMagnitudePerMetre:Math.hypot(truth.gradient.x,truth.gradient.y)/manifest.concentrationScaleKgPerM3,
      oracleGradientToSourceDegrees:angle(truth.gradient,toSource),
      observedToOracleGradientDegrees:saturated?null:angle(observed,truth.gradient)})
  }
  diagnostics.push({index,wind:run.settings.wind.x,schedule:run.schedule,start:run.start,seed:run.seed,
    firstBudgetStop,anyTrusted,failedFormationTickCounts:failedFormation,failedTerminalTickCounts:failedTerminal,
    readout:quantiles(trace.filter(r=>r.measurement.valid).map(r=>r.measurement.concentration)),
    oracleGradientToSourceDegrees:quantiles(scans.map(r=>r.oracleGradientToSourceDegrees).filter((x):x is number=>x!==null)),
    observedToOracleGradientDegrees:quantiles(scans.map(r=>r.observedToOracleGradientDegrees).filter((x):x is number=>x!==null)),scans})
}
await mkdir(out,{recursive:true})
const script=await readFile('scripts/m80-diagnostics.ts')
await writeFile(`${out}/m80-diagnostics.ts`,script,{flag:'wx'})
const result=Buffer.from(JSON.stringify({verifiedHashes:verified,scope:'Post-hoc descriptive oracle checks; not additional efficacy trials or a causal ablation. Angle quantiles include weak-gradient scans, with zero-gradient angles excluded and saturated observed angles excluded.',diagnostics},null,2)+'\n')
await writeFile(`${out}/diagnostics.json`,result,{flag:'wx'})
await writeFile(`${out}/complete.json`,JSON.stringify({complete:true,inputManifestSha256:sha(await readFile(`${root}/manifest.json`)),scriptSha256:sha(script),diagnosticsSha256:sha(result)})+'\n',{flag:'wx'})
process.stdout.write(JSON.stringify({verifiedHashes:verified,rows:diagnostics.map(({scans,failedTerminalTickCounts,failedFormationTickCounts,...rest})=>rest)},null,2)+'\n')
