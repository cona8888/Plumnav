import {runM41Case,M41_REFERENCE,type M41Config} from './m41-development'
import {noiseAwareFit,m42Random} from './m42-noise-probe'
import {transientSpatialFit,orientationProbe} from './m43-transient-probe'

export const M43_ARMS=['m42-directed','lag-directed','lag-random','lag-orientation','lag-fixed22','lag-stationary'] as const
export type M43Arm=typeof M43_ARMS[number]
export const runM43Case=(overrides:Partial<M41Config>={},arm:M43Arm='lag-orientation')=>{
  const c={...M41_REFERENCE,...overrides,arm:'directed-probe' as const}
  const angle=m42Random(c.seed^0x27d4eb2d)()*2*Math.PI
  let diagnostics:Record<string,unknown>|null=null
  let score:number|null=null
  const r=runM41Case(c,{
    randomReadout:m42Random(c.seed^0x85ebca6b),
    fit:(rs,spacing,minimum)=>{
      if(arm==='m42-directed'){
        const {fit,...rest}=noiseAwareFit(rs,spacing,minimum,c.noise);diagnostics=rest;return fit
      }
      const {fit,...rest}=transientSpatialFit(rs,spacing,minimum,c.noise,c.tau,c.delay)
      diagnostics=rest;return fit
    },
    direction:fit=>{
      if(arm==='lag-stationary')return {x:0,y:0}
      if(arm==='lag-random')return {x:Math.cos(angle),y:Math.sin(angle)}
      if(arm==='lag-fixed22')return {x:Math.cos(Math.PI/8),y:Math.sin(Math.PI/8)}
      if(arm==='lag-orientation'){
        const p=orientationProbe(fit,c.spacing,c.step);score=p.score;return p.direction
      }
      return fit.direction!
    },
  })
  return {...r,arm,diagnostics:diagnostics as Record<string,unknown>|null,designScore:score as number|null,
    purpose:'M43 transient fitting and rotated-alternative development; not full GSL'}
}
