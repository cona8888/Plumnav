import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {makeTransportField} from './lib/m47-transport'
const dir=resolve(process.argv[2]??'research/results/m50-peak-source-audit-v1');mkdirSync(dir,{recursive:false})
const start=performance.now(),rows=[]
for(const wind of [.01,.02,.05])for(const diffusivity of [.0002,.0005,.002])
  for(const time of [100,250,500])for(const releaseStep of [.5,.125]){
    const f=makeTransportField('steady-release',{wind:{x:wind,y:0},diffusivity},releaseStep,time+1)
    const c=(x:number)=>f.evaluate({x,y:0},time).concentration
    let x=0,v=-Infinity
    for(let i=0;i<=150;i++){const q=-.05+i*.001;if(c(q)>v){x=q;v=c(q)}}
    assert.ok(x>-.05&&x<.1)
    let a=x-.001,b=x+.001
    for(let i=0;i<35;i++){const l=a+(b-a)/3,r=b-(b-a)/3;if(c(l)>c(r))b=r;else a=l}
    x=(a+b)/2
    rows.push({wind,diffusivity,time,releaseStep,peakX:x,peakConcentration:c(x),sourceConcentration:c(0),
      peBasedOnSourceWidth:wind*.05/diffusivity,peakOffsetOverSourceWidth:x/.05,toleranceOverSourceWidth:.015/.05})
  }
assert.equal(rows.length,54)
const refinements=[]
for(let i=0;i<rows.length;i+=2){const a=rows[i]!,b=rows[i+1]!
  refinements.push({wind:a.wind,diffusivity:a.diffusivity,time:a.time,peakShift:Math.abs(a.peakX-b.peakX),
    bothExceedTarget:a.peakX>.015&&b.peakX>.015})}
const report={scope:'Evaluator-only peak/source offset; no policy truth access',rows,refinements,
  wallSeconds:(performance.now()-start)/1000,minimumOffset:Math.min(...rows.map(r=>r.peakX)),
  maximumOffset:Math.max(...rows.map(r=>r.peakX)),allExceedTarget:rows.every(r=>r.peakX>.015)}
const content=JSON.stringify(report,null,2)+'\n'
writeFileSync(join(dir,'summary.json'),content,{flag:'wx'})
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex')
writeFileSync(join(dir,'manifest.json'),JSON.stringify({artifactHash:hash(content),sourceHashes:Object.fromEntries(
  ['scripts/m50-peak-audit.ts','scripts/lib/m47-transport.ts'].map(f=>[f,hash(readFileSync(f))]))},null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({rows:rows.length,minimumOffset:report.minimumOffset,maximumOffset:report.maximumOffset,
  allExceedTarget:report.allExceedTarget,maximumReleaseRefinementShift:Math.max(...refinements.map(r=>r.peakShift)),wallSeconds:report.wallSeconds}))
