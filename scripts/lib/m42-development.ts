import {runM41Case,M41_REFERENCE,type M41Config} from './m41-development'
import {fitSpatialPlane,type Point} from './m41-spatial-check'
import {noiseAwareFit,m42Random,balancedProbe,type NoiseGate} from './m42-noise-probe'

export const M42_ARMS=['fixed-directed','gated-directed','gated-random','gated-balanced','gated-diagonal','gated-stationary'] as const
export type M42Arm=typeof M42_ARMS[number]
export const runM42Case=(overrides:Partial<M41Config>={},arm:M42Arm='gated-balanced',calibrationFactor=1)=>{
  const c={...M41_REFERENCE,...overrides,arm:'directed-probe' as const}
  if(!Number.isFinite(calibrationFactor)||calibrationFactor<0)throw new RangeError('Invalid calibration factor')
  let gate:Omit<NoiseGate,'fit'>|null=null,designScore:number|null=null,command:Point={x:0,y:0}
  const randomAngle=m42Random(c.seed^0x27d4eb2d)()*2*Math.PI
  const result=runM41Case(c,{
    randomReadout:m42Random(c.seed^0x85ebca6b),
    fit:(rs,spacing,minimum)=>{
      if(arm==='fixed-directed')return fitSpatialPlane(rs,spacing,minimum)
      const {fit,...diagnostics}=noiseAwareFit(rs,spacing,minimum,c.noise*calibrationFactor)
      gate=diagnostics;return fit
    },
    direction:fit=>{
      if(arm==='gated-stationary')command={x:0,y:0}
      else if(arm==='gated-random')command={x:Math.cos(randomAngle),y:Math.sin(randomAngle)}
      else if(arm==='gated-diagonal')command={x:Math.SQRT1_2,y:Math.SQRT1_2}
      else if(arm==='gated-balanced'){
        const design=balancedProbe(fit,c.spacing,c.step);command=design.direction;designScore=design.score
      }else command=fit.direction!
      return command
    },
  })
  return {arm,calibrationFactor,gate:gate as Omit<NoiseGate,'fit'>|null,designScore,command,randomAngle,...result,
    purpose:'M42 noise-gating and balanced-probe development; not full GSL'}
}
