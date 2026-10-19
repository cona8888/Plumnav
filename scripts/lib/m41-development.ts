/** Small manufactured-field experiment, not methane transport or complete GSL. */
import { DelayedFourSensor, four, inletPositions, fitSpatialPlane, predictInlets,
  assessSpatialPrediction, spatialRegimeRatios, type Point, type Four, type Reading, type SpatialFit, type CheckResult } from './m41-spatial-check'
import { GSL_REFERENCE_DESIGN, normalizeGslDesign } from './gsl-dimensional-design'

export type FieldKind = 'linear' | 'quadratic' | 'cubic-reversal' | 'rotating-linear' | 'uniform' | 'zero'
export type Arm = 'directed-probe' | 'stationary-check' | 'random-probe'
export type M41Config = { field: FieldKind; arm: Arm; seed: number; feature: number;
  spacing: number; footprint: number; tau: number; delay: number; dwell: number;
  speed: number; step: number; sampleInterval: number; integrationStep: number;
  noise: number; tolerance: number; minimumContrast: number; correlationTime: number; fieldAngle?: number }
export const M41_REFERENCE: M41Config = {
  field: 'linear', arm: 'directed-probe', seed: 1, feature: 0.1,
  spacing: GSL_REFERENCE_DESIGN.opposingInletSpacingMetres, footprint: 0.002,
  tau: GSL_REFERENCE_DESIGN.sensorTimeConstantSeconds,
  delay: normalizeGslDesign(GSL_REFERENCE_DESIGN).derived.tubeDelaySeconds,
  dwell: 12, speed: 0.1, step: 0.01, sampleInterval: 1, integrationStep: 0.05,
  noise: 0, tolerance: 0.02, minimumContrast: 0.01, correlationTime: 20,
}
// These are arbitrary concentration units. Polynomial positivity is checked over
// every actual sampled location. Neither slope nor field callback enters policy.
const concentration = (p: Point, t: number, c: M41Config) => {
  const a=c.fieldAngle??0, co=Math.cos(a),si=Math.sin(a)
  const x=(p.x*co+p.y*si)/c.feature, y=(-p.x*si+p.y*co)/c.feature
  switch (c.field) {
    case 'zero': return 0
    case 'uniform': return 5
    case 'linear': return 5+0.1*x+0.06*y
    case 'quadratic': return 5+0.1*x+0.06*y+0.03*(x*x+y*y)
    case 'cubic-reversal': return 5+0.1*x-0.8*x*x*x
    case 'rotating-linear': return 5+0.1*(Math.cos(t/c.correlationTime)*x+Math.sin(t/c.correlationTime)*y)
  }
}
const bodyGradient = (p: Point,t: number,c: M41Config): Point => {
  const x=p.x/c.feature,y=p.y/c.feature
  switch(c.field) {
    case 'zero': case 'uniform': return {x:0,y:0}
    case 'linear': return {x:0.1/c.feature,y:0.06/c.feature}
    case 'quadratic': return {x:(0.1+0.06*x)/c.feature,y:(0.06+0.06*y)/c.feature}
    case 'cubic-reversal': return {x:(0.1-2.4*x*x)/c.feature,y:0}
    case 'rotating-linear': return {x:0.1*Math.cos(t/c.correlationTime)/c.feature,y:0.1*Math.sin(t/c.correlationTime)/c.feature}
  }
}
const truthGradient = (p:Point,t:number,c:M41Config):Point => {
  const a=c.fieldAngle??0,co=Math.cos(a),si=Math.sin(a)
  const g=bodyGradient({x:p.x*co+p.y*si,y:-p.x*si+p.y*co},t,c)
  return {x:g.x*co-g.y*si,y:g.x*si+g.y*co}
}
const angleError = (direction: Point|null, gradient: Point) => {
  if (!direction || Math.hypot(gradient.x,gradient.y)<1e-12) return null
  return Math.acos(Math.min(1,Math.max(-1,(direction.x*gradient.x+direction.y*gradient.y)/Math.hypot(gradient.x,gradient.y))))*180/Math.PI
}
const randomStream = (seed: number) => {
  let x=seed|0
  return () => { x=(Math.imul(x,1664525)+1013904223)|0; return ((x>>>0)+0.5)/4294967296 }
}
/** Optional observation-only hooks for subsequent research generations.
 * No field, seed, true gradient, feature scale or source information is passed.
 */
