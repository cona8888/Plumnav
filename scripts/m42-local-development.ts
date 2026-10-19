import {mkdirSync,writeFileSync,readFileSync,copyFileSync,constants} from 'node:fs'
import {resolve,join,dirname} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {runM42Case,M42_ARMS,type M42Arm} from './lib/m42-development'
import {runM41Case,M41_REFERENCE,type FieldKind} from './lib/m41-development'

const output=process.argv[2]
if(!output)throw new Error('Supply a new development output directory')
const directory=resolve(output);mkdirSync(directory,{recursive:false})
// Full historical regression, not just the favorable reference witness.
const legacy=readFileSync('research/results/m41-spatial-prediction-development-v1/trials.jsonl','utf8').trim().split('\n').map(s=>JSON.parse(s))
for(const old of legacy)assert.deepEqual(JSON.parse(JSON.stringify(runM41Case(old.config))),old)
console.log(`Historical M41 default replay unchanged: ${legacy.length} rows`)

type Row=ReturnType<typeof runM42Case>
const summarize=(rs:Row[])=>{
  const accepted=rs.filter(r=>r.check.accepted),scorable=accepted.filter(r=>r.endErrorDegrees!==null)
  const wrong=scorable.filter(r=>r.endErrorDegrees!>45)
  return {rows:rs.length,initialAccepted:rs.filter(r=>r.baselineAccepted).length,accepted:accepted.length,
    acceptedScorable:scorable.length,acceptedWrongAtEnd:wrong.length,
    acceptedWithoutGradient:accepted.length-scorable.length,
    acceptanceFraction:accepted.length/rs.length,wrongFractionAmongScorableAccepted:scorable.length?wrong.length/scorable.length:null,
    meanTime:rs.reduce((s,r)=>s+r.elapsedSeconds,0)/rs.length,meanDistance:rs.reduce((s,r)=>s+r.distanceMetres,0)/rs.length}
}
const rows:Row[]=[]
const fields:FieldKind[]=['linear','cubic-reversal','rotating-linear','uniform','zero']
for(const field of fields)for(const feature of [.1,.2])for(const tau of [M41_REFERENCE.tau,3])
  for(const dwell of [4,12])for(const noise of [0,.01])for(const fieldAngle of [0,Math.PI/8,Math.PI/4,Math.PI/2])
    for(const correlationTime of field==='rotating-linear'?[5,20,80]:[20])for(let seed=101;seed<=116;seed++)
      for(const arm of M42_ARMS)rows.push(runM42Case({field,feature,tau,dwell,noise,fieldAngle,correlationTime,seed},arm))
assert.equal(rows.length,43008)
const byArm=Object.fromEntries(M42_ARMS.map(a=>[a,summarize(rows.filter(r=>r.arm===a))]))
const byField=Object.fromEntries(fields.map(f=>[f,Object.fromEntries(M42_ARMS.map(a=>[a,summarize(rows.filter(r=>r.arm===a&&r.config.field===f))]))]))
const groups=new Map<string,Row[]>()
for(const r of rows){
  const {seed,...config}=r.config
  const key=JSON.stringify({...config,arm:r.arm})
  const g=groups.get(key)??[];g.push(r);groups.set(key,g)
}
const regimes=[...groups.values()].map(rs=>({arm:rs[0]!.arm,config:{...rs[0]!.config,seed:undefined},ratios:rs[0]!.ratios,...summarize(rs)}))
const stress:Row[]=[]
for(const field of ['uniform','zero'] as const)for(let seed=50001;seed<=51000;seed++){
  stress.push(runM42Case({field,seed,noise:.01},'fixed-directed'))
  for(const factor of [.5,1,2])stress.push(runM42Case({field,seed,noise:.01},'gated-balanced',factor))
}
const stressSummary=[]
for(const field of ['uniform','zero'])for(const [arm,factor] of [
  ['fixed-directed',1],['gated-balanced',.5],['gated-balanced',1],['gated-balanced',2]] as [M42Arm,number][])
  stressSummary.push({field,arm,calibrationFactor:factor,...summarize(stress.filter(r=>r.config.field===field&&r.arm===arm&&r.calibrationFactor===factor))})
const headingSample=rows.filter(r=>r.arm==='gated-random'&&r.config.field==='linear'&&r.config.feature===.1&&
  r.config.tau===M41_REFERENCE.tau&&r.config.dwell===12&&r.config.noise===0&&r.config.fieldAngle===0).map(r=>r.randomAngle)
const report={version:'m42-development-v2',createdAt:new Date().toISOString(),developmentOnly:true,
  correction:'v1 regime grouping accidentally overwrote the M42 arm with the underlying M41 arm. v2 fixes grouping only; raw trial results must match v1.',
  historicalM41RowsReplayed:legacy.length,caseCount:rows.length,stressCount:stress.length,byArm,byField,regimes,stressSummary,
  headingAudit:{radians:headingSample,quadrants:[...new Set(headingSample.map(a=>Math.floor(a/(Math.PI/2))))],
    spanDegrees:(Math.max(...headingSample)-Math.min(...headingSample))*180/Math.PI},
  limitations:[
    'Manufactured-field development, not full GSL or methane validation; correlated and deterministic duplicates remain.',
    'Gaussian bounds apply to fixed-window independent calibrated readout noise, not spatial-model mismatch or sequential decisions.',
    'Balanced probes use finite cubic alternatives and can reduce to fixed diagonal geometry, not a fully adaptive planner.',
    'Unknown tube prehistory and later prediction tolerance remain approximate; high rejection has mission costs not evaluated here.',
    'M41 random-heading screen was clustered and is superseded for random-comparator interpretation, not deleted.',
    'M42 uses new seeds and rotated fields but is development, not a sealed confirmatory test.',
    'Probe policies receive observations/geometry/calibration only; field scales and angles are evaluator inputs.',
  ]}
const hash=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex')
const artifacts={'trials.jsonl':rows.map(r=>JSON.stringify(r)).join('\n')+'\n',
  'noise-stress.jsonl':stress.map(r=>JSON.stringify(r)).join('\n')+'\n','summary.json':JSON.stringify(report,null,2)+'\n'}
for(const [f,s] of Object.entries(artifacts))writeFileSync(join(directory,f),s,{flag:'wx'})
for(const f of ['trials.jsonl','noise-stress.jsonl'])
  assert.equal(hash(artifacts[f as keyof typeof artifacts]),hash(readFileSync(join('research/results/m42-noise-probe-development-v1',f))))
const files=['scripts/lib/m41-spatial-check.ts','scripts/lib/m41-development.ts','scripts/lib/gsl-dimensional-design.ts',
  'scripts/lib/m42-noise-probe.ts','scripts/lib/m42-development.ts','scripts/m42-noise-probe.test.ts',
  'scripts/m42-local-development.ts','scripts/m42-verify.ts','research/protocols/m42_noise_and_probe_development.md']
const sourceHashes:Record<string,string>={}
for(const f of files){
  sourceHashes[f]=hash(readFileSync(f));const target=join(directory,'source-snapshot',f)
  mkdirSync(dirname(target),{recursive:true});copyFileSync(f,target,constants.COPYFILE_EXCL)
}
writeFileSync(join(directory,'manifest.json'),JSON.stringify({sourceHashes,
  artifactHashes:Object.fromEntries(Object.entries(artifacts).map(([f,s])=>[f,hash(s)]))},null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({directory,caseCount:rows.length,stressCount:stress.length,byArm,stressSummary,headingAudit:report.headingAudit},null,2))
