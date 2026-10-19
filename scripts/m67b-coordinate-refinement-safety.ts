import { mkdir, writeFile } from 'node:fs/promises'; import { resolve } from 'node:path'
import { runBatch, batchResultsToCsv } from '../src/sim/batch'; import { createDefaultConfig,SIMULATOR_VERSION } from '../src/sim/config'
import type { AlgorithmId,BatchResult,ScenarioKind,TargetStatus } from '../src/sim/types'
const algorithms:AlgorithmId[]=['quad-sniff-wind','quad-sniff-refine'],scenarios:ScenarioKind[]=['open','obstructed']
const statuses:TargetStatus[]=['zero-emission','absent'],replicates=30,rows:Array<{status:TargetStatus;result:BatchResult}>=[];let block=0
const output=resolve('research/evidence/m67b_coordinate_refinement_safety_2026-09-12')
for(const status of statuses)for(const scenario of scenarios){const c=createDefaultConfig('quad-sniff-wind',scenario)
c.seed=68_000_000+block*1_000_003;c.sourceSeed=68_000_017+block*1_000_033;c.controllerSeed=68_000_029+block*1_000_037;c.observationModelSeed=68_000_043+block*1_000_081
c.targetStatus=status;c.checkpointSeconds=[180];c.stopOnNativeDeclaration=false
const b=await runBatch(c,algorithms,[scenario],replicates);rows.push(...b.results.map(result=>({status,result})));block++;process.stdout.write(`completed ${block}/4: ${status}/${scenario}\n`)}
const groups=new Map<string,typeof rows>();for(const r of rows){const k=`${r.status}|${r.result.scenarioKind}|${r.result.algorithmId}`;groups.set(k,[...(groups.get(k)??[]),r])}
const summary=[...groups].map(([key,g])=>({key,runs:g.length,spuriousDeclarations:g.filter(x=>x.result.metrics.terminalOutcome==='spurious-declaration').length,
nativeAbstentions:g.filter(x=>x.result.metrics.nativeAbstention).length,correctRejections:g.filter(x=>x.result.metrics.correctRejection).length}))
await mkdir(output,{recursive:true});await writeFile(resolve(output,'manifest.json'),`${JSON.stringify({schemaVersion:'m67b-safety-v1',simulatorVersion:SIMULATOR_VERSION,
protocol:'research/protocols/m67b_coordinate_refinement_safety_protocol.md',algorithms,statuses,scenarios,replicates,plannedRuns:rows.length,seedBase:68_000_000},null,2)}\n`)
await writeFile(resolve(output,'summary.json'),`${JSON.stringify(summary,null,2)}\n`);const csv=batchResultsToCsv(rows.map(x=>x.result)),[h,...l]=csv.split('\n')
await writeFile(resolve(output,'results.csv'),`safety_condition,${h}\n${rows.map((x,i)=>`${x.status},${l[i]}`).join('\n')}\n`);process.stdout.write(`${JSON.stringify({output,runs:rows.length})}\n`)