export type M41ObservationHooks = {
  fit?: (readings:Reading[],spacing:number,minimumContrast:number)=>SpatialFit;
  direction?: (fit:SpatialFit)=>Point;
  randomReadout?: ()=>number;
  history?: 'last-four'|'all';
  readoutNoise?: (independentNoise:Four)=>Four;
  check?: (fit:SpatialFit,observed:Reading[],predicted:Reading[],threshold:number)=>CheckResult;
}
export type M41World = {warmStart?:boolean;concentration?:(p:Point,t:number)=>number;gradient?:(p:Point,t:number)=>Point}
export const runM41Case = (overrides: Partial<M41Config> = {}, hooks:M41ObservationHooks = {}, world:M41World={}) => {
  const c={...M41_REFERENCE,...overrides}
  const rawRatios=spatialRegimeRatios(c)
  // A static witness has no finite correlation time. For the rotating witness
  // this is a prescribed inverse angular rate, not an empirical correlation time.
  const ratios={...rawRatios,
    memoryToCorrelation:c.field==='rotating-linear'?rawRatios.memoryToCorrelation:null,
    dwellToCorrelation:c.field==='rotating-linear'?rawRatios.dwellToCorrelation:null,
    samplingToCorrelation:c.field==='rotating-linear'?rawRatios.samplingToCorrelation:null}
  if (![c.step,c.speed,c.integrationStep,c.tolerance].every(v=>Number.isFinite(v)&&v>0) ||
    !Number.isFinite(c.noise)||c.noise<0 || !Number.isFinite(c.minimumContrast)||c.minimumContrast<0 ||
    !Number.isInteger(c.seed) || !Number.isFinite(c.fieldAngle??0) || c.integrationStep>c.sampleInterval/2 || c.dwell/c.sampleInterval<4 ||
    Math.abs(c.dwell/c.sampleInterval-Math.round(c.dwell/c.sampleInterval))>1e-8)
    throw new RangeError('Invalid experiment configuration; dwell needs >=4 complete samples')
  const rng=hooks.randomReadout??randomStream(c.seed)
  const noisy=(v: Four): Four=>{
    const independent=v.map(()=>c.noise*Math.sqrt(-2*Math.log(rng()))*Math.cos(2*Math.PI*rng())) as Four
    const noise=hooks.readoutNoise?hooks.readoutNoise(independent):independent
    if(noise.length!==4||noise.some(x=>!Number.isFinite(x)))throw new RangeError('Invalid readout noise')
    return v.map((x,i)=>x+noise[i]!) as Four
  }
  // Five-point isotropic local averaging around each mouth. A quadrature proxy,
  // not a validated suction kernel or a gas-flow intervention.
  const sample=(p:Point,t:number):Four=>inletPositions(p,0,c.spacing).map(m=>{
    const points=[m,{x:m.x+c.footprint,y:m.y},{x:m.x-c.footprint,y:m.y},
      {x:m.x,y:m.y+c.footprint},{x:m.x,y:m.y-c.footprint}]
    const values=points.map(q=>world.concentration?world.concentration(q,t):concentration(q,t,c))
    if(values.some(v=>v<0||!Number.isFinite(v))) throw new RangeError('Nonphysical manufactured sample')
    return values.reduce((a,b)=>a+b,0)/values.length
  }) as Four
  const timing={tau:c.tau,delay:c.delay}
  const origin={x:0,y:0}
  // Optional controlled equilibrium at t=0, not policy access to the field.
  const sensor=world.warmStart?new DelayedFourSensor(timing,0,sample(origin,0),sample(origin,0)):new DelayedFourSensor(timing)
  sensor.advance(0,sample(origin,0))
  const initial:Reading[]=[]
  const integrate=(start:number,duration:number,fn:(t:number,fraction:number)=>void)=>{
    const n=Math.ceil(duration/c.integrationStep)
    for(let i=1;i<=n;i++) fn(start+duration*i/n,i/n)
  }
  let nextRead=c.sampleInterval
  integrate(0,c.dwell,t=>{
    const values=sensor.advance(t,sample(origin,t))
    if(t>=nextRead-1e-9) {
      initial.push({time:t,position:origin,heading:0,values:noisy(values)})
      nextRead+=c.sampleInterval
    }
  })
  const window=(rs:Reading[])=>hooks.history==='all'?rs:rs.slice(-4)
  const fit=(hooks.fit??fitSpatialPlane)(window(initial),c.spacing,c.minimumContrast)
  const baselineAccepted=!!fit.direction && fit.trainingResidual<=c.tolerance
  // Predictor sees only the fitted initial observations and calibrated timing.
  // Its prehistory assumes settled fitted inlet values; it does NOT copy the
  // world's delayed queue or noiseless internal electronics state.
  const predictor=new DelayedFourSensor(timing,fit.time,fit.lastValues,predictInlets(fit,origin,0,c.spacing))
  const randomAngle=2*Math.PI*randomStream(c.seed+91001)()
  const direction=!baselineAccepted ? {x:0,y:0} : hooks.direction ? hooks.direction(fit)
    : c.arm==='stationary-check' ? {x:0,y:0}
    : c.arm==='random-probe' ? {x:Math.cos(randomAngle),y:Math.sin(randomAngle)} : fit.direction!
  if(!Number.isFinite(direction.x)||!Number.isFinite(direction.y)||Math.hypot(direction.x,direction.y)>1+1e-10)
    throw new RangeError('Invalid observation-policy motion')
  const endpoint={x:c.step*direction.x,y:c.step*direction.y}
  const movementSeconds=c.step/c.speed // stationary control waits the same time
  const observe=(p:Point,t:number)=>({
    actual:sensor.advance(t,sample(p,t)),
    predicted:predictor.advance(t,predictInlets(fit,p,0,c.spacing)),
  })
  integrate(c.dwell,movementSeconds,(t,f)=>observe({x:endpoint.x*f,y:endpoint.y*f},t))
  const observed:Reading[]=[],predicted:Reading[]=[]
  const movedAt=c.dwell+movementSeconds
  nextRead=movedAt+c.sampleInterval
  integrate(movedAt,c.dwell,t=>{
    const v=observe(endpoint,t)
    if(t>=nextRead-1e-9) {
      observed.push({time:t,position:endpoint,heading:0,values:noisy(v.actual)})
      predicted.push({time:t,position:endpoint,heading:0,values:v.predicted})
      nextRead+=c.sampleInterval
    }
  })
  const check=(hooks.check??assessSpatialPrediction)(fit,window(observed),window(predicted),c.tolerance)
  const finished=movedAt+c.dwell
  return {config:c,ratios,temporalScaleKind:c.field==='rotating-linear'?'prescribed-inverse-angular-rate':'static-no-finite-temporal-scale',baselineAccepted,check,
    initialDirection:fit.direction,trainingResidual:fit.trainingResidual,
    initialErrorDegrees:angleError(fit.direction,world.gradient?world.gradient(origin,c.dwell):truthGradient(origin,c.dwell,c)),
    endErrorDegrees:angleError(fit.direction,world.gradient?world.gradient(endpoint,finished):truthGradient(endpoint,finished,c)),
    elapsedSeconds:finished,initialDecisionSeconds:c.dwell,
    distanceMetres:Math.hypot(endpoint.x,endpoint.y),readoutCount:initial.length+observed.length,
    endpoint, purpose:'Manufactured-field diagnostic, not full GSL or calibrated confidence' }
}
