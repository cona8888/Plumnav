import {it,expect} from 'vitest'
import {noiseAwareFit,m42Random,balancedProbe} from './lib/m42-noise-probe'
import {fitSpatialPlane,type Reading,type Four} from './lib/m41-spatial-check'
import {runM42Case,M42_ARMS} from './lib/m42-development'
import {runM41Case} from './lib/m41-development'

const history=(v:Four):Reading[]=>Array.from({length:4},(_,i)=>({time:i+1,position:{x:0,y:0},heading:0,values:[...v]}))
it('separates below-detection, uncertain contact, uniform gas and directional evidence',()=>{
  expect(noiseAwareFit(history([0,0,0,0]),.1,.01,.01).state).toBe('below-detection')
  expect(noiseAwareFit(history([.075,.075,.075,.075]),.1,.01,.01).state).toBe('contact-uncertain')
  expect(noiseAwareFit(history([5,5,5,5]),.1,.01,.01).state).toBe('gas-unresolved')
  expect(noiseAwareFit(history([5.1,5,4.9,5]),.1,.01,.01).state).toBe('directional')
})
it('does not treat fixed-threshold noise contrast as resolved direction',()=>{
  const r=history([5.01,5,4.99,5])
  expect(fitSpatialPlane(r,.1,.01).direction).not.toBeNull()
  expect(noiseAwareFit(r,.1,.01,.01).fit.direction).toBeNull()
})
it('has the expected sigma/sqrt(N) and concentration-unit scaling',()=>{
  const r=history([5.1,5,4.9,5]),a=noiseAwareFit(r,.1,.01,.01)
  const b=noiseAwareFit([...r,...r.map(v=>({...v,time:v.time+4})),...r.map(v=>({...v,time:v.time+8})),...r.map(v=>({...v,time:v.time+12}))],.1,.01,.01)
  expect(b.contrastNormBound).toBeCloseTo(a.contrastNormBound/2)
  const c=noiseAwareFit(r.map(v=>({...v,values:v.values.map(x=>10*x) as Four})),.1,.1,.1,.01,.75)
  expect(c.state).toBe(a.state);expect(c.contrastNormBound).toBeCloseTo(10*a.contrastNormBound)
  expect(()=>noiseAwareFit(r,.1,.01,-1)).toThrow()
  expect(()=>noiseAwareFit(r,.1,.01,.01,0)).toThrow()
})
it('spreads adjacent seeded headings across quadrants and is reproducible',()=>{
  const angles=Array.from({length:64},(_,i)=>m42Random((i+101)^0x27d4eb2d)()*2*Math.PI)
  expect(new Set(angles.map(a=>Math.floor(a/(Math.PI/2)))).size).toBe(4)
  expect(Math.max(...angles)-Math.min(...angles)).toBeGreaterThan(5.5)
  const a=m42Random(7),b=m42Random(7)
  expect(Array.from({length:10},()=>a())).toEqual(Array.from({length:10},()=>b()))
})
it('uses a maximin two-mode score and exposes diagonal symmetry',()=>{
  const f=fitSpatialPlane(history([5.1,5,4.9,5]),.1,.01),p=balancedProbe(f,.1,.01)
  expect(p.score).toBeCloseTo(Math.max(...p.candidates.map(c=>c.score)),12)
  expect(Math.abs(p.direction.x)).toBeCloseTo(Math.SQRT1_2)
  expect(Math.abs(p.direction.y)).toBeCloseTo(Math.SQRT1_2)
  const q=balancedProbe({...f,direction:{x:-1,y:0}},.1,.01)
  expect(q.direction.x).toBeLessThan(0)
})
it('supports fresh witness checks and matched time across all arms',()=>{
  const rows=M42_ARMS.map(arm=>runM42Case({field:'cubic-reversal',seed:101},arm))
  expect(rows.find(r=>r.arm==='gated-balanced')!.check.accepted).toBe(false)
  expect(rows.find(r=>r.arm==='gated-stationary')!.check.accepted).toBe(true)
  expect(new Set(rows.map(r=>r.elapsedSeconds)).size).toBe(1)
  expect(new Set(rows.map(r=>r.readoutCount)).size).toBe(1)
})
it('retains matched gating across probe arms and suppresses noisy blank directions',()=>{
  for(const field of ['zero','uniform'] as const)for(const seed of [101,102,103,104,105,106,107,108]){
    const rows=M42_ARMS.filter(a=>a!=='fixed-directed').map(arm=>runM42Case({field,noise:.01,seed},arm))
    expect(rows.every(r=>!r.check.accepted)).toBe(true)
    expect(rows.every(r=>r.gate?.state=== (field==='zero'?'below-detection':'gas-unresolved'))).toBe(true)
    expect(new Set(rows.map(r=>r.baselineAccepted)).size).toBe(1)
  }
})
it('rotates the evaluator gradient correctly without feeding field angle to the policy',()=>{
  const a=runM41Case({field:'linear'}),b=runM41Case({field:'linear',fieldAngle:Math.PI/2})
  expect(b.initialDirection!.x).toBeCloseTo(-a.initialDirection!.y)
  expect(b.initialDirection!.y).toBeCloseTo(a.initialDirection!.x)
  expect(b.initialErrorDegrees!).toBeLessThan(1e-5)
})
