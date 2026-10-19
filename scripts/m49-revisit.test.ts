import {it,expect} from 'vitest'
import {runM48Mission,M48_ARMS} from './lib/m48-mission'
it('charges revisits to time, readouts and distance caps',()=>{
  for(const arm of M48_ARMS){
    const r=runM48Mission({kind:'interrupted-release',start:{x:.6,y:.15},noise:0,seed:801},arm,{confirmation:'revisit'})
    expect(r.confirmations.length).toBeGreaterThan(0)
    expect(r.elapsedSeconds).toBeLessThanOrEqual(251+1e-8)
    expect(r.readoutCount).toBeLessThanOrEqual(240)
    expect(r.distanceMetres).toBeLessThanOrEqual(1.1+1e-8)
    expect(r.declared).toBeNull()
  }
})
it('never converts unavailable confirmation budget into a declaration',()=>{
  const r=runM48Mission({kind:'interrupted-release',start:{x:.6,y:0},noise:0,seed:801,cycles:3},'wind-cast',{confirmation:'revisit'})
  expect(r.declared).toBeNull()
  expect(r.confirmations[0]?.reason).toBe('insufficient-budget')
})
it('keeps no-source missions free of declarations and confirmation visits',()=>{
  const r=runM48Mission({kind:'absent',start:{x:.6,y:.15},noise:.003,seed:801},'wind-gradient-cue',{confirmation:'revisit'})
  expect(r.confirmations).toEqual([]);expect(r.declared).toBeNull()
})
