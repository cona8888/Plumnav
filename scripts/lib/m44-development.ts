import {runM41Case,M41_REFERENCE,type M41Config} from './m41-development'
import {m42Random} from './m42-noise-probe'
import {transientSpatialFit,orientationProbe} from './m43-transient-probe'
import {assessSpatialPrediction} from './m41-spatial-check'
import {relativeInputCheck} from './m44-relative-check'
export const M44_ARMS=['absolute-directed','relative-directed','relative-random','relative-orientation','relative-stationary'] as const
export type M44Arm=typeof M44_ARMS[number]
export function runM44Case(overrides:Partial<M41Config>={},arm:M44Arm='relative-directed') {
  const c={...M41_REFERENCE,...overrides,arm:'directed-probe' as const}
  let initialSigma=0,diagnostics:Record<string,unknown>|null=null
  const angle=m42Random(c.seed^0x27d4eb2d)()*2*Math.PI
  const r=runM41Case(c,{
    randomReadout:m42Random(c.seed^0x85ebca6b),
    fit:(rs,spacing,minimum)=>{const f=transientSpatialFit(rs,spacing,minimum,c.noise,c.tau,c.delay);
      initialSigma=f.inputSigma;return f.fit},
    direction:fit=>arm==='relative-stationary'?{x:0,y:0}:arm==='relative-random'?{x:Math.cos(angle),y:Math.sin(angle)}:
      arm==='relative-orientation'?orientationProbe(fit,c.spacing,c.step).direction:fit.direction!,
    check:(fit,rs,predicted,tolerance)=>{
      if(arm==='absolute-directed')return assessSpatialPrediction(fit,rs,predicted,tolerance)
      const result=relativeInputCheck(fit,rs,initialSigma,{spacing:c.spacing,minimumContrast:c.minimumContrast,
        noise:c.noise,tau:c.tau,delay:c.delay,movedAt:c.dwell+c.step/c.speed})
      diagnostics=result.diagnostics;return result.check
    },
  })
  return {...r,arm,diagnostics:diagnostics as Record<string,unknown>|null,
    purpose:'M44 conditional signal-relative input consistency; manufactured development, not GSL validation'}
}
