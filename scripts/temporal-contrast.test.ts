import {expect,it} from 'vitest'
import {temporalContrast} from './lib/temporal-contrast'
function fixture(peak:boolean,step=false){return [0,211].map(start=>({visits:Array.from({length:9},(_,i)=>({samples:[8,9,10,11].map(dt=>{const time=start+i*16+dt;return {time,hit:true,value:1+.08*Math.sin(2*Math.PI*time/47)+(step&&time>180?.2:0)-(peak&&i%2?.02:0)}})}))}))}
it('separates ideal common sinusoidal variation from a spatial flank deficit without a supplied period',()=>{
 expect(temporalContrast(fixture(false),.001,[[0,1,2,3],[0,1,2,3]]).supported).toBe(false)
 expect(temporalContrast(fixture(true),.001,[[0,1,2,3],[0,1,2,3]]).supported).toBe(true)
})
it('does not treat a mismatched temporal step or incomplete circuit as support',()=>{
 expect(temporalContrast(fixture(true,true),.001,[[0,1,2,3],[0,1,2,3]]).supported).toBe(false)
 expect(temporalContrast([], .001,[]).supported).toBe(false)
})
