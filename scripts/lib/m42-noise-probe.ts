import { fitSpatialPlane, inletPositions, type Reading, type SpatialFit, type Point } from './m41-spatial-check'

/** Separate seeded streams; avalanche seed mixing avoids adjacent-seed headings. */
export const m42Random = (seed:number) => {
  if(!Number.isInteger(seed))throw new RangeError('Seed must be integer')
  let s=seed|0
  s=Math.imul(s^(s>>>16),0x45d9f3b);s=Math.imul(s^(s>>>16),0x45d9f3b);s^=s>>>16
  return ()=>{
    s=(s+0x6d2b79f5)|0
    let t=Math.imul(s^(s>>>15),1|s)
    t^=t+Math.imul(t^(t>>>7),61|t)
    return (((t^(t>>>14))>>>0)+0.5)/4294967296
  }
}
export type NoiseGate = { fit:SpatialFit; state:'below-detection'|'contact-uncertain'|'gas-unresolved'|'directional';
  meanErrorBound:number; contrastNormBound:number; actualContrastThreshold:number }

/** Gaussian union bounds for a fixed, preselected window of N independent
 * per-channel readout errors with known SD sigma. NOT a bound on plume/model
 * error, sensor bias, a sequence of adaptive tests or source-bearing accuracy.
 * alpha is split equally between four mean intervals and two contrasts.
 */
export const noiseAwareFit = (readings:Reading[],spacing:number,minimumContrast:number,
  sigma:number,alpha=0.01,detectionLevel=0.075):NoiseGate => {
  if(!Number.isFinite(sigma)||sigma<0||!Number.isFinite(alpha)||alpha<=0||alpha>=1||
    !Number.isFinite(detectionLevel)||detectionLevel<0)throw new RangeError('Invalid noise calibration')
  const n=readings.length
  const raw=fitSpatialPlane(readings,spacing,minimumContrast)
  const meanErrorBound=sigma/Math.sqrt(n)*Math.sqrt(2*Math.log(16/alpha))
  const contrastNormBound=2*sigma/Math.sqrt(n)*Math.sqrt(2*Math.log(8/alpha))
  const actualContrastThreshold=Math.max(minimumContrast,contrastNormBound)
  const means=[0,1,2,3].map(i=>readings.reduce((s,r)=>s+r.values[i]!,0)/n)
  const max=Math.max(...means)
  let state:NoiseGate['state']
  if(max+meanErrorBound<detectionLevel)state='below-detection'
  else if(max-meanErrorBound<=detectionLevel)state='contact-uncertain'
  else if(Math.hypot(raw.gradient.x,raw.gradient.y)*spacing<=actualContrastThreshold)state='gas-unresolved'
  else state='directional'
  return {fit:{...raw,direction:state==='directional'?raw.direction:null},state,
    meanErrorBound,contrastNormBound,actualContrastThreshold}
}

/** A geometry-balanced check design. Cubic modes x^3-x and y^3-y vanish at
 * the original four point inlets (coordinates normalized by half-spacing).
 * Maximize the smallest eigenvalue of their post-translation sensitivity matrix.
 * These modes are test alternatives, not inferred real plume derivatives.
 * Isotropic sensors make diagonal directions tie. Observed gradient chooses the
 * most forward tied direction; this is NOT a fully adaptive information planner.
 */
export const balancedProbe = (fit:SpatialFit,spacing:number,step:number) => {
  if(!Number.isFinite(step)||step<=0)throw new RangeError('Invalid probe length')
  const a=spacing/2
  const candidates=Array.from({length:16},(_,i)=>{
    const angle=i*Math.PI/8, direction={x:Math.cos(angle),y:Math.sin(angle)}
    const mouths=inletPositions({x:direction.x*step,y:direction.y*step},0,spacing)
    const modes=mouths.map(p=>{const x=p.x/a,y=p.y/a;return [x*x*x-x,y*y*y-y]})
    const xx=modes.reduce((s,m)=>s+m[0]!**2,0),yy=modes.reduce((s,m)=>s+m[1]!**2,0)
    const xy=modes.reduce((s,m)=>s+m[0]!*m[1]!,0)
    const score=(xx+yy-Math.hypot(xx-yy,2*xy))/2
    const progress=fit.direction?direction.x*fit.direction.x+direction.y*fit.direction.y:0
    return {angle,direction,score,progress}
  })
  const bestScore=Math.max(...candidates.map(c=>c.score))
  const tied=candidates.filter(c=>bestScore-c.score<=Math.max(1e-12,Math.abs(bestScore)*1e-10))
  tied.sort((a,b)=>b.progress-a.progress||a.angle-b.angle)
  return {direction:tied[0]!.direction,score:tied[0]!.score,candidates,
    caveat:'Finite alternative-model design; no universal mismatch-detection guarantee'}
}
