import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { runM41Case, M41_REFERENCE, type FieldKind, type Arm } from './lib/m41-development'

const output=process.argv[2]
if(!output) throw new Error('Supply a new output directory for this development-only report')
const directory=resolve(output)
// Refuse accidental replacement of a previous generation.
mkdirSync(directory,{recursive:false})
const fields:FieldKind[]=['linear','quadratic','cubic-reversal','rotating-linear','uniform','zero']
const arms:Arm[]=['directed-probe','stationary-check','random-probe']
const rows:ReturnType<typeof runM41Case>[]=[]
for(const field of fields) for(const feature of [0.05,0.1,0.2,0.4])
  for(const tau of [0.1,M41_REFERENCE.tau,3]) for(const dwell of [4,12])
    for(const noise of [0,0.01]) for(const seed of [1,2,3,4,5,6,7,8])
      for(const arm of arms) rows.push(runM41Case({field,feature,tau,dwell,noise,seed,arm}))

type Row=typeof rows[number]
const summary=(rs:Row[])=>{
  const initialWrong=rs.filter(r=>r.baselineAccepted&&r.initialErrorDegrees!==null&&r.initialErrorDegrees>45)
  const accepted=rs.filter(r=>r.check.accepted)
  const scorable=accepted.filter(r=>r.endErrorDegrees!==null)
  const wrong=scorable.filter(r=>r.endErrorDegrees!>45)
  return {trials:rs.length,initialAccepted:rs.filter(r=>r.baselineAccepted).length,
    initialWrong:initialWrong.length,initialWrongRejected:initialWrong.filter(r=>!r.check.accepted).length,
    accepted:accepted.length,acceptedScorable:scorable.length,acceptedWrongAtEnd:wrong.length,
    acceptedWithoutTrueGradient:accepted.filter(r=>r.endErrorDegrees===null).length,
    wrongFractionAmongScorableAccepted:scorable.length?wrong.length/scorable.length:null,
    acceptanceFraction:rs.length?accepted.length/rs.length:null,
    meanTimeSeconds:rs.reduce((s,r)=>s+r.elapsedSeconds,0)/rs.length,
    meanDistanceMetres:rs.reduce((s,r)=>s+r.distanceMetres,0)/rs.length}
}
const byArm=Object.fromEntries(arms.map(a=>[a,summary(rows.filter(r=>r.config.arm===a))]))
const byField=Object.fromEntries(fields.map(f=>[f,Object.fromEntries(arms.map(a=>
  [a,summary(rows.filter(r=>r.config.arm===a&&r.config.field===f))]))]))
const regimes=[]
for(const field of fields)for(const feature of [0.05,0.1,0.2,0.4])for(const tau of [0.1,M41_REFERENCE.tau,3])
  for(const dwell of [4,12])for(const noise of [0,0.01])for(const arm of arms){
    const subset=rows.filter(r=>r.config.field===field&&r.config.feature===feature&&r.config.tau===tau&&
      r.config.dwell===dwell&&r.config.noise===noise&&r.config.arm===arm)
    regimes.push({field,feature,tau,dwell,noise,arm,ratios:subset[0]!.ratios,...summary(subset)})
  }
const witnesses=['linear','cubic-reversal','uniform','zero'].flatMap(field=>arms.map(arm=>
  runM41Case({field:field as FieldKind,arm})))
const convergence=['linear','cubic-reversal','rotating-linear'].map(field=>({field,
  runs:[0.05,0.025,0.0125].map(integrationStep=>{
    const r=runM41Case({field:field as FieldKind,integrationStep})
    return {integrationStep,accepted:r.check.accepted,maximumError:r.check.maximumError,endErrorDegrees:r.endErrorDegrees}
  })}))
const limitations=[
  'Development-only manufactured fields; no transported methane and no complete source-localization missions.',
  'New fixed-pose plane reference, not a head-to-head comparison with the historical M40 sensor/kernel.',
  'Tolerance is a fixed concentration-unit engineering setting, not calibrated probabilistic confidence.',
  'No active airflow perturbation, obstacles, source declarations, methane chemistry or physical-head validation.',
  'True feature/temporal scales are offline diagnostics only, never controller inputs.',
  'Rotating temporal scale is prescribed inverse angular rate, not a measured plume correlation time.',
  'Seeds without noise duplicate deterministic evidence; do not treat these rows as independent experimental worlds.',
  'Three arms have equal elapsed time and readout count within each case, not equal distance.',
  'Initial-direction accuracy and end-of-probe gradient accuracy are separate diagnostic endpoints, not GSL success.',
  'Predictor initializes unobserved tube prehistory from its fitted stationary field, not true world state.',
]
const files=['scripts/lib/m41-spatial-check.ts','scripts/lib/m41-development.ts',
  'scripts/m41-spatial-check.test.ts','scripts/m41-local-development.ts','scripts/lib/gsl-dimensional-design.ts',
  'research/protocols/m41_spatial_prediction_development.md']
const hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex')
const report={version:'m41-development-v1',createdAt:new Date().toISOString(),developmentOnly:true,
  purpose:'Options 1 and 2 only; option 3 excluded',caseCount:rows.length,byArm,byField,regimes,witnesses,convergence,limitations}
const raw=rows.map(r=>JSON.stringify(r)).join('\n')+'\n',serialized=JSON.stringify(report,null,2)+'\n'
writeFileSync(join(directory,'trials.jsonl'),raw,{flag:'wx'})
writeFileSync(join(directory,'summary.json'),serialized,{flag:'wx'})
const manifest={sourceHashes:Object.fromEntries(files.map(f=>[f,hash(readFileSync(f))])),
  artifactHashes:{'trials.jsonl':hash(raw),'summary.json':hash(serialized)}}
writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({directory,caseCount:rows.length,byArm,witnesses:witnesses.map(r=>({
  field:r.config.field,arm:r.config.arm,initialError:r.initialErrorDegrees,endError:r.endErrorDegrees,
  accepted:r.check.accepted,predictionError:r.check.maximumError,time:r.elapsedSeconds})),convergence},null,2))
