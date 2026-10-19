import {transientSpatialFit} from './m43-transient-probe'
import {relativeInputCheck} from './m44-relative-check'
import type {Reading,SpatialFit,CheckResult} from './m41-spatial-check'
export type CalibrationSettings={spacing:number;minimumContrast:number;noise:number;delay:number;nominalTau:number;rhoBound:number}
export const calibrationGrid=(nominal:number)=>{
  if(!(nominal>0&&Number.isFinite(nominal)))throw new RangeError('Invalid nominal response')
  return Array.from({length:21},(_,i)=>nominal*(.75+.025*i))
}
export const correlationInflation=(rho:number)=>{
  if(!Number.isFinite(rho)||rho<0||rho>=1)throw new RangeError('Invalid correlation bound')
  // AR(1) covariance spectral upper bound, valid also for negative correlations.
  return Math.sqrt((1+rho)/(1-rho))
}
export function fitCalibrationEnvelope(rs:Reading[],c:CalibrationSettings,grid=calibrationGrid(c.nominalTau)) {
  if(!grid.length)throw new RangeError('Empty calibration grid')
  const sigma=c.noise*correlationInflation(c.rhoBound)
  const candidates=grid.map(tau=>({tau,...transientSpatialFit(rs,c.spacing,c.minimumContrast,sigma,tau,c.delay)}))
  const plausible=candidates.filter(f=>!f.temporalMismatch)
  // Temporal compatibility is an engineering screen, not a calibrated confidence set.
  const selected=[...(plausible.length?plausible:candidates)].sort((a,b)=>a.temporalResidual-b.temporalResidual)[0]!
  const direction=selected.fit.direction
  const agreement=!!direction&&plausible.length>0&&plausible.every(f=>f.fit.direction&&
    direction.x*f.fit.direction.x+direction.y*f.fit.direction.y>=Math.cos(Math.PI/12))
  const fit:SpatialFit={...selected.fit,direction:agreement?direction:null}
  return {fit,candidates,plausible,selectedTau:selected.tau,sigma}
}
export function checkCalibrationEnvelope(initial:ReturnType<typeof fitCalibrationEnvelope>,rs:Reading[],
  c:CalibrationSettings,movedAt:number) {
  const checks=initial.plausible.map(f=>({tau:f.tau,...relativeInputCheck(f.fit,rs,f.inputSigma,{
    spacing:c.spacing,minimumContrast:c.minimumContrast,noise:initial.sigma,tau:f.tau,delay:c.delay,movedAt})}))
  const rejected=checks.find(r=>!r.check.accepted)
  const accepted=!!initial.fit.direction&&checks.length>0&&!rejected
  const selected=checks.find(r=>r.tau===initial.selectedTau)??checks[0]
  const check:CheckResult=selected?{...(rejected??selected).check,accepted,
    reason:!initial.fit.direction?'calibration-direction-unresolved':rejected?'calibration-candidate-rejected':'finite-grid-consistent'}:
    {accepted:false,reason:'no-compatible-calibration',maximumError:null,threshold:0,observedMean:null,predictedMean:null}
  return {check,diagnostics:{candidateCount:initial.candidates.length,plausibleCount:initial.plausible.length,
    selectedTau:initial.selectedTau,plausibleTaus:initial.plausible.map(f=>f.tau),
    rejectedTaus:checks.filter(r=>!r.check.accepted).map(r=>r.tau),rhoBound:c.rhoBound,
    sigmaEnvelope:initial.sigma,scope:'Finite-grid engineering robustness only; no continuous-tau or source-confidence guarantee'}}
}
