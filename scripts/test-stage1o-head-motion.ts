import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {gzipSync} from 'node:zlib'
import {headCases,headConfig,headMotion,inletPoint,runHeadInspection,refineHeadHistory} from './lib/si-head-motion'

const cases=headCases();assert.equal(cases.length,192)
const spec={...cases[0]!,seed:969901,worldSeed:100991,replicate:11}
const mode={...spec,mode:3}
for(let age=0;age<=12;age++)assert.ok(Math.abs(headMotion(mode,0,20+age,20).offsetMetres.x)<1e-15)
assert.ok(Math.abs(Math.hypot(...Object.values(headMotion(mode,0,20.25,20).offsetMetres))-.01)<1e-14)
assert.equal(Math.hypot(...Object.values(headMotion(mode,0,19,20).offsetMetres)),0)
const point={x:.7,y:.3};assert.deepEqual(inletPoint(point,{x:.5,y:.5},{x:0,y:0},0,100),point)
const rotated=inletPoint({x:.6,y:.5},{x:.5,y:.5},{x:0,y:0},Math.PI/2,100)
assert.ok(Math.abs(rotated.x-.5)<1e-15&&Math.abs(rotated.y-.6)<1e-15)
const stationary=runHeadInspection(spec),reference=runHeadInspection(spec,true)
for(const key of ['visits','actualSamples','result','summary'] as const)assert.deepEqual(stationary[key],reference[key])
const moving=runHeadInspection(mode)
assert.deepEqual(stationary.actualTargets,moving.actualTargets)
assert.equal(stationary.summary.completedAt,moving.summary.completedAt)
assert.equal(stationary.trace.length,moving.trace.length)
assert.ok(moving.trace.some((row,i)=>Math.abs(row[16]!-stationary.trace[i]![16]!)>1e-4))
const fine=refineHeadHistory(moving,.03125)
assert.equal(fine.trace.length,2*moving.trace.length-1)
const siRecords=(['si-continuous','si-pulse'] as const).map(field=>runHeadInspection({...spec,field,phaseSeconds:field==='si-pulse'?5:0,mode:5}))
const out=process.argv[process.argv.indexOf('--output')+1]
if(process.argv.includes('--output')){
 await mkdir(out!)
 await writeFile(`${out}/stationary.json.gz`,gzipSync(JSON.stringify(stationary)),{flag:'wx'})
 await writeFile(`${out}/moving.json.gz`,gzipSync(JSON.stringify({...moving,refinements:[fine]})),{flag:'wx'})
 await writeFile(`${out}/config.json`,JSON.stringify(headConfig(spec),null,2)+'\n',{flag:'wx'})
 for(const record of siRecords){
  await writeFile(`${out}/${record.spec.field}.json.gz`,gzipSync(JSON.stringify(record)),{flag:'wx'})
  await writeFile(`${out}/${record.spec.field}-config.json`,JSON.stringify(headConfig(record.spec),null,2)+'\n',{flag:'wx'})
 }
}
process.stdout.write(JSON.stringify({passed:true,checks:['case-count','1Hz-aliasing-law','between-sample-motion','inactive-motion','identity-map','rotation-geometry','zero-motion-unwrapped-equivalence','matched-body-path','changed-physical-inlet-concentration','refinement-clock'],developmentOnly:true})+'\n')
