import {it,expect} from 'vitest'
import {gaussianPacket,makeTransportField} from './lib/m47-transport'
import {runM47Case,M47_ARMS,type M47Case} from './lib/m47-development'
const puff={released:0,mass:2,source:{x:0,y:0},sigma:.05},transport={wind:{x:.03,y:0},diffusivity:.0005}
it('conserves packet mass and gives expected advected mean and diffusive variance',()=>{
  const t=3,h=.01;let mass=0,mx=0,mxx=0
  for(let x=-1+h/2;x<1;x+=h)for(let y=-1+h/2;y<1;y+=h){
    const w=gaussianPacket({x,y},t,puff,transport).concentration*h*h;mass+=w;mx+=x*w;mxx+=x*x*w}
  expect(mass).toBeCloseTo(2,9);expect(mx/mass).toBeCloseTo(.09,9)
  expect(mxx/mass-(mx/mass)**2).toBeCloseTo(.05**2+2*.0005*t,9)
})
it('satisfies the advection-diffusion PDE away from injection',()=>{
  const p={x:.1,y:.04},t=3,h=1e-4
  const f=(x:number,y:number,time:number)=>gaussianPacket({x,y},time,puff,transport).concentration
  const dt=(f(p.x,p.y,t+h)-f(p.x,p.y,t-h))/(2*h)
  const gx=(f(p.x+h,p.y,t)-f(p.x-h,p.y,t))/(2*h)
  const lap=(f(p.x+h,p.y,t)+f(p.x-h,p.y,t)+f(p.x,p.y+h,t)+f(p.x,p.y-h,t)-4*f(p.x,p.y,t))/(h*h)
  expect(Math.abs(dt+.03*gx-.0005*lap)).toBeLessThan(1e-4)
})
it('matches analytic gradients to finite differences and is query-order independent',()=>{
  const f=makeTransportField('steady-release',transport),p={x:.3,y:.1},h=1e-5
  const a=f.evaluate(p,10)
  const gx=(f.evaluate({x:p.x+h,y:p.y},10).concentration-f.evaluate({x:p.x-h,y:p.y},10).concentration)/(2*h)
  expect(a.gradient.x).toBeCloseTo(gx,6)
  f.evaluate(p,25);expect(f.evaluate(p,10)).toEqual(a)
})
it('has no mass before packet release, and no field for absent sources',()=>{
  expect(gaussianPacket({x:0,y:0},-1,puff,transport).concentration).toBe(0)
  expect(makeTransportField('absent',transport).evaluate({x:.2,y:0},12).concentration).toBe(0)
  expect(()=>gaussianPacket({x:0,y:0},0,puff,{...transport,diffusivity:-1})).toThrow()
})
it('preserves equal observation budgets and absent-source abstention in transfer',()=>{
  const c:M47Case={kind:'absent',x:.3,y:0,wind:.03,diffusivity:.0005,noise:.003,seed:601,warmStart:false,rho:.7}
  const rs=M47_ARMS.map(a=>runM47Case(c,a))
  expect(rs.every(r=>!r.check.accepted)).toBe(true)
  expect(new Set(rs.map(r=>r.elapsedSeconds)).size).toBe(1)
  expect(new Set(rs.map(r=>r.readoutCount)).size).toBe(1)
  expect(rs.at(-1)!.distanceMetres).toBe(0)
})
