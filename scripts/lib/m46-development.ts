import {runM41Case,M41_REFERENCE,type M41Config} from './m41-development'
import {m42Random} from './m42-noise-probe'
import {correlatedReadout} from './m45-window-development'
import {fitCalibrationEnvelope,checkCalibrationEnvelope} from './m46-calibration-envelope'
export const M46_ARMS=['nominal-directed','grid-directed','bounded-directed','bounded-stationary'] as const
export type M46Arm=typeof M46_ARMS[number]
export function runM46Case(overrides:Partial<M41Config>={},arm:M46Arm='bounded-directed',
  challenge:{tauFactor?:number;rho?:number;warmStart?:boolean}={}) {
  const c={...M41_REFERENCE,...overrides,arm:'directed-probe' as const}
  const stress={tauFactor:challenge.tauFactor??1,rho:challenge.rho??0,warmStart:challenge.warmStart??false}
  const settings={spacing:c.spacing,minimumContrast:c.minimumContrast,noise:c.noise,delay:c.delay,
    nominalTau:c.tau*stress.tauFactor,rhoBound:arm.startsWith('bounded')?.7:0}
  let initial:ReturnType<typeof fitCalibrationEnvelope>|null=null,diagnostics:Record<string,unknown>|null=null
  const r=runM41Case(c,{
    history:'all',randomReadout:m42Random(c.seed^0x85ebca6b),readoutNoise:correlatedReadout(stress.rho),
    fit:rs=>{initial=fitCalibrationEnvelope(rs.filter(r=>r.time>c.delay),settings,
      arm==='nominal-directed'?[settings.nominalTau]:undefined);return initial.fit},
    direction:fit=>arm==='bounded-stationary'?{x:0,y:0}:fit.direction!,
    check:(_,rs)=>{
      const movedAt=c.dwell+c.step/c.speed
      const result=checkCalibrationEnvelope(initial!,rs.filter(r=>r.time>movedAt+c.delay),settings,movedAt)
      diagnostics=result.diagnostics;return result.check
    },
  },{warmStart:stress.warmStart})
  return {...r,arm,stress,diagnostics:diagnostics as Record<string,unknown>|null,
    purpose:'M46 finite calibration grid and controlled initialization diagnostic, not GSL validation'}
}
