import { expect, it } from 'vitest'
import { DelayedFourSensor, four, fitSpatialPlane, assessSpatialPrediction, inletPositions,
  spatialRegimeRatios, type Reading } from './lib/m41-spatial-check'
import { runM41Case, M41_REFERENCE } from './lib/m41-development'

it('implements a causal delayed exponential step without teleporting sensor state',()=>{
  const s=new DelayedFourSensor({tau:2,delay:1})
  expect(s.advance(0,four(1))).toEqual(four(0))
  expect(s.advance(0.5,four(1))).toEqual(four(0))
  expect(s.advance(1,four(1))).toEqual(four(0))
  expect(s.advance(3,four(1))[0]).toBeCloseTo(1-Math.exp(-1),12)
  expect(s.advance(3,four(0))[0]).toBeCloseTo(1-Math.exp(-1),12)
  expect(s.advance(4,four(0))[0]).toBeCloseTo(1-Math.exp(-1.5),12)
  expect(s.advance(6,four(0))[0]).toBeCloseTo((1-Math.exp(-1.5))*Math.exp(-1),12)
})
it('is independent of integration partition for held inputs',()=>{
  const a=new DelayedFourSensor({tau:0.91,delay:0.754}),b=new DelayedFourSensor({tau:0.91,delay:0.754})
  a.advance(0,four(2));b.advance(0,four(2))
  for(let i=1;i<100;i++) b.advance(i/10,four(2))
  expect(a.advance(10,four(2))[0]).toBeCloseTo(b.advance(10,four(2))[0],12)
})
it('rejects invalid timing and backwards time',()=>{
  expect(()=>new DelayedFourSensor({tau:0,delay:1})).toThrow()
  expect(()=>new DelayedFourSensor({tau:1,delay:-1})).toThrow()
  const s=new DelayedFourSensor({tau:1,delay:0});s.advance(1,four(0))
  expect(()=>s.advance(0,four(0))).toThrow()
  expect(()=>s.advance(2,four(NaN))).toThrow()
})
it('rotates physical inlet coordinates without changing their separation',()=>{
  const p=inletPositions({x:1,y:2},Math.PI/2,0.1)
  expect(p[0]!.y).toBeCloseTo(2.05);expect(p[2]!.y).toBeCloseTo(1.95)
})
it('fits a plane from fixed-pose data and requires genuinely subsequent evidence',()=>{
  const r:Reading={time:1,position:{x:0,y:0},heading:0,values:[5.05,5.03,4.95,4.97]}
  const f=fitSpatialPlane([r],0.1,0.01)
  expect(f.gradient.x).toBeCloseTo(1);expect(f.gradient.y).toBeCloseTo(0.6)
  expect(assessSpatialPrediction(f,[r],[r],0.02).accepted).toBe(false)
  expect(()=>fitSpatialPlane([r,{...r,time:2,position:{x:1,y:0}}],0.1,0.01)).toThrow()
})
it('accepts the linear witness with a causal reference sensor',()=>{
  const r=runM41Case()
  expect(r.baselineAccepted).toBe(true);expect(r.check.accepted).toBe(true)
  expect(r.initialErrorDegrees!).toBeLessThan(1e-5)
})
it('detects the cubic wrong-direction witness that an equal-time stationary check misses',()=>{
  const probe=runM41Case({field:'cubic-reversal'}),hold=runM41Case({field:'cubic-reversal',arm:'stationary-check'})
  expect(probe.baselineAccepted).toBe(true)
  expect(probe.initialErrorDegrees!).toBeGreaterThan(179)
  expect(probe.endErrorDegrees!).toBeGreaterThan(179)
  expect(probe.trainingResidual).toBeLessThan(1e-8)
  expect(probe.check.accepted).toBe(false);expect(hold.check.accepted).toBe(true)
  expect(probe.elapsedSeconds).toBe(hold.elapsedSeconds)
  expect(probe.readoutCount).toBe(hold.readoutCount)
})
it('does not manufacture a direction in uniform or zero controls',()=>{
  for(const field of ['zero','uniform'] as const){
    const r=runM41Case({field});expect(r.baselineAccepted).toBe(false)
    expect(r.check.accepted).toBe(false);expect(r.initialErrorDegrees).toBeNull()
  }
})
it('replays noisy cases deterministically and keeps controls time matched',()=>{
  const p={field:'quadratic' as const,noise:0.01,seed:7}
  expect(runM41Case(p)).toEqual(runM41Case(p))
  const rows=(['directed-probe','stationary-check','random-probe'] as const).map(arm=>runM41Case({...p,arm}))
  expect(new Set(rows.map(r=>r.elapsedSeconds)).size).toBe(1)
  expect(new Set(rows.map(r=>r.readoutCount)).size).toBe(1)
})
it('preserves reduced-model similarity when length and time scales are transformed together',()=>{
  const c={...M41_REFERENCE,field:'rotating-linear' as const}
  const a=runM41Case(c), L=10,T=2
  const b=runM41Case({...c,spacing:c.spacing*L,footprint:c.footprint*L,feature:c.feature*L,
    step:c.step*L,speed:c.speed*L/T,tau:c.tau*T,delay:c.delay*T,dwell:c.dwell*T,
    sampleInterval:c.sampleInterval*T,integrationStep:c.integrationStep*T,correlationTime:c.correlationTime*T})
  for(const key of Object.keys(a.ratios) as (keyof typeof a.ratios)[])expect(b.ratios[key]).toBeCloseTo(a.ratios[key],12)
  expect(b.check.maximumError!).toBeCloseTo(a.check.maximumError!,10)
  expect(b.check.accepted).toBe(a.check.accepted)
  expect(b.elapsedSeconds).toBeCloseTo(a.elapsedSeconds*T)
})
it('rejects missing plume scales rather than treating them as zero',()=>{
  expect(()=>spatialRegimeRatios({...M41_REFERENCE,correlationTime:0})).toThrow()
  expect(()=>runM41Case({dwell:2})).toThrow()
})
