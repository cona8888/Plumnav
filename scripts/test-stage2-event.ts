import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {gzipSync} from 'node:zlib'
import {makeMotionSegment,sampleMotion} from './lib/si-event-motion'
import {eventCases,runEventIntegration,PassiveScanClock} from './lib/si-event-integration'
import {integrationConfig,VerifierBridge,replayIntegration} from './lib/si-integration'
const close=(a:number,b:number,tol=1e-12)=>assert.ok(Math.abs(a-b)<=tol,`${a} != ${b}`)
const decision={direction:{x:1,y:0},speedScale:1,estimate:null,confidence:0,phase:'TEST'}
const initial={position:{x:.5,y:.5},heading:0,distance:0},omega=Math.PI/4,speed=.01
let motionCases=0
for(const degrees of [-137,-53,0,17,53,137,359])for(const dt of [1/16,1/32,1/64,1/128]){
 let pose={...initial,heading:degrees*Math.PI/180}
 for(let i=0;i<4/dt;i++)pose=sampleMotion(makeMotionSegment(pose,decision,i*dt,dt,speed,omega,.04), (i+1)*dt)
 const angle=Math.abs(Math.atan2(Math.sin(degrees*Math.PI/180),Math.cos(degrees*Math.PI/180))),distance=speed*Math.max(0,4-angle/omega)
 close(pose.position.x,.5+distance);close(pose.position.y,.5);close(pose.distance,distance);motionCases++
}
const partial=makeMotionSegment({...initial,heading:omega*.04},decision,0,.0625,speed,omega,.04)
close(sampleMotion(partial,.02).position.x,.5);close(sampleMotion(partial,.04).position.x,.5);close(sampleMotion(partial,.0625).position.x,.5+speed*.0225)
const held=makeMotionSegment({...initial,heading:1},decision,0,1,speed,omega,.04,true)
assert.deepEqual(sampleMotion(held,1),{...initial,heading:1})
const zero=makeMotionSegment({...initial,heading:.2},{...decision,speedScale:0},0,1,speed,omega,.04)
close(sampleMotion(zero,1).heading,0);close(sampleMotion(zero,1).position.x,.5)
const directionless=makeMotionSegment({...initial,heading:1},{...decision,direction:{x:0,y:0}},0,1,speed,omega,.04)
assert.deepEqual(sampleMotion(directionless,1),{...initial,heading:1})
const wall=makeMotionSegment({...initial,position:{x:.959,y:.5}},decision,0,1,speed,omega,.04)
assert.ok(wall.wallLimited);close(sampleMotion(wall,1).position.x,.96);close(sampleMotion(wall,1).distance,.001)
assert.throws(()=>sampleMotion(partial,-.01));assert.throws(()=>sampleMotion(partial,.07))
assert.throws(()=>makeMotionSegment({...initial,position:{x:0,y:0}},decision,0,1,speed,omega,.04))
const s=eventCases('old-world-diagnostic')[6]!,c=integrationConfig(s),clock=new PassiveScanClock(c,()=>false)
const m=clock.measurement(.0625,initial,[.2,.3,.4,.5])
assert.ok(clock.consumeAndCommand(m,{...decision,quadSniff:{scanId:12,forward:{x:1,y:0},strength:1}},initial))
assert.equal(clock.measurement(12.0625,initial,[.2,.3,.4,.5]).sampleMode,'blanked')
const returned=clock.measurement(13,initial,[.2,.3,.4,.5]);assert.equal(returned.sampleMode,'quad-passive-return');assert.equal(returned.quadSniff?.strength,0)
assert.equal(returned.quadSniff?.samplingMode,'passive-array');assert.equal(returned.quadSniff?.readings?.length,4)
assert.equal(clock.consumeAndCommand(returned,{...decision,quadSniff:{scanId:12,forward:{x:1,y:0}}},initial),false)
assert.equal(clock.measurement(13.0625,initial,[.2,.3,.4,.5]).sampleMode,'passive')
const output=process.argv[process.argv.indexOf('--output')+1];if(!process.argv.includes('--output'))throw Error('Exclusive output required');await mkdir(output)
const bridge=new VerifierBridge(),summaries:any[]=[],blankRecords:any[]=[]
try{
 for(const [i,field,method,peak,navDt] of [[0,'si-continuous','quad-sniff-refine',true,1/16],[1,'blank','surge-cast',false,1/16],[2,'blank','surge-cast',false,1/32],[3,'blank','surge-cast',false,1/64],[4,'si-pulse','surge-cast',false,1/16]] as const){
  const spec={...s,index:i,field,method,navDt,worldSeed:111991,sourceSeed:112991,startSeed:113991,controllerSeed:114991,replicate:31}
  const r=await runEventIntegration(spec,bridge,{startAtSource:field!=='blank',acquisitionSeconds:16,analyticPeak:peak})
  assert.ok(replayIntegration(r).passed)
  if(peak){assert.equal(r.summary.stage,'inspection-complete');assert.equal(r.summary.retainedSamples,85)}
  if(field==='blank'){assert.equal(r.nomination,null);blankRecords.push(r)}
  await writeFile(`${output}/case-${i}.json.gz`,gzipSync(JSON.stringify(r)),{flag:'wx'});summaries.push({index:i,...r.summary})
 }
 for(const r of blankRecords){assert.deepEqual(r.controls,blankRecords[0].controls);assert.deepEqual(r.segments,blankRecords[0].segments)}
 await writeFile(`${output}/complete.json`,JSON.stringify({complete:true,developmentOnly:true,motionCases,blankBitIdentical:true,summaries},null,2)+'\n',{flag:'wx'})
 process.stdout.write(JSON.stringify({passed:true,motionCases,blankBitIdentical:true,summaries})+'\n')
}finally{bridge.close()}
