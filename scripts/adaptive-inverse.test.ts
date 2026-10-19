import {expect,it} from 'vitest'
import {fitAdaptive} from './lib/adaptive-inverse'
import {predictOffset,type VisibleInverseData} from './lib/offset-inverse'
function fixture(gx:number){const xy=[[0,0],[1,0],[-1,0],[0,1],[0,-1]],d:VisibleInverseData={poses:Array.from({length:1000},(_,i)=>({time:i*.25,x:xy[Math.floor(i/31)%5]![0]!,y:xy[Math.floor(i/31)%5]![1]!})),samples:[]},y=predictOffset(d,[1,0,.04,.04,gx,0],null,0);for(let i=4;i<1000;i+=4)d.samples.push({index:i,value:y[i]!,hit:true,train:i%12!==0});return d}
it('prefers the centred model when training is adequate',()=>expect(fitAdaptive(fixture(0),null,.001).model).toBe('centred'))
it('uses gradients for inadequate centred training',()=>{const f=fitAdaptive(fixture(.03),null,.001);expect(f.model).toBe('offset');expect(f.supported).toBe(true)})
it('does not rescue a validation failure with a more flexible model',()=>{const d=fixture(0);d.samples.filter(s=>!s.train).forEach(s=>s.value+=.5);const f=fitAdaptive(d,null,.001);expect(f.model).toBe('centred');expect(f.supported).toBe(false)})
