import {it,expect} from 'vitest'
import {missionDirection,PeakDeclaration,runM48Mission,M48_ARMS} from './lib/m48-mission'
it('uses identical fallback when the cue abstains',()=>{
  for(const contact of [false,true])for(let cycle=0;cycle<5;cycle++){
    const ds=M48_ARMS.map(a=>missionDirection(a,contact,cycle,null,{x:.02,y:0}))
    expect(ds[1]).toEqual(ds[0]);expect(ds[2]).toEqual(ds[0])
  }
})
it('retains upwind progress while incorporating the crosswind cue',()=>{
  const d=missionDirection('wind-gradient-cue',true,0,{x:0,y:-1},{x:.02,y:0})
  expect(d.x).toBeLessThan(0);expect(d.y).toBeLessThan(0);expect(Math.hypot(d.x,d.y)).toBeCloseTo(1)
})
it('cannot declare a source from zeros or a single decrease',()=>{
  const d=new PeakDeclaration()
  for(let i=0;i<10;i++)expect(d.update({x:i*.1,y:0},0,i*.1)).toBeNull()
  d.update({x:0,y:0},1,1)
  expect(d.update({x:.1,y:0},.5,1.2)).toBeNull()
  expect(d.update({x:.2,y:0},.5,1.3)).toEqual({x:0,y:0})
})
it('does not declare without sufficient travelled distance',()=>{
  const d=new PeakDeclaration();d.update({x:0,y:0},1,0)
  d.update({x:.01,y:0},.5,.01)
  expect(d.update({x:.02,y:0},.5,.02)).toBeNull()
})
it('keeps absent-source mission caps, fallback and observation counts matched',()=>{
  const c={kind:'absent' as const,start:{x:.6,y:.15},noise:0,seed:701,cycles:2}
  const rs=M48_ARMS.map(a=>runM48Mission(c,a))
  for(const r of rs){expect(r.declared).toBeNull();expect(r.success).toBe(false)
    expect(r.readoutCount).toBe(48);expect(r.elapsedSeconds).toBeCloseTo(50.2,10)}
  expect(rs[1]!.trace).toEqual(rs[0]!.trace);expect(rs[2]!.trace).toEqual(rs[0]!.trace)
})
it('replays a complete observed mission deterministically',()=>{
  const c={kind:'steady-release' as const,start:{x:.6,y:.15},noise:.003,seed:701,cycles:2}
  expect(runM48Mission(c,'wind-gradient-cue')).toEqual(runM48Mission(c,'wind-gradient-cue'))
})
