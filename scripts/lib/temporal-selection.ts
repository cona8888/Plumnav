/** Frozen M87 selector ablation. Offline verification, never source declaration.
 * Affine-first uses the same alternating whole-visit split as M86. Piecewise
 * affine is a separate assumption: no shared trend is imposed between rounds.
 */
import {temporalContrast} from './temporal-contrast'
type Sample={time:number;value:number;hit:boolean}
type Circuit={visits:Array<{samples:Sample[]}>}
const median=(a:number[])=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)]??NaN}
function affine(train:Sample[],test:Sample[]){
 const n=train.length,mt=train.reduce((v,s)=>v+s.time,0)/n,my=train.reduce((v,s)=>v+s.value,0)/n
 const denominator=train.reduce((v,s)=>v+(s.time-mt)**2,0)
 const slope=train.reduce((v,s)=>v+(s.time-mt)*(s.value-my),0)/denominator,intercept=my-slope*mt
 const predict=(t:number)=>intercept+slope*t
 const rmse=(a:Sample[])=>Math.sqrt(a.reduce((v,s)=>v+(predict(s.time)-s.value)**2,0)/a.length)
 return {intercept,slope,trainingRmse:rmse(train),validationRmse:rmse(test),predict}
}
export function selectedTemporalContrast(circuits:Circuit[],noise:number,orders:number[][],piecewise=false){
 const margin=3*noise
 if(circuits.length!==2||circuits.some(c=>c.visits.length!==9||c.visits.some(v=>v.samples.length<2)))return {supported:false,model:'none',reason:'incomplete'}
 const centres=circuits.map(c=>c.visits.filter((_,i)=>i%2===0))
 const fitGroup=(visits:Circuit['visits'])=>{
  const train=visits.filter((_,i)=>i%2===0).flatMap(v=>v.samples),test=visits.filter((_,i)=>i%2===1).flatMap(v=>v.samples),all=visits.flatMap(v=>v.samples)
  const cross=affine(train,test),full=affine(all,all)
  return {intercept:full.intercept,slope:full.slope,trainingRmse:cross.trainingRmse,validationRmse:cross.validationRmse,fullRmse:full.trainingRmse,
   eligible:[cross.trainingRmse,cross.validationRmse,full.trainingRmse].every(v=>Number.isFinite(v)&&v<=margin)}
 }
 const global=fitGroup(centres.flat()),pieces=piecewise?centres.map(fitGroup):[]
 const model=global.eligible?'global-affine':piecewise&&pieces.every(f=>f.eligible)?'per-round-affine':'harmonic'
 if(model==='harmonic')return {...temporalContrast(circuits,noise,orders),model,affineDiagnostics:{global,pieces}}
 const fits=model==='global-affine'?[global,global]:pieces
 const contrasts=circuits.map((c,j)=>{const out=Array(4).fill(NaN),f=fits[j]!;for(let k=0;k<4;k++)out[orders[j]![k]!]=median(c.visits[2*k+1]!.samples.map(s=>f.intercept+f.slope*s.time-s.value));return out})
 const coreSignal=centres.flat().every(v=>median(v.samples.map(s=>s.value))>=.16&&v.samples.filter(s=>s.hit).length>=2)
 // A selected model is not retried merely because its flank contrast fails.
 return {supported:coreSignal&&contrasts.every(a=>a.every(v=>v>margin)),model,reason:!coreSignal?'weak-core':'contrast-check',contrasts,margin,fits,affineDiagnostics:{global,pieces}}
}
