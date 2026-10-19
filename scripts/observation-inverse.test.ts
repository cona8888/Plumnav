import {expect,it} from 'vitest'
import {fitVisible,predictVisible,type VisibleInverseData} from './lib/observation-inverse'
function fixture(){const data:VisibleInverseData={poses:Array.from({length:480},(_,i)=>({time:i*.25,x:Math.floor(i/40)%3===1?1:0,y:Math.floor(i/40)%3===2?1:0})),samples:[]};const y=predictVisible(data,[1,.02,.03,.04],null);for(let i=20;i<480;i+=4)data.samples.push({index:i,value:y[i]!,hit:true,train:Math.floor(i/40)%2===0});return data}
it('recovers a noise-free instantaneous quadratic model from visible observations',()=>{const fit=fitVisible(fixture(),null,.001);expect(fit.supported).toBe(true);fit.coefficients.forEach((v,i)=>expect(v).toBeCloseTo([1,.02,.03,.04][i]!,5))})
it('does not use withheld values while fitting coefficients',()=>{const a=fixture(),b=structuredClone(a);b.samples.filter(s=>!s.train).forEach(s=>s.value+=.5);const x=fitVisible(a,null,.001),y=fitVisible(b,null,.001);expect(x.coefficients).toEqual(y.coefficients);expect(y.supported).toBe(false)})
it('rejects a flat field rather than inferring a two-axis maximum',()=>{const a=fixture();a.samples.forEach(s=>s.value=1);expect(fitVisible(a,null,.001).supported).toBe(false)})
