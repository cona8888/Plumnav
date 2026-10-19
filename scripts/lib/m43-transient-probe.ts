import {noiseAwareFit} from './m42-noise-probe'
import {inletPositions,type Reading,type Four,type SpatialFit} from './m41-spatial-check'

/** Fit y(t)=A+B exp(-(t-t0)/tau) with unknown A and B for each channel.
 * Requires constant inlet concentration over this fixed-pose window, with the
 * tube transition already past. Uses calibrated tau, not simulator truth access.
 */
export const transientSpatialFit=(rs:Reading[],spacing:number,minimum:number,sigma:number,tau:number,delay:number)=>{
  if(rs.length<3||!Number.isFinite(tau)||tau<=0||!Number.isFinite(delay)||delay<0||
    rs[0]!.time<=delay)throw new RangeError('Unusable transient fit window')
  // Validate pose, timestamps, values and sigma using the existing gate.
  noiseAwareFit(rs,spacing,minimum,sigma)
  const e=rs.map(r=>Math.exp(-(r.time-rs[0]!.time)/tau)),n=e.length
  const se=e.reduce((a,b)=>a+b,0),s2=e.reduce((a,b)=>a+b*b,0),den=n*s2-se*se
  if(den<=1e-12)throw new RangeError('Unidentifiable transient intercept')
  const weights=e.map(x=>(s2-se*x)/den)
  const input=[0,1,2,3].map(j=>rs.reduce((s,r,i)=>s+weights[i]!*r.values[j]!,0)) as Four
  const inputSigma=sigma*Math.sqrt(weights.reduce((s,w)=>s+w*w,0))
  const last=rs.at(-1)!
  const gate=noiseAwareFit([{...last,values:input}],spacing,minimum,inputSigma)
  const residual=Math.max(...[0,1,2,3].flatMap(j=>{
    const sy=rs.reduce((s,r)=>s+r.values[j]!,0),sey=rs.reduce((s,r,i)=>s+e[i]!*r.values[j]!,0)
    const b=(n*sey-se*sy)/den
    return rs.map((r,i)=>Math.abs(r.values[j]!-input[j]!-b*e[i]!))
  }))
  const temporalMismatch=residual>0.02+3*sigma // engineering check, NOT confidence
  return {...gate,fit:{...gate.fit,lastValues:[...last.values] as Four,
    direction:temporalMismatch?null:gate.fit.direction},input,inputSigma,weights,
    temporalResidual:residual,temporalMismatch,
    assumption:'Fixed inlet concentration with known first-order tau; unknown exponential transient amplitude'}
}

/** Rotated cubic alternatives vanish at initial cardinal mouths. They include
 * mixed x²y/xy² terms missing from M42. Finite directional coverage, not a
 * universal identifiability guarantee. Scores use the observation geometry only.
 */
export const rotatedCubicSensitivity=(angle:number,probeAngle:number,spacing:number,step:number)=>{
  const vx=Math.cos(angle),vy=Math.sin(angle),a=spacing/2
  return inletPositions({x:step*Math.cos(probeAngle),y:step*Math.sin(probeAngle)},0,spacing).map(p=>{
    const x=p.x/a,y=p.y/a,z=vx*x+vy*y
    return z*z*z-vx**3*x-vy**3*y
  })
}
export const orientationProbe=(fit:SpatialFit,spacing:number,step:number)=>{
  if(!Number.isFinite(step)||step<=0)throw new RangeError('Invalid step')
  const candidates=Array.from({length:32},(_,i)=>{
    const angle=i*Math.PI/16
    const sensitivity=Array.from({length:64},(_,k)=>{
      const v=rotatedCubicSensitivity(k*Math.PI/64,angle,spacing,step)
      return v.reduce((s,x)=>s+x*x,0)
    })
    return {angle,score:Math.min(...sensitivity),direction:{x:Math.cos(angle),y:Math.sin(angle)},
      progress:fit.direction?Math.cos(angle)*fit.direction.x+Math.sin(angle)*fit.direction.y:0}
  })
  const max=Math.max(...candidates.map(c=>c.score))
  const tied=candidates.filter(c=>max-c.score<Math.max(1e-12,max*1e-10))
  tied.sort((a,b)=>b.progress-a.progress||a.angle-b.angle)
  return {...tied[0]!,candidates,hypothesisCount:64}
}
