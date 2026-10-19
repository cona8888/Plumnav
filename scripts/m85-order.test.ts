import {expect,it} from 'vitest'
import {evaluateLocalMaximumVisits} from '../src/sim/algorithms/localMaximumProbe'
it('reversing flank identity cannot eliminate a centre/flank time-alias counterexample',()=>{
  const offsets=[{x:.001,y:0},{x:-.001,y:0},{x:0,y:.001},{x:0,y:-.001}]
  const check=(order:number[],start:number)=>{
    const targets=[{x:0,y:0},...order.flatMap(i=>[offsets[i]!,{x:0,y:0}])]
    return evaluateLocalMaximumVisits(targets.map((target,i)=>({target,arrivedAt:start+i*16,
      samples:[8,9].map(dt=>({time:start+i*16+dt,value:i%2?.98:1,hit:true}))})),.001,2).supported
  }
  // Visit-level identifiability construction, not an additional physical run.
  expect(check([0,1,2,3],0)&&check([3,2,1,0],240)).toBe(true)
})
it('an all-or-nothing repeat rejects a genuine peak if temporal modulation masks one flank',()=>{
  const check=(values:number[])=>evaluateLocalMaximumVisits(values.map(value=>({target:{x:0,y:0},arrivedAt:0,
    samples:[8,9].map(time=>({time,value,hit:true}))})),.001,2).supported
  expect(check([1,.98,1,.98,1,.98,1,.98,1])).toBe(true)
  expect(check([1,1.01,1,.98,1,.98,1,.98,1])).toBe(false)
})
