import {expect,it} from 'vitest'
import {HalfspaceTransport,type HalfspaceSettings} from './lib/halfspace-transport'
const settings:HalfspaceSettings={source:{x:0,y:0,z:0.025},wind:{x:0.02,y:0},diffusivity:0.001,
  sigma:0.15,rateKgPerSecond:2e-9,panelSeconds:1}
it('preserves blank, linear mass accounting and ground reflection',()=>{
  const f=new HalfspaceTransport(settings)
  expect(f.integratedMassAt(300)).toBeCloseTo(6e-7,15)
  expect(f.evaluate({x:0.2,y:0.1,z:0},100).gradient.z).toBe(0)
  expect(new HalfspaceTransport({...settings,rateKgPerSecond:0}).evaluate({x:0,y:0,z:0.05},300).concentration).toBe(0)
  const pulse=new HalfspaceTransport({...settings,pulse:{periodSeconds:20,phaseSeconds:5}})
  expect(pulse.integratedMassAt(100)).toBeCloseTo(1e-7,15)
})
it('satisfies the source-free 3-D advection-diffusion equation for a pulse',()=>{
  const f=new HalfspaceTransport(settings),p={x:0.2,y:0.1,z:0.05},t=3,h=1e-4
  const value=(q= p,age=t)=>f.pulseAt(q,age,1).concentration
  const dt=(value(p,t+h)-value(p,t-h))/(2*h)
  let lap=0
  for(const axis of ['x','y','z'] as const)lap+=(value({...p,[axis]:p[axis]+h})-2*value()+value({...p,[axis]:p[axis]-h}))/h**2
  const gx=f.pulseAt(p,t,1).gradient.x
  expect(Math.abs(dt+settings.wind.x*gx-settings.diffusivity*lap)/Math.max(1,Math.abs(dt))).toBeLessThan(1e-5)
})
it('converges for concentration and opposing-inlet difference across release-step refinement',()=>{
  for(const pulse of [undefined,{periodSeconds:20,phaseSeconds:5}]) {
    const values=[4,2,1].map(panelSeconds=>{
      const f=new HalfspaceTransport({...settings,panelSeconds,pulse})
      const a=f.evaluate({x:0.35,y:0,z:0.05},307).concentration
      const b=f.evaluate({x:0.45,y:0,z:0.05},307).concentration
      return {a,d:a-b}
    })
    expect(Math.abs(values[1]!.a-values[2]!.a)/values[2]!.a).toBeLessThan(1e-5)
    expect(Math.abs(values[1]!.d-values[2]!.d)/Math.abs(values[2]!.d)).toBeLessThan(1e-5)
  }
})
it('is query-order independent and rejects invalid units/geometry',()=>{
  const f=new HalfspaceTransport(settings),p={x:0.4,y:0,z:0.05},a=f.evaluate(p,30)
  f.evaluate(p,5);expect(f.evaluate(p,30)).toEqual(a)
  expect(()=>f.evaluate({...p,z:-1},30)).toThrow()
  expect(()=>new HalfspaceTransport({...settings,diffusivity:-1})).toThrow()
  expect(()=>f.evaluate(p,-1)).toThrow()
})
