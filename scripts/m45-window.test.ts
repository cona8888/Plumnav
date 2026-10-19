import {it,expect} from 'vitest'
import {runM45Case,correlatedReadout,M45_ARMS} from './lib/m45-window-development'
import {runM44Case} from './lib/m44-development'
it('preserves M44 four-sample decisions, noise and motion',()=>{
  for(const field of ['linear','cubic-reversal','rotating-linear','uniform','zero'] as const)
    for(const noise of [0,.003,.01]){
      const c={field,noise,seed:401},a=runM44Case(c,'relative-directed'),b=runM45Case(c,'four-directed')
      expect(b.check).toEqual(a.check);expect(b.initialDirection).toEqual(a.initialDirection)
      expect(b.endpoint).toEqual(a.endpoint)
    }
})
it('uses 12 instead of 4 samples without buying extra time or observations',()=>{
  const rs=M45_ARMS.map(a=>runM45Case({dwell:12},a))
  expect(rs.map(r=>r.initialCount)).toEqual([4,12,12,12])
  expect(rs.map(r=>r.terminalCount)).toEqual([4,12,12,12])
  expect(new Set(rs.map(r=>r.elapsedSeconds)).size).toBe(1)
  expect(new Set(rs.map(r=>r.readoutCount)).size).toBe(1)
})
it('four-second windows give exactly the same directed result',()=>{
  for(const noise of [0,.003,.01]){
    const a=runM45Case({dwell:4,noise},'four-directed'),b=runM45Case({dwell:4,noise},'full-directed')
    expect(b.check).toEqual(a.check);expect(b.initialSigma).toBe(a.initialSigma)
  }
})
it('reduces intercept readout variance with longer fixed-pose history',()=>{
  for(const tau of [.9102392266268373,3]){
    const a=runM45Case({tau,noise:.01},'four-directed'),b=runM45Case({tau,noise:.01},'full-directed')
    expect(b.initialSigma).toBeLessThan(a.initialSigma)
  }
})
it('preserves noiseless linear acceptance and rejects the known moving cubic alias',()=>{
  expect(runM45Case({tau:3},'full-directed').check.accepted).toBe(true)
  expect(runM45Case({tau:3,field:'cubic-reversal'},'full-orientation').check.accepted).toBe(false)
})
it('implements the stationary-marginal AR recurrence and validates settings',()=>{
  const f=correlatedReadout(.6)
  expect(f([1,2,3,4])).toEqual([1,2,3,4])
  expect(f([0,0,0,0])).toEqual([.6,1.2,1.7999999999999998,2.4])
  expect(()=>correlatedReadout(1)).toThrow()
  expect(()=>runM45Case({},'full-directed',{tauFactor:0})).toThrow()
})
it('keeps world timing fixed when the assumed response is perturbed',()=>{
  const a=runM45Case({},'full-directed'),b=runM45Case({},'full-directed',{tauFactor:1.2,rho:.7})
  expect(b.config).toEqual(a.config);expect(b.elapsedSeconds).toBe(a.elapsedSeconds)
  expect(b.stress).toEqual({tauFactor:1.2,rho:.7})
})
