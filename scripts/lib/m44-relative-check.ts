import {predictInlets,type SpatialFit,type Reading,type CheckResult} from './m41-spatial-check'
import {transientSpatialFit} from './m43-transient-probe'

/** Single, pre-specified two-window check. Gaussian bounds cover readout error
 * only, conditional on constant inputs and exactly calibrated first-order tau.
 * This does NOT certify a spatial model, true gradient, or source direction. */
export function relativeInputCheck(fit:SpatialFit,observed:Reading[],initialSigma:number,
  c:{spacing:number;minimumContrast:number;noise:number;tau:number;delay:number;
    movedAt:number;fraction?:number;alpha?:number}) {
  const fraction=c.fraction??.25,alpha=c.alpha??.01
  if(!(fraction>0&&fraction<1&&alpha>0&&alpha<1)||!Number.isFinite(initialSigma)||initialSigma<0)
    throw new RangeError('Invalid relative-check settings')
  // Times relative to the end of motion: all fitted samples must follow the
  // final tube transition. Merely checking global time > delay is insufficient.
  const local=observed.map(r=>({...r,time:r.time-c.movedAt}))
  const terminal=transientSpatialFit(local,c.spacing,c.minimumContrast,c.noise,c.tau,c.delay)
  const endpoint=observed.at(-1)!
  const predicted=predictInlets(fit,endpoint.position,endpoint.heading,c.spacing)
  // Two-sided Gaussian tail + union bound for eight inferred channel inputs.
  const z=Math.sqrt(2*Math.log(16/alpha))
  const initialBound=z*initialSigma,terminalBound=z*terminal.inputSigma
  const lowerContrast=Math.max(0,Math.hypot(fit.gradient.x,fit.gradient.y)*c.spacing-2*Math.SQRT2*initialBound)
  // Plane prediction is a linear combination of four initial channel inputs.
  // For this harness initial and final headings are zero, but compute initial
  // frame displacement explicitly and reject unsupported heading geometry.
  if(endpoint.heading!==0)throw new RangeError('M44 requires cardinal fixed-heading geometry')
  const dx=(endpoint.position.x-fit.origin.x)/c.spacing,dy=(endpoint.position.y-fit.origin.y)/c.spacing
  const coefficients=predicted.map((_,j)=>{
    const x=dx+(j===0?.5:j===2?-.5:0),y=dy+(j===1?.5:j===3?-.5:0)
    return [.25+x,.25+y,.25-x,.25-y]
  })
  const predictionBound=initialBound*Math.max(...coefficients.map(w=>w.reduce((s,v)=>s+Math.abs(v),0)))
  const rawMismatch=Math.max(...terminal.input.map((v,j)=>Math.abs(v-predicted[j]!)))
  const upperMismatch=rawMismatch+terminalBound+predictionBound
  const trainingUpper=fit.trainingResidual+2*initialBound
  const threshold=fraction*lowerContrast
  const accepted=!!fit.direction&&!!terminal.fit.direction&&!terminal.temporalMismatch&&
    lowerContrast>c.minimumContrast&&upperMismatch<=threshold&&trainingUpper<=threshold
  const reason=!fit.direction?'initial-direction-unresolved':terminal.temporalMismatch?'terminal-temporal-mismatch':
    !terminal.fit.direction?'terminal-direction-unresolved':lowerContrast<=c.minimumContrast?'contrast-unresolved':
    trainingUpper>threshold?'initial-spatial-mismatch-or-uncertainty':upperMismatch>threshold?'relative-mismatch-or-uncertainty':'relative-input-consistent'
  const check:CheckResult={accepted,reason,maximumError:rawMismatch,threshold,
    observedMean:terminal.input,predictedMean:predicted}
  return {check,diagnostics:{lowerContrast,upperMismatch,trainingUpper,initialBound,terminalBound,predictionBound,
    terminalInputSigma:terminal.inputSigma,terminalTemporalResidual:terminal.temporalResidual,fraction,alpha,
    uncertaintyScope:'Conditional independent Gaussian readout only; not spatial-model or source confidence'}}
}
