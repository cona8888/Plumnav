import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {LinearInletChannel,linearResponse} from './lib/si-linear-inlet'
import {integrationConfig} from './lib/si-integration'
import {turnCases} from './lib/si-turn-design'
const base=integrationConfig(turnCases('turn-fresh')[0]!).localInletSampling!
const settings=(delay:number,window:number)=>({...base,tubeLengthMetres:delay*(base.flowLitresPerMinutePerChannel/60000)/(Math.PI*(base.tubeInnerDiameterMetres/2)**2),averagingSeconds:window,riseTimeConstantSeconds:.5,recoveryTimeConstantSeconds:2})
const close=(a:number,b:number,tolerance=1e-10)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`)
const fixtures:any[]=[]
for(const delay of [0,.271,base.tubeLengthMetres*Math.PI*(base.tubeInnerDiameterMetres/2)**2/(base.flowLitresPerMinutePerChannel/60000)])for(const window of [0,1])for(const kind of ['zero','step','ramp','triangle'] as const){
 const p=settings(delay,window),channel=new LinearInletChannel(p),dt=1/64,rows=[]
 for(let i=0;i<=8/dt;i++){
  const t=i*dt,input=kind==='zero'?0:kind==='step'?1:kind==='ramp'?.1*t:t<=2?1-.5*t:t<=4?0:t<=6?.5*(t-4):1
  const output=channel.update(t,input);assert.ok(Number.isFinite(output)&&output>=-1e-12);rows.push([t,input,output])
  if(kind==='zero')assert.equal(output,0)
  if(kind==='step'||kind==='ramp'){
   const state=(age:number)=>{const s=Math.max(0,age),r=-Math.expm1(-s/.5);return kind==='step'?r:.1*(s-.5*r)}
   const integral=(age:number)=>{const s=Math.max(0,age),r=-Math.expm1(-s/.5);return kind==='step'?s-.5*r:.1*(s*s/2-.5*s+.25*r)}
   close(output,window?(integral(t-delay)-integral(t-delay-window))/window:state(t-delay))
  }
 }
 fixtures.push({kind,settings:p,rows})
}
// Irregular timestamps and a prefix test: later input choices cannot rewrite history.
for(const window of [0,.7]){
 const p=settings(.1,window),a=new LinearInletChannel(p),b=new LinearInletChannel(p),rows=[]
 for(const t of [0,.03,.12,.37,.71,1.3,1.9,2.6,3.1,4.2]){
  const u=.3+.2*Math.sin(t*1.7),v=a.update(t,u);if(t<=1.3)assert.equal(v,b.update(t,u));else b.update(t,1.1-u)
  rows.push([t,u,v])
 }
 fixtures.push({kind:'irregular',settings:p,rows})
}
const tiny=linearResponse(.4,.9,.2,2,1e-12);close(tiny.state,.4+.25e-12,1e-16);close(tiny.area,.4e-12,1e-24)
const bad=new LinearInletChannel(settings(0,1));bad.update(0,0)
for(const [time,input] of [[0,1],[-1,0],[1,-1],[1,NaN],[Infinity,0]])assert.throws(()=>bad.update(time!,input!))
assert.throws(()=>new LinearInletChannel({...base,averagingSeconds:-1}))
// Mesh changes cannot change exact piecewise-linear target history.
for(const dt of [1/16,1/32,1/64,1/128]){
 const p=settings(.271,1),channel=new LinearInletChannel(p),rows=[]
 for(let i=0;i<=8/dt;i++){const t=i*dt,u=t<=2?1-.5*t:t<=4?0:t<=6?.5*(t-4):1;rows.push([t,u,channel.update(t,u)])}
 fixtures.push({kind:'triangle-mesh',dt,settings:p,rows})
}
if(!process.argv.includes('--output'))throw Error('Exclusive output required')
const output=process.argv[process.argv.indexOf('--output')+1]!;await mkdir(output)
await writeFile(`${output}/fixtures.json`,JSON.stringify({complete:true,fixtures},null,2)+'\n',{flag:'wx'})
process.stdout.write(`PASS analytic constant/step/ramp, causality, irregular clocks and input rejection; ${fixtures.length} saved fixtures\n`)
