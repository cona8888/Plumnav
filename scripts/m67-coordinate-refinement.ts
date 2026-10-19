import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runBatch, batchResultsToCsv } from '../src/sim/batch'
import { createDefaultConfig, SIMULATOR_VERSION } from '../src/sim/config'
import { QUAD_REFINE_POLICY } from '../src/sim/algorithms/quadSoilSniff'
import type { AlgorithmId, BatchResult, ScenarioKind } from '../src/sim/types'

const algorithms: AlgorithmId[] = ['quad-sniff-wind', 'quad-sniff-refine']
const scenarios: ScenarioKind[] = ['open', 'obstructed']; const replicates = 30
const output = resolve('research/evidence/m67_coordinate_refinement_2026-09-12')
const contract = JSON.parse(await readFile('research/protocols/m60_soil_regimes/soil-regime-contract.json','utf8')) as
  { cases: Array<{case_id:string; emission_scale_relative_to_sand_sw_0p2:number}> }
const soils = contract.cases.filter(x => x.case_id==='sand-sw-0p2'||x.case_id==='sand-sw-0p5')
const rows: Array<{soil:string; result:BatchResult}> = []; let block=0
for (const soil of soils) for (const scenario of scenarios) {
  const c=createDefaultConfig('quad-sniff-wind',scenario)
  c.seed=67_000_000+block*1_000_003; c.sourceSeed=67_000_017+block*1_000_033
  c.controllerSeed=67_000_029+block*1_000_037; c.observationModelSeed=67_000_043+block*1_000_081
  c.emissionRateScale=soil.emission_scale_relative_to_sand_sw_0p2
  c.checkpointSeconds=[180]; c.stopOnNativeDeclaration=false
  const batch=await runBatch(c,algorithms,[scenario],replicates)
  rows.push(...batch.results.map(result=>({soil:soil.case_id,result}))); block++
  process.stdout.write(`completed ${block}/4: ${soil.case_id}/${scenario}\n`)
}
const groups=new Map<string,typeof rows>()
for(const row of rows){const k=`${row.soil}|${row.result.scenarioKind}|${row.result.algorithmId}`;groups.set(k,[...(groups.get(k)??[]),row])}
const summary=[...groups].map(([key,g])=>{const e=g.map(x=>x.result.metrics.normalizedError??Math.SQRT2).sort((a,b)=>a-b);return{
  key,runs:g.length,correctDeclarations:g.filter(x=>x.result.metrics.terminalOutcome==='correct-declaration').length,
  wrongDeclarations:g.filter(x=>x.result.metrics.terminalOutcome==='wrong-declaration').length,
  proximitySuccesses:g.filter(x=>x.result.metrics.success).length,medianError:e[Math.floor(e.length/2)],p90Error:e[Math.floor((e.length-1)*.9)]}})
await mkdir(output,{recursive:true})
await writeFile(resolve(output,'manifest.json'),`${JSON.stringify({schemaVersion:'m67-coordinate-refinement-v1',simulatorVersion:SIMULATOR_VERSION,
  protocol:'research/protocols/m67_coordinate_refinement_protocol.md',partition:'development; disjoint M61-M66 seeds',algorithms,
  soils:soils.map(x=>x.case_id),scenarios,replicates,plannedRuns:rows.length,seedBase:67_000_000,refinePolicy:QUAD_REFINE_POLICY},null,2)}\n`)
await writeFile(resolve(output,'summary.json'),`${JSON.stringify(summary,null,2)}\n`)
const csv=batchResultsToCsv(rows.map(x=>x.result)),[header,...lines]=csv.split('\n')
await writeFile(resolve(output,'results.csv'),`soil_case_id,${header}\n${rows.map((x,i)=>`${x.soil},${lines[i]}`).join('\n')}\n`)
process.stdout.write(`${JSON.stringify({output,completedRuns:rows.length})}\n`)
