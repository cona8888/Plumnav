import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {gzipSync} from 'node:zlib'
import {linearCases} from './lib/si-linear-design'
import {runLinearIntegration,replayLinearIntegration} from './lib/si-linear-integration'
import {runTurnIntegration} from './lib/si-turn-integration'
import {VerifierBridge} from './lib/si-integration'
assert.equal(linearCases('linear-diagnostic').length,36);assert.equal(linearCases('linear-fresh').length,144)
const output='research/evidence/si_linear_development_2026-09-17';await mkdir(output)
const bridge=new VerifierBridge(),inventory:any[]=[],blanks:any[]=[]
try{
 for(const [index,field,navDt,peak] of [[0,'blank',1/16,false],[1,'blank',1/32,false],[2,'blank',1/64,false],[3,'si-continuous',1/16,true],[4,'si-pulse',1/16,false]] as const){
  const spec={...linearCases('linear-fresh').find(s=>s.policy==='encounter-gated')!,index,field,navDt,worldIndex:999,replicate:399,worldSeed:145991,sourceSeed:146991,startSeed:147991,controllerSeed:148991}
  const development={startAtSource:field!=='blank',acquisitionSeconds:16,analyticPeak:peak},r=await runLinearIntegration(spec,bridge,development),replay=replayLinearIntegration(r);assert.ok(replay.passed)
  if(field==='blank'){
   assert.equal(r.nomination,null);assert.ok(r.segments.every(s=>!s.held));blanks.push(r)
   if(index===0){const old=await runTurnIntegration({...spec,panel:'turn-fresh'},bridge,development);assert.equal(JSON.stringify(r.controls),JSON.stringify(old.controls));assert.equal(JSON.stringify(r.segments),JSON.stringify(old.segments));assert.equal(JSON.stringify(r.trace),JSON.stringify(old.trace))}
  }else{assert.equal(r.summary.stage,'inspection-complete');assert.equal(r.summary.retainedSamples,85)}
  const file=`case-${index}.json.gz`;await writeFile(`${output}/${file}`,gzipSync(JSON.stringify(r)),{flag:'wx'});inventory.push({file,replay,summary:r.summary})
 }
 for(const r of blanks){assert.deepEqual(r.controls,blanks[0].controls);assert.deepEqual(r.segments,blanks[0].segments)}
 await writeFile(`${output}/complete.json`,JSON.stringify({complete:true,developmentOnly:true,blankBitIdentical:true,blankMatchesHeldInput:true,inventory},null,2)+'\n',{flag:'wx'})
 process.stdout.write('PASS 5 development histories/replays, exact blank mesh and held-input equivalence\n')
}finally{bridge.close()}
