import {it,expect} from 'vitest'
import {transientSpatialFit,orientationProbe,rotatedCubicSensitivity} from './lib/m43-transient-probe'
import {fitSpatialPlane,type Reading,type Four} from './lib/m41-spatial-check'
import {runM43Case,M43_ARMS} from './lib/m43-development'

const make=(tau=3):Reading[]=>[1,2,3,4].map(t=>({time:t,position:{x:0,y:0},heading:0,
  values:[5.05,5.03,4.95,4.97].map((a,i)=>a+(-2+i*.1)*Math.exp(-(t-1)/tau)) as Four}))
it('recovers constant inlet levels from unknown transient amplitudes',()=>{
  const rs=make(),f=transientSpatialFit(rs,.1,.01,0,3,.75)
  expect(f.input[0]).toBeCloseTo(5.05,11);expect(f.fit.gradient.x).toBeCloseTo(1,10)
  expect(f.fit.gradient.y).toBeCloseTo(.6,10)
  expect(f.temporalResidual).toBeLessThan(1e-10)
  expect(f.fit.lastValues).toEqual(rs.at(-1)!.values)
})
it('propagates intercept readout variance instead of pretending four settled samples',()=>{
  const f=transientSpatialFit(make(),.1,.01,.01,3,.75)
  expect(f.weights.reduce((a,b)=>a+b,0)).toBeCloseTo(1,12)
  expect(f.inputSigma).toBeCloseTo(.01*Math.sqrt(f.weights.reduce((s,w)=>s+w*w,0)),12)
  expect(f.inputSigma).toBeGreaterThan(.01/2)
})
it('rejects invalid or unidentifiable fitting windows',()=>{
  expect(()=>transientSpatialFit(make(),.1,.01,.01,0,.75)).toThrow()
  expect(()=>transientSpatialFit(make(),.1,.01,.01,3,1)).toThrow()
  expect(()=>transientSpatialFit(make().slice(0,2),.1,.01,.01,3,.75)).toThrow()
})
it('flags a strongly non-exponential temporal record',()=>{
  const rs=make();rs[2]!.values[0]+=1
  const f=transientSpatialFit(rs,.1,.01,.01,3,.75)
  expect(f.temporalMismatch).toBe(true);expect(f.fit.direction).toBeNull()
})
it('rotated alternatives are invisible initially including mixed cubic terms',()=>{
  for(const a of [0,Math.PI/8,Math.PI/4,Math.PI/2])
    expect(Math.max(...rotatedCubicSensitivity(a,0,.1,0).map(Math.abs))).toBeLessThan(1e-12)
})
it('selects the maximum worst-alternative score from the declared candidates',()=>{
  const f=fitSpatialPlane(make(),.1,.01),p=orientationProbe(f,.1,.01)
  expect(p.score).toBeCloseTo(Math.max(...p.candidates.map(x=>x.score)),12)
  expect(p.score).toBeGreaterThan(0)
  expect(p.hypothesisCount).toBe(64)
})
it('recovers the slow-sensor linear case missed by the old steady fit',()=>{
  const c={field:'linear' as const,tau:3,dwell:4}
  expect(runM43Case(c,'m42-directed').check.accepted).toBe(false)
  expect(runM43Case(c,'lag-directed').check.accepted).toBe(true)
})
it('keeps blank directions suppressed and equal time/readouts across arms',()=>{
  for(const field of ['zero','uniform'] as const){
    const rows=M43_ARMS.map(a=>runM43Case({field,noise:.01,seed:201},a))
    expect(rows.every(r=>!r.check.accepted)).toBe(true)
    expect(new Set(rows.map(r=>r.elapsedSeconds)).size).toBe(1)
    expect(new Set(rows.map(r=>r.readoutCount)).size).toBe(1)
  }
})
