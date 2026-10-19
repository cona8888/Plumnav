import {expect,it} from 'vitest'
import {selectedTemporalContrast} from './lib/temporal-selection'
const orders=[[0,1,2,3],[0,1,2,3]]
function data(peak:boolean,step=false,sine=false){return [0,240].map(start=>({visits:Array.from({length:9},(_,i)=>({samples:[8,9,10,11].map(dt=>{const time=start+i*16+dt;return {time,hit:true,value:1+(step&&start?.08:0)+(sine?.08*Math.sin(2*Math.PI*time/83):0)-(peak&&i%2?.02:0)}})}))}))}
it('prefers a sufficient affine model to unnecessary periodic fitting',()=>{
 const r=selectedTemporalContrast(data(true),.001,orders)
 expect(r.model).toBe('global-affine');expect(r.supported).toBe(true)
 expect(selectedTemporalContrast(data(false),.001,orders).supported).toBe(false)
})
it('isolates the between-round offset assumption from the global selector',()=>{
 expect(selectedTemporalContrast(data(true,true),.001,orders,true).model).toBe('per-round-affine')
 expect(selectedTemporalContrast(data(true,true),.001,orders,true).supported).toBe(true)
 expect(selectedTemporalContrast(data(false,true),.001,orders,true).supported).toBe(false)
})
it('retains the harmonic branch when an affine trend cannot explain centre data',()=>{
 expect(selectedTemporalContrast(data(true,false,true),.001,orders).model).toBe('harmonic')
 expect(selectedTemporalContrast([], .001,orders).supported).toBe(false)
})
it('retains the explicit sequential-time identifiability limitation',()=>{
 // Exactly these measurements could come from uniform temporal alternation.
 expect(selectedTemporalContrast(data(true),.001,orders,true).supported).toBe(true)
})
