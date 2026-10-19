import {it,expect} from 'vitest'
import {channelReference} from './lib/channel-reference'
it('matches a delayed unit-step first-order response averaged over a full window',()=>{
 const input=Array.from({length:81},(_,i)=>({time:i*.25,value:1})),delay=.75398223686155,tau=2,w=1
 const values=channelReference(input,{delay,rise:tau,recovery:tau,average:w},.01)
 const integral=(t:number)=>{const u=Math.max(0,t-delay);return u-tau*(1-Math.exp(-u/tau))}
 values.forEach((v,i)=>expect(Math.abs(v-(integral(input[i]!.time)-integral(input[i]!.time-w))/w)).toBeLessThan(1e-8))
})
it('preserves clean prehistory and resolves a non-grid-aligned delay',()=>{
 const a=channelReference([{time:0,value:3},{time:.25,value:0},{time:.5,value:1}],{delay:.313,rise:1,recovery:2,average:1},.005)
 expect(a[0]).toBe(0);expect(a[1]).toBe(0);expect(a[2]).toBeGreaterThan(0)
})
