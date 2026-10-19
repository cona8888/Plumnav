import {it,expect} from 'vitest'
import {fitPeriodic,predictPeriodic,selectPeriod,type VisibleInverseData} from './lib/periodic-inverse'
import {fitVisible} from './lib/observation-inverse'
function fixture(period=53){const data:VisibleInverseData={poses:Array.from({length:1600},(_,i)=>({time:i*.25,x:Math.floor(i/53)%3===1?1:0,y:Math.floor(i/53)%3===2?1:0})),samples:[]};const y=predictPeriodic(data,period?[1,.01,.03,.04,.06,.02]:[1,.01,.03,.04],null,period);for(let i=20;i<1600;i+=4)data.samples.push({index:i,value:y[i]!,hit:true,train:Math.floor(i/53)%2===0});return data}
it('learns a periodic component from training measurements',()=>{const d=fixture(),s=selectPeriod(d,.001);expect(s.period).toBe(53);expect(fitPeriodic(d,null,.001,s.period).supported).toBe(true)})
it('keeps period selection and coefficients independent of withheld values',()=>{const a=fixture(),b=structuredClone(a);b.samples.filter(s=>!s.train).forEach(s=>s.value+=.5);expect(selectPeriod(a,.001)).toEqual(selectPeriod(b,.001));expect(fitPeriodic(a,null,.001,53).coefficients).toEqual(fitPeriodic(b,null,.001,53).coefficients);expect(fitPeriodic(b,null,.001,53).supported).toBe(false)})
it('retains the affine model and its frozen output when sufficient',()=>{const d=fixture(0);expect(selectPeriod(d,.001).period).toBe(0);expect(fitPeriodic(d,null,.001,0)).toEqual(fitVisible(d,null,.001))})
