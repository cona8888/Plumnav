import {runM41Case,M41_REFERENCE} from './m41-development'
import {transientSpatialFit} from './m43-transient-probe'
import {relativeInputCheck} from './m44-relative-check'
import {fitCalibrationEnvelope,checkCalibrationEnvelope} from './m46-calibration-envelope'
import {m42Random} from './m42-noise-probe'
import {correlatedReadout} from './m45-window-development'
import {makeTransportField,type PlumeCase} from './m47-transport'
export const M47_ARMS=['m44-four-directed','m45-full-directed','m46-bounded-directed','m46-bounded-stationary'] as const
export type M47Arm=typeof M47_ARMS[number]
export type M47Case={kind:PlumeCase;x:number;y:number;wind:number;diffusivity:number;noise:number;seed:number;
  warmStart:boolean;rho:number;integrationStep?:number;releaseStep?:number}
export function runM47Case(c:M47Case,arm:M47Arm) {
  const field=makeTransportField(c.kind,{wind:{x:c.wind,y:0},diffusivity:c.diffusivity},c.releaseStep??1)
  const evaluate=(p:{x:number;y:number},t:number)=>field.evaluate({x:p.x+c.x,y:p.y+c.y},t)
  const settings={spacing:M41_REFERENCE.spacing,minimumContrast:M41_REFERENCE.minimumContrast,noise:c.noise,
    delay:M41_REFERENCE.delay,nominalTau:M41_REFERENCE.tau,rhoBound:.7}
  let initialSigma=0,initial:ReturnType<typeof fitCalibrationEnvelope>|null=null
  const bounded=arm.startsWith('m46')
  const result=runM41Case({noise:c.noise,seed:c.seed,integrationStep:c.integrationStep??.05}, {
    history:arm==='m44-four-directed'?'last-four':'all',randomReadout:m42Random(c.seed^0x85ebca6b),
    readoutNoise:correlatedReadout(c.rho),
    fit:rs=>{
      if(bounded){initial=fitCalibrationEnvelope(rs,settings);return initial.fit}
      const f=transientSpatialFit(rs,settings.spacing,settings.minimumContrast,c.noise,settings.nominalTau,settings.delay)
      initialSigma=f.inputSigma;return f.fit
    },
    direction:fit=>arm==='m46-bounded-stationary'?{x:0,y:0}:fit.direction!,
    check:(fit,rs)=>{
      const movedAt=M41_REFERENCE.dwell+M41_REFERENCE.step/M41_REFERENCE.speed
      return bounded?checkCalibrationEnvelope(initial!,rs,settings,movedAt).check:
        relativeInputCheck(fit,rs,initialSigma,{...settings,tau:settings.nominalTau,movedAt}).check
    },
  },{warmStart:c.warmStart,concentration:(p,t)=>evaluate(p,t).concentration,gradient:(p,t)=>evaluate(p,t).gradient})
  const endpoint={x:result.endpoint.x+c.x,y:result.endpoint.y+c.y}
  const d=result.initialDirection,sourceDistance=Math.hypot(endpoint.x,endpoint.y)
  const sourceBearingError=c.kind==='absent'||!d||sourceDistance<1e-12?null:
    Math.acos(Math.max(-1,Math.min(1,(-d.x*endpoint.x-d.y*endpoint.y)/sourceDistance)))*180/Math.PI
  // Do not expose M41's polynomial field label or feature ratios as transport metadata.
  return {arm,case:c,check:result.check,initialDirection:d,initialErrorDegrees:result.initialErrorDegrees,
    endErrorDegrees:result.endErrorDegrees,sourceBearingError,elapsedSeconds:result.elapsedSeconds,
    readoutCount:result.readoutCount,distanceMetres:result.distanceMetres,endpoint,
    finalConcentration:evaluate(result.endpoint,result.elapsedSeconds).concentration,
    purpose:'Independent analytic transport diagnostic; not a full GSL mission or physical methane validation'}
}
