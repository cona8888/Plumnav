import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {gzipSync,gunzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {EventInstrument} from './lib/si-event-integration'
import {sampleMotion,type MotionSegment} from './lib/si-turn-motion'
import {stage1iSha256 as sha} from './lib/stage1i-campaign-design'
const root='research/evidence/si_turn_fresh_2026-09-17',output='research/evidence/si_turn_fixed_path_diagnosis_2026-09-17',index=59,dir=`${root}/worker-${index%4}`
const inventory=JSON.parse(await readFile(`${dir}/complete.json`,'utf8')).inventory,item=inventory.find((r:any)=>r.index===index),raw=await readFile(`${dir}/${item.file}`);assert.equal(sha(raw),item.sha256)
const record=JSON.parse(gunzipSync(raw).toString()),segments=record.segments as MotionSegment[],histories:any[]=[]
await mkdir(output)
for(const dt of [1/64,1/128,1/256]){
 const engine=new SimulationEngine(record.config),instrument=new EventInstrument(record.config,engine.plume.concentrationAt.bind(engine.plume),dt,record.spec.worldSeed+3000000)
 instrument.advance(record.summary.completedAt,t=>sampleMotion(segments[Math.max(0,Math.ceil(t*16)-1)]!,t))
 const sameAsFrozenFinest=dt===1/256?JSON.stringify(instrument.trace)===JSON.stringify(record.trace):null
 if(dt===1/256)assert.ok(sameAsFrozenFinest)
 const body=gzipSync(JSON.stringify({postHoc:true,autonomousMission:false,fixedPathRawSha256:sha(raw),config:record.config,spec:record.spec,sensorDt:dt,trace:instrument.trace})),file=`sensor-${Math.round(1/dt)}.json.gz`
 await writeFile(`${output}/${file}`,body,{flag:'wx'});histories.push({file,sensorDt:dt,sha256:sha(body),traceRows:instrument.trace.length,bytes:body.length,sameAsFrozenFinest})
 process.stdout.write(`Fixed-path sensor dt ${dt}: ${instrument.trace.length} rows; exact finest replay ${sameAsFrozenFinest}\n`)
}
await writeFile(`${output}/complete.json`,JSON.stringify({complete:true,postHoc:true,doesNotOverrideAcceptance:true,autonomousMission:false,canonicalRawFile:`${dir}/${item.file}`,canonicalRawSha256:sha(raw),sourceSha256:sha(await readFile('scripts/diagnose-stage2-turn-open-loop.ts')),bundleSha256:sha(await readFile('outputs/diagnose-stage2-turn-open-loop.mjs')),histories},null,2)+'\n',{flag:'wx'})
