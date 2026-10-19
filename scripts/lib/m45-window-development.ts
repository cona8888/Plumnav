import {runM41Case,M41_REFERENCE,type M41Config} from './m41-development'
import {m42Random} from './m42-noise-probe'
import {transientSpatialFit,orientationProbe} from './m43-transient-probe'
import {relativeInputCheck} from './m44-relative-check'
import type {Four} from './m41-spatial-check'

export const M45_ARMS=['four-directed','full-directed','full-orientation','full-stationary'] as const
export type M45Arm=typeof M45_ARMS[number]
/** Stationary marginal sigma with temporal AR(1) readout noise per channel.
 * Correlation is a world-only challenge: the inference deliberately still uses
 * its nominal iid bounds. Such challenge runs have no confidence guarantee. */
export function correlatedReadout(rho:number) {
  if(!Number.isFinite(rho)||Math.abs(rho)>=1)throw new RangeError('Invalid correlation')
  let previous:Four|null=null
  return (iid:Four):Four=>{
    const v=previous?iid.map((x,i)=>rho*previous![i]!+Math.sqrt(1-rho*rho)*x) as Four:[...iid] as Four
    previous=v;return v
  }
}
export function runM45Case(overrides:Partial<M41Config>={},arm:M45Arm='full-directed',
  stress:{tauFactor?:number;rho?:number}={}) {
  const c={...M41_REFERENCE,...overrides,arm:'directed-probe' as const}
  const tauFactor=stress.tauFactor??1,rho=stress.rho??0
  if(!Number.isFinite(tauFactor)||tauFactor<=0)throw new RangeError('Invalid calibration factor')
  const assumedTau=c.tau*tauFactor
  let initialSigma=0,initialCount=0,terminalCount=0,initialResidual=0,diagnostics:Record<string,unknown>|null=null
  const r=runM41Case(c,{
    history:arm==='four-directed'?'last-four':'all',
    randomReadout:m42Random(c.seed^0x85ebca6b),readoutNoise:correlatedReadout(rho),
    fit:(rs,spacing,minimum)=>{
      const valid=rs.filter(r=>r.time>c.delay)
      const f=transientSpatialFit(valid,spacing,minimum,c.noise,assumedTau,c.delay)
      initialSigma=f.inputSigma;initialCount=valid.length;initialResidual=f.temporalResidual;return f.fit
    },
    direction:fit=>arm==='full-stationary'?{x:0,y:0}:arm==='full-orientation'?
      orientationProbe(fit,c.spacing,c.step).direction:fit.direction!,
    check:(fit,rs)=>{
      const movedAt=c.dwell+c.step/c.speed,valid=rs.filter(r=>r.time>movedAt+c.delay)
      terminalCount=valid.length
      const result=relativeInputCheck(fit,valid,initialSigma,{spacing:c.spacing,minimumContrast:c.minimumContrast,
        noise:c.noise,tau:assumedTau,delay:c.delay,movedAt})
      diagnostics=result.diagnostics;return result.check
    },
  })
  return {...r,arm,stress:{tauFactor,rho},initialCount,terminalCount,initialSigma,initialResidual,
    diagnostics:diagnostics as Record<string,unknown>|null,
    purpose:'M45 fixed full-window development; timing/correlation stress is outside nominal confidence assumptions'}
}
