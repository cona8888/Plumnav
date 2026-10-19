import {it,expect} from 'vitest'
import {runM44Case,M44_ARMS} from './lib/m44-development'
import {runM43Case} from './lib/m43-development'
import {relativeInputCheck} from './lib/m44-relative-check'
import {fitSpatialPlane,type Reading} from './lib/m41-spatial-check'

it('preserves the absolute M43 directed baseline exactly',()=>{
  for(const field of ['linear','cubic-reversal','rotating-linear','zero','uniform'] as const)
    for(const noise of [0,.01]){
      const c={field,noise,seed:301,tau:3,dwell:4},a=runM43Case(c,'lag-directed'),b=runM44Case(c,'absolute-directed')
      expect(b.check).toEqual(a.check);expect(b.endpoint).toEqual(a.endpoint)
      expect(b.initialDirection).toEqual(a.initialDirection)
    }
})
it('retains a noiseless slow-sensor linear signal',()=>{
  for(const arm of M44_ARMS)expect(runM44Case({tau:3,dwell:4},arm).check.accepted).toBe(true)
})
it('rejects the known filtered 180 degree cubic failure',()=>{
  const c={field:'cubic-reversal' as const,tau:3,dwell:4}
  expect(runM43Case(c,'lag-orientation').check.accepted).toBe(true)
  for(const integrationStep of [.05,.025,.0125]){
    const r=runM44Case({...c,integrationStep},'relative-orientation')
    expect(r.endErrorDegrees).toBeGreaterThan(179)
    expect(r.check.accepted).toBe(false)
  }
})
it('does not pretend stationary observations resolve an invisible cubic',()=>{
  const r=runM44Case({field:'cubic-reversal',tau:3,dwell:4},'relative-stationary')
  expect(r.check.accepted).toBe(true);expect(r.endErrorDegrees).toBeGreaterThan(179)
})
it('maintains equal observation and time budgets and suppresses blank directions',()=>{
  for(const field of ['linear','uniform','zero'] as const){
    const rs=M44_ARMS.map(a=>runM44Case({field,seed:301,noise:.01},a))
    expect(new Set(rs.map(r=>r.elapsedSeconds)).size).toBe(1)
    expect(new Set(rs.map(r=>r.readoutCount)).size).toBe(1)
    if(field!=='linear')expect(rs.every(r=>!r.check.accepted)).toBe(true)
  }
})
it('uses positive uncertainty margins, rather than accepting wide error bars',()=>{
  const r=runM44Case({noise:.01},'relative-directed'),d=r.diagnostics!
  expect(d.initialBound).toBeGreaterThan(0)
  expect(d.upperMismatch).toBeGreaterThan(r.check.maximumError!)
  expect(d.predictionBound).toBeGreaterThan(d.initialBound as number)
  expect(r.check.accepted).toBe(false)
})
it('checks tube transition relative to movement completion',()=>{
  const rs:Reading[]=[1,2,3,4].map(t=>({time:t+4,position:{x:0,y:0},heading:0,values:[5.05,5.03,4.95,4.97]}))
  const fit=fitSpatialPlane(rs,.1,.01)
  expect(()=>relativeInputCheck(fit,rs,0,{spacing:.1,minimumContrast:.01,noise:0,tau:3,delay:.75,movedAt:4.5})).toThrow()
})
