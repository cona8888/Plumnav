import {it,expect} from 'vitest'
import {runM46Case,M46_ARMS} from './lib/m46-development'
import {runM45Case} from './lib/m45-window-development'
import {calibrationGrid,correlationInflation,fitCalibrationEnvelope} from './lib/m46-calibration-envelope'
import {transientSpatialFit} from './lib/m43-transient-probe'
import type {Reading} from './lib/m41-spatial-check'
it('preserves nominal M45 directed decisions and motion',()=>{
  for(const field of ['linear','cubic-reversal','rotating-linear','zero','uniform'] as const)
    for(const noise of [0,.003,.01]){
      const c={field,noise,seed:501},a=runM45Case(c,'full-directed'),b=runM46Case(c,'nominal-directed')
      expect(b.check.accepted).toBe(a.check.accepted);expect(b.endpoint).toEqual(a.endpoint)
      expect(b.initialDirection).toEqual(a.initialDirection)
    }
})
it('defines a finite grid without claiming continuous calibration coverage',()=>{
  const g=calibrationGrid(1)
  expect(g).toHaveLength(21);expect(g[0]).toBe(.75);expect(g.at(-1)).toBe(1.25)
  expect(()=>calibrationGrid(0)).toThrow();expect(()=>correlationInflation(1)).toThrow()
})
it('recovers a noiseless linear startup with a compatible grid calibration',()=>{
  const c={noise:0,seed:501},s={tauFactor:.8}
  expect(runM46Case(c,'nominal-directed',s).check.accepted).toBe(false)
  expect(runM46Case(c,'grid-directed',s).check.accepted).toBe(true)
})
it('keeps cold-start and warm-start comparisons at equal budgets',()=>{
  for(const warmStart of [false,true]){
    const rs=M46_ARMS.map(a=>runM46Case({seed:501},a,{warmStart}))
    expect(new Set(rs.map(r=>r.elapsedSeconds)).size).toBe(1)
    expect(new Set(rs.map(r=>r.readoutCount)).size).toBe(1)
    expect(rs.find(r=>r.arm==='bounded-stationary')!.distanceMetres).toBe(0)
  }
})
it('retains blank abstention and does not erase stationary spatial ambiguity',()=>{
  for(const field of ['zero','uniform'] as const)for(const warmStart of [false,true])
    expect(runM46Case({field},'bounded-directed',{warmStart}).check.accepted).toBe(false)
  const r=runM46Case({field:'cubic-reversal'},'bounded-stationary',{warmStart:true})
  expect(r.check.accepted).toBe(true);expect(r.endErrorDegrees).toBeGreaterThan(179)
})
it('bounds AR(1) intercept variance for positive and negative correlations',()=>{
  const rs:Reading[]=Array.from({length:12},(_,i)=>({time:i+1,heading:0,position:{x:0,y:0},values:[5.1,5,4.9,5]}))
  const f=transientSpatialFit(rs,.1,.01,1,3,.75),w=f.weights
  for(const rho of [-.7,-.3,0,.3,.7]){
    const variance=w.reduce((s,x,i)=>s+w.reduce((t,y,j)=>t+x*y*rho**Math.abs(i-j),0),0)
    const bound=correlationInflation(.7)**2*w.reduce((s,x)=>s+x*x,0)
    expect(variance).toBeLessThanOrEqual(bound+1e-12)
  }
})
it('does not discard temporally plausible candidates solely because direction is unresolved',()=>{
  const rs:Reading[]=[1,2,3,4].map(time=>({time,heading:0,position:{x:0,y:0},values:[5,5,5,5]}))
  const f=fitCalibrationEnvelope(rs,{spacing:.1,minimumContrast:.01,noise:0,delay:.75,nominalTau:1,rhoBound:0})
  expect(f.plausible).toHaveLength(21);expect(f.fit.direction).toBeNull()
})
