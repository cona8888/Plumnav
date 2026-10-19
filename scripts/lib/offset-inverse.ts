import {channelReference} from './channel-reference'
export type VisibleInverseData={poses:Array<{time:number;x:number;y:number}>;samples:Array<{index:number;value:number;train:boolean;hit:boolean}>}
export type Response={delay:number;rise:number;recovery:number;average:number}
function solve(a:number[][],b:number[]){const m=a.map((r,i)=>[...r,b[i]!]);for(let k=0;k<b.length;k++){let p=k;for(let i=k+1;i<b.length;i++)if(Math.abs(m[i]![k]!)>Math.abs(m[p]![k]!))p=i;if(Math.abs(m[p]![k]!)<1e-12)return null;[m[k],m[p]]=[m[p]!,m[k]!];const d=m[k]![k]!;for(let j=k;j<=b.length;j++)m[k]![j]!/=d;for(let i=0;i<b.length;i++)if(i!==k){const f=m[i]![k]!;for(let j=k;j<=b.length;j++)m[i]![j]!-=f*m[k]![j]!}}return m.map(r=>r[b.length]!)}
/** A scalar effective-channel approximation, not exact inversion of four
 * independently filtered channels. Candidate-relative x/y use the cross offset.
 * Adds linear gradients; inferred maximum must lie within the cross convex hull.
 * This is a local quadratic model check, not source-location evidence.
 * No field labels, source coordinates, true inputs or truth calibration accepted. */
export function predictOffset(data:VisibleInverseData,c:number[],response:Response|null,period:number,step=.05){
 const input=data.poses.map(p=>({time:p.time,value:Math.max(0,c[0]!+c[1]!*p.time/600-c[2]!*p.x*p.x-c[3]!*p.y*p.y +c[4]!*p.x+c[5]!*p.y+(period?c[6]!*Math.sin(2*Math.PI*p.time/period)+c[7]!*Math.cos(2*Math.PI*p.time/period):0))}))
 return response?channelReference(input,response,step):input.map(p=>p.value)
}
export function fitOffset(data:VisibleInverseData,response:Response|null,noise:number,period:number){
 const train=data.samples.filter(s=>s.train),test=data.samples.filter(s=>!s.train),margin=3*noise
 let coefficients=[train.reduce((s,v)=>s+v.value,0)/train.length,0,0,0,0,0,...(period?[0,0]:[])],pred=predictOffset(data,coefficients,response,period),iterations=0
 const loss=(p:number[])=>train.reduce((a,s)=>a+(p[s.index]!-s.value)**2,0)/train.length
 let objective=loss(pred)
 const bound=(a:number[])=>[Math.max(0,Math.min(2,a[0]!)),Math.max(-1,Math.min(1,a[1]!)),...a.slice(2).map((v,j)=>Math.max(j<2?-.2:-.3,Math.min(j<2?.2:.3,v)))]
 for(let iter=0;iter<12;iter++){
  const jac=Array.from({length:coefficients.length},(_,j)=>{const v=[...coefficients];v[j]!+=1e-5;const p=predictOffset(data,v,response,period);return train.map(s=>(p[s.index]!-pred[s.index]!)/1e-5)})
  const matrix=Array.from({length:coefficients.length},(_,j)=>Array.from({length:coefficients.length},(_,k)=>jac[j]!.reduce((a,v,i)=>a+v*jac[k]![i]!,0)+(j===k?1e-8:0))),rhs=jac.map(a=>a.reduce((v,x,i)=>v+x*(train[i]!.value-pred[train[i]!.index]!),0)),delta=solve(matrix,rhs)
  if(!delta)break
  let improved=false
  for(const scale of [1,.5,.25,.125]){const candidate=bound(coefficients.map((v,j)=>v+scale*delta[j]!)),p=predictOffset(data,candidate,response,period),next=loss(p);if(next<objective-1e-14){coefficients=candidate;pred=p;objective=next;improved=true;break}}
  iterations=iter+1;if(!improved)break
 }
 const validationRmse=Math.sqrt(test.reduce((a,s)=>a+(pred[s.index]!-s.value)**2,0)/test.length),trainingRmse=Math.sqrt(objective)
 const peakOffset={x:coefficients[4]!/(2*coefficients[2]!),y:coefficients[5]!/(2*coefficients[3]!)}
 const peakInside=Number.isFinite(peakOffset.x)&&Number.isFinite(peakOffset.y)&&Math.abs(peakOffset.x)+Math.abs(peakOffset.y)<=1
 const coreSignal=train.filter(s=>data.poses[s.index]!.x**2+data.poses[s.index]!.y**2<.01).some(s=>s.hit&&s.value>=.16)
 return {peakOffset,peakInside,coefficients,predictions:pred,iterations,trainingRmse,validationRmse,trainingPlausible:trainingRmse<=margin,
  supported:peakInside&&coreSignal&&trainingRmse<=margin&&validationRmse<=margin&&coefficients[2]!>margin&&coefficients[3]!>margin,coreSignal,margin}
}

/** Training-only instantaneous frequency screen, shared across response arms.
 * This is an approximation, not joint frequency/calibration optimisation. */
export function selectOffsetPeriod(data:VisibleInverseData,noise:number){
 const train=data.samples.filter(s=>s.train)
 const evaluate=(period:number)=>{const n=period?8:6,rows=train.map(s=>{const p=data.poses[s.index]!;return [1,p.time/600,-p.x*p.x,-p.y*p.y,p.x,p.y,...(period?[Math.sin(2*Math.PI*p.time/period),Math.cos(2*Math.PI*p.time/period)]:[])]}),a=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>rows.reduce((v,r)=>v+r[i]!*r[j]!,0)+(i===j?1e-8:0))),b=Array.from({length:n},(_,i)=>rows.reduce((v,r,k)=>v+r[i]!*train[k]!.value,0)),c=solve(a,b)
 if(!c)return {period,rmse:Infinity}
 return {period,rmse:Math.sqrt(rows.reduce((v,r,k)=>v+(r.reduce((a,x,j)=>a+x*c[j]!,0)-train[k]!.value)**2,0)/rows.length)} }
 const affine=evaluate(0);if(affine.rmse<=3*noise)return {...affine,affineRmse:affine.rmse}
 let best=affine;for(let k=40;k<=240;k++){const candidate=evaluate(k/2);if(candidate.rmse<best.rmse)best=candidate}
 return {...best,affineRmse:affine.rmse}
}
