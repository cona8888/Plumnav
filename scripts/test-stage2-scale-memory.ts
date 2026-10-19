import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {gzipSync} from 'node:zlib'
import {runHeadInspection} from './lib/si-head-motion'
import {scaleMemoryCases,scaleMemoryConfig,scaleMemoryGroups,baseSpec,runScaleMemoryHistory} from './lib/si-scale-memory'
const cases=scaleMemoryCases();assert.equal(cases.length,64)
for(const s of cases)scaleMemoryConfig(s)
for(const s of cases.filter(s=>s.variant.startsWith('similar-'))){
 const r=cases.find(r=>r.field===s.field&&r.replicate===s.replicate&&r.variant==='reference')!
 const g=scaleMemoryGroups(scaleMemoryConfig(s),s).groups,h=scaleMemoryGroups(scaleMemoryConfig(r),r).groups
 for(const key of Object.keys(g) as (keyof typeof g)[])assert.ok(Math.abs(g[key]-h[key])<1e-10,`${key} changed`)
}
const output=process.argv.includes('--output')?process.argv[process.argv.indexOf('--output')+1]:undefined
if(output)await mkdir(output)
for(const field of ['peak','si-pulse'] as const){
 const ref={...cases.find(s=>s.field===field&&s.variant==='reference')!,seed:989901,worldSeed:102991,replicate:31}
 const base=runHeadInspection(baseSpec(ref)),history=runScaleMemoryHistory(base,ref,1/64)
 if(output)await writeFile(`${output}/${field}-base.json.gz`,gzipSync(JSON.stringify(base)),{flag:'wx'})
 for(const variant of ['reference','similar-small','similar-large','similar-slow','settle-16']){
  const s={...cases.find(s=>s.field===field&&s.variant===variant)!,seed:ref.seed,worldSeed:ref.worldSeed,replicate:ref.replicate}
  const config=scaleMemoryConfig(s),f=variant==='reference'?history:runScaleMemoryHistory(base,s,1/64)
  assert.equal(f.summary.retainedSamples,85);assert.equal(f.trace.length,Math.round(f.summary.completedAt/f.dt)+1)
  if(variant.startsWith('similar-')){
   assert.equal(f.trace.length,history.trace.length)
   let error=0;for(let i=0;i<f.trace.length;i++)for(let j=16;j<24;j++)error=Math.max(error,Math.abs(f.trace[i]![j]!-history.trace[i]![j]!))
   assert.ok(error<1e-9,`Similarity development ${field}/${variant}: ${error}`)
  }
  if(variant==='settle-16')assert.equal(f.summary.completedAt,base.summary.completedAt!+136)
  if(output)await writeFile(`${output}/${field}-${variant}.json.gz`,gzipSync(JSON.stringify({spec:s,config,history:f})),{flag:'wx'})
 }
}
process.stdout.write(JSON.stringify({passed:true,developmentOnly:true,checks:['64-configurations','dimensionless-groups','freshness-separation','three-physical-scale-mappings','full-history-similarity','extended-dwell-endpoint']})+'\n')
