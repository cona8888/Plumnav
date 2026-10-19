/** Experimental centre-only nuisance fit; no source truth or field frequency input.
 * Assumes an additive affine + single-frequency temporal component common to
 * centre and flanks. Residual gates are engineering tolerances, not confidence. */
type Sample={time:number;value:number;hit:boolean}
type Visit={samples:Sample[]}
type Circuit={visits:Visit[]}
const median=(a:number[])=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)]??NaN}
function solve(a:number[][],b:number[]) {
 const m=a.map((r,i)=>[...r,b[i]!]),n=b.length
 for(let k=0;k<n;k++){let p=k;for(let j=k+1;j<n;j++)if(Math.abs(m[j]![k]!)>Math.abs(m[p]![k]!))p=j
  if(Math.abs(m[p]![k]!)<1e-10)return null
  ;[m[k],m[p]]=[m[p]!,m[k]!];const d=m[k]![k]!
  for(let j=k;j<=n;j++)m[k]![j]!/=d
  for(let i=0;i<n;i++)if(i!==k){const f=m[i]![k]!;for(let j=k;j<=n;j++)m[i]![j]!-=f*m[k]![j]!}
 }return m.map(r=>r[n]!)
}
function basis(t:number,period:number){return period?[1,t/600,Math.sin(2*Math.PI*t/period),Math.cos(2*Math.PI*t/period)]:[1,t/600]}
function fit(samples:Sample[],period:number){const n=period?4:2,a=Array.from({length:n},()=>Array(n).fill(0)),b=Array(n).fill(0)
 for(const s of samples){const x=basis(s.time,period);for(let i=0;i<n;i++){b[i]+=x[i]!*s.value;for(let j=0;j<n;j++)a[i]![j]+=x[i]!*x[j]!}}
 const coefficients=solve(a,b);if(!coefficients)return null
 const predict=(t:number)=>basis(t,period).reduce((v,x,i)=>v+x*coefficients[i]!,0)
 const rmse=Math.sqrt(samples.reduce((v,s)=>v+(predict(s.time)-s.value)**2,0)/samples.length)
 return {period,coefficients,rmse,predict}
}
export function temporalContrast(circuits:Circuit[],noise:number,orders:number[][]) {
 const centres=circuits.flatMap(c=>c.visits.filter((_,i)=>i%2===0)),margin=3*noise
 const train=centres.filter((_,i)=>i%2===0).flatMap(v=>v.samples),test=centres.filter((_,i)=>i%2===1).flatMap(v=>v.samples)
 if(circuits.length!==2||centres.length!==10||circuits.some(c=>c.visits.length!==9||c.visits.some(v=>v.samples.length<2))||train.length<8||test.length<8)return {supported:false,reason:'incomplete'}
 let best=fit(train,0)!
 for(let k=200;k<=1200;k++){const f=fit(train,k/10);if(f&&f.rmse<best.rmse)best=f}
 const validationRmse=Math.sqrt(test.reduce((v,s)=>v+(best.predict(s.time)-s.value)**2,0)/test.length)
 const all=centres.flatMap(v=>v.samples),full=fit(all,best.period)!
 const contrasts=circuits.map((c,j)=>{const out=Array(4).fill(NaN);for(let k=0;k<4;k++)out[orders[j]![k]!]=median(c.visits[2*k+1]!.samples.map(s=>full.predict(s.time)-s.value));return out})
 const coreSignal=centres.every(v=>median(v.samples.map(s=>s.value))>=.16&&v.samples.filter(s=>s.hit).length>=2)
 const temporalFit=best.rmse<=margin&&validationRmse<=margin&&full.rmse<=margin
 return {supported:coreSignal&&temporalFit&&contrasts.every(c=>c.every(v=>v>margin)),reason:!coreSignal?'weak-core':!temporalFit?'temporal-model-mismatch':'contrast-check',
  period:best.period,trainingRmse:best.rmse,validationRmse,fullRmse:full.rmse,coefficients:full.coefficients,contrasts,margin}
}
