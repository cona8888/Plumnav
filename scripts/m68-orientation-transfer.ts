import {mkdir,readFile,writeFile} from 'node:fs/promises';import{resolve}from'node:path'
import{runBatch,batchResultsToCsv}from'../src/sim/batch';import{createDefaultConfig,SIMULATOR_VERSION}from'../src/sim/config'
import type{AlgorithmId,BatchResult,ScenarioKind}from'../src/sim/types'
const algorithms:AlgorithmId[]=['quad-sniff-wind','quad-sniff-refine'],scenarios:ScenarioKind[]=['open','obstructed'],directions=[0,90,180,270],replicates=12
const contract=JSON.parse(await readFile('research/protocols/m60_soil_regimes/soil-regime-contract.json','utf8'))as{cases:Array<{case_id:string;emission_scale_relative_to_sand_sw_0p2:number}>}
const soils=contract.cases.filter(x=>x.case_id==='sand-sw-0p2'||x.case_id==='sand-sw-0p5'),rows:Array<{cell:string;result:BatchResult}>=[];let block=0
const started=Date.now(),output=resolve('research/evidence/m68_orientation_transfer_2026-09-12')
for(const soil of soils)for(const scenario of scenarios)for(const direction of directions){const c=createDefaultConfig('quad-sniff-wind',scenario)
c.seed=68_800_000+block*1_000_003;c.sourceSeed=68_800_017+block*1_000_033;c.controllerSeed=68_800_029+block*1_000_037;c.observationModelSeed=68_800_043+block*1_000_081
c.emissionRateScale=soil.emission_scale_relative_to_sand_sw_0p2;c.windDirectionDegrees=direction;c.checkpointSeconds=[180];c.stopOnNativeDeclaration=false
const b=await runBatch(c,algorithms,[scenario],replicates),cell=`${soil.case_id}|${scenario}|wind-${direction}`;rows.push(...b.results.map(result=>({cell,result})));block++;process.stdout.write(`completed ${block}/16: ${cell}\n`)}
const groups=new Map<string,typeof rows>();for(const r of rows){const k=`${r.cell}|${r.result.algorithmId}`;groups.set(k,[...(groups.get(k)??[]),r])}
const summary=[...groups].map(([key,g])=>{const e=g.map(x=>x.result.metrics.normalizedError??Math.SQRT2).sort((a,b)=>a-b);return{key,runs:g.length,
correct:g.filter(x=>x.result.metrics.terminalOutcome==='correct-declaration').length,wrong:g.filter(x=>x.result.metrics.terminalOutcome==='wrong-declaration').length,
proximity:g.filter(x=>x.result.metrics.success).length,medianError:e[Math.floor(e.length/2)],p90Error:e[Math.floor((e.length-1)*.9)]}})
await mkdir(output,{recursive:true});await writeFile(resolve(output,'manifest.json'),`${JSON.stringify({schemaVersion:'m68-orientation-v1',simulatorVersion:SIMULATOR_VERSION,
protocol:'research/protocols/m68_orientation_transfer_protocol.md',algorithms,soils:soils.map(x=>x.case_id),scenarios,directions,replicates,plannedRuns:rows.length,seedBase:68_800_000},null,2)}\n`)
await writeFile(resolve(output,'summary.json'),`${JSON.stringify(summary,null,2)}\n`);const csv=batchResultsToCsv(rows.map(x=>x.result)),[h,...l]=csv.split('\n');await writeFile(resolve(output,'results.csv'),`m68_cell,${h}\n${rows.map((x,i)=>`${x.cell},${l[i]}`).join('\n')}\n`)
await writeFile(resolve(output,'timing.json'),`${JSON.stringify({wallSeconds:(Date.now()-started)/1000,runs:rows.length},null,2)}\n`);process.stdout.write(`${JSON.stringify({output,runs:rows.length,wallSeconds:(Date.now()-started)/1000})}\n`)
