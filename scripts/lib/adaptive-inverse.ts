import {fitPeriodic,selectPeriod,type VisibleInverseData,type Response} from './periodic-inverse'
import {fitOffset,selectOffsetPeriod} from './offset-inverse'
/** Prefer the restricted model whenever its training residual is adequate.
 * Never fall back because of a validation failure, missing curvature or support.
 * This is a pre-specified adequacy rule, not statistical model-selection proof. */
export function fitAdaptive(data:VisibleInverseData,response:Response|null,noise:number){
 const centredSelection=selectPeriod(data,noise),centred=fitPeriodic(data,response,noise,centredSelection.period)
 if(centred.trainingPlausible)return {model:'centred',period:centredSelection.period,...centred}
 const offsetSelection=selectOffsetPeriod(data,noise),offset=fitOffset(data,response,noise,offsetSelection.period)
 return {model:'offset',period:offsetSelection.period,...offset}
}
