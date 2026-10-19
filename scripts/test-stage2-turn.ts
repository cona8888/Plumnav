import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {gzipSync} from 'node:zlib'
import {makeMotionSegment,sampleMotion,resolvedTurn} from './lib/si-turn-motion'
import {makeMotionSegment as oldMotion} from './lib/si-event-motion'
import {turnCases} from './lib/si-turn-design'
import {runTurnIntegration,replayTurnIntegration} from './lib/si-turn-integration'
import {VerifierBridge} from './lib/si-integration'
const close=(a:number,b:number,tol=1e-11)=>assert.ok(Math.abs(a-b)<=tol,`${a} != ${b}`)
const base={position:{x:.5,y:.5},heading:0,distance:0},omega=Math.PI/4,speed=.01
const decision={direction:{x:1,y:0},speedScale:1,estimate:null,confidence:0,phase:'TEST'}
const next=(v:number,up:boolean)=>{if(v===0)return up?Number.MIN_VALUE:-Number.MIN_VALUE;const a=new Float64Array([v]),b=new BigUint64Array(a.buffer);b[0]!+=((v>=0)===up)?1n:-1n;return a[0]!}
const turnFixtures:any[]=[];let ordinary=0,reversals=0
for(const h of [0,Math.PI,-Math.PI,2*Math.PI,-2*Math.PI,40*Math.PI,-40*Math.PI,1000,-1000]){
 const desired=Math.atan2(Math.sin(h+Math.PI),Math.cos(h+Math.PI))
 for(const d of [desired,next(desired,true),next(desired,false)]){
  const r=resolvedTurn(d,h);assert.ok(r.antipodalTie);assert.equal(r.delta,Math.PI);turnFixtures.push({desired:d,heading:h,...r})
 }
}
for(const x of [Math.PI,-Math.PI,next(Math.PI,true),next(Math.PI,false),next(-Math.PI,true),next(-Math.PI,false)]){
 const r=resolvedTurn(x,0);assert.ok(r.antipodalTie);assert.equal(r.delta,Math.PI);turnFixtures.push({desired:x,heading:0,...r})
}
for(const offset of [-1e-8,1e-8]){const r=resolvedTurn(Math.PI+offset,0);assert.ok(!r.antipodalTie);assert.equal(Math.sign(r.delta),-Math.sign(offset));turnFixtures.push({desired:Math.PI+offset,heading:0,...r})}
assert.throws(()=>resolvedTurn(0,1024.01));assert.throws(()=>resolvedTurn(NaN,0))
for(const degrees of [-137,-53,0,17,53,137,359])for(const dt of [1/16,1/32,1/64,1/128]){
 const p={...base,heading:degrees*Math.PI/180},old=oldMotion(p,decision,0,dt,speed,omega,.04),now=makeMotionSegment(p,decision,0,dt,speed,omega,.04)
 const {antipodalTie,angularTolerance,...rest}=now;assert.equal(antipodalTie,false);assert.deepEqual({...rest,version:old.version},old);ordinary++
}
for(const dt of [1/16,1/32,1/64,1/128]){
 let pose=structuredClone(base)
 for(let cycle=0;cycle<4;cycle++){
  const start=cycle*5,target=pose.heading+Math.PI,d={...decision,direction:{x:Math.cos(target),y:Math.sin(target)}}
  const first=makeMotionSegment(pose,d,start,dt,speed,omega,.04);assert.ok(first.antipodalTie);assert.equal(first.angularVelocity,omega)
  const initial=structuredClone(pose)
  for(let i=0;i<5/dt;i++){
   const t=start+i*dt,s=makeMotionSegment(pose,d,t,dt,speed,omega,.04)
   assert.ok(s.angularVelocity>=0||s.turnSeconds<1e-10)
   const middle=sampleMotion(s,t+dt/2),end=sampleMotion(s,t+dt)
   if(i*dt<4-1e-10){close(middle.position.x,initial.position.x);close(middle.position.y,initial.position.y)}
   pose=end
  }
  close(pose.heading,target);close(pose.distance-initial.distance,.01);reversals++
 }
}
const partial=makeMotionSegment({...base,heading:omega*.04},decision,0,.0625,speed,omega,.04)
close(sampleMotion(partial,.04).position.x,.5);close(sampleMotion(partial,.0625).position.x,.500225)
assert.deepEqual(sampleMotion(makeMotionSegment(base,decision,0,1,speed,omega,.04,true),1),base)
assert.deepEqual(sampleMotion(makeMotionSegment(base,{...decision,direction:{x:0,y:0}},0,1,speed,omega,.04),1),base)
const zero=makeMotionSegment({...base,heading:Math.PI/2},{...decision,speedScale:0},0,3,speed,omega,.04);close(sampleMotion(zero,3).heading,0);close(sampleMotion(zero,3).position.x,.5)
const wall=makeMotionSegment({...base,position:{x:.959,y:.5}},decision,0,1,speed,omega,.04);assert.ok(wall.wallLimited);close(sampleMotion(wall,1).position.x,.96)
assert.throws(()=>sampleMotion(partial,-.001));assert.throws(()=>sampleMotion(partial,.1))
assert.throws(()=>makeMotionSegment({...base,heading:1025},decision,0,1,speed,omega,.04,true))
const channels=(h:number)=>[0,-Math.PI/2,Math.PI,Math.PI/2].map(a=>1+.15*Math.cos(h+a)+.1*Math.sin(h+a)),a=channels(0),b=channels(Math.PI)
close(a.reduce((x,y)=>x+y)/4,b.reduce((x,y)=>x+y)/4);assert.ok(Math.max(...a.map((v,i)=>Math.abs(v-b[i]!)))>.29)
assert.equal(turnCases('turn-diagnostic').length,36);assert.equal(turnCases('turn-fresh').length,72)
if(!process.argv.includes('--output'))throw Error('Exclusive output required')
const output=process.argv[process.argv.indexOf('--output')+1]!;await mkdir(output)
await writeFile(`${output}/turn-fixtures.json`,JSON.stringify({ordinary,reversals,turnFixtures},null,2)+'\n',{flag:'wx'})
const bridge=new VerifierBridge(),inventory:any[]=[],blanks:any[]=[]
try{
 for(const [index,field,navDt,peak] of [[0,'blank',1/16,false],[1,'blank',1/32,false],[2,'blank',1/64,false],[3,'si-continuous',1/16,true],[4,'si-pulse',1/16,false]] as const){
  const spec={...turnCases('turn-fresh').find(s=>s.policy==='encounter-gated')!,index,field,navDt,worldIndex:999,replicate:299,worldSeed:135991,sourceSeed:136991,startSeed:137991,controllerSeed:138991}
  const r=await runTurnIntegration(spec,bridge,{startAtSource:field!=='blank',acquisitionSeconds:16,analyticPeak:peak}),replay=replayTurnIntegration(r);assert.ok(replay.passed)
  if(field==='blank'){assert.equal(r.nomination,null);assert.ok(r.segments.every(s=>!s.held));blanks.push(r)}
  else{assert.equal(r.summary.stage,'inspection-complete');assert.equal(r.summary.retainedSamples,85)}
  const file=`case-${index}.json.gz`;await writeFile(`${output}/${file}`,gzipSync(JSON.stringify(r)),{flag:'wx'});inventory.push({file,replay,summary:r.summary,antipodalTies:r.segments.filter(s=>s.antipodalTie).length})
 }
 for(const r of blanks){assert.deepEqual(r.controls,blanks[0].controls);assert.deepEqual(r.segments,blanks[0].segments)}
 await writeFile(`${output}/complete.json`,JSON.stringify({complete:true,developmentOnly:true,ordinary,reversals,turnFixtures:turnFixtures.length,blankBitIdentical:true,inventory},null,2)+'\n',{flag:'wx'})
 process.stdout.write(`PASS ${ordinary} exact ordinary segments, ${reversals} repeated reversals, ${turnFixtures.length} boundary fixtures, 5 missions and public replays\n`)
}finally{bridge.close()}
