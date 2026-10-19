import {add,magnitude,normalize,scale,sub} from '../math'
import type {AlgorithmEnvironment,Vec2} from '../types'
import {PHYSICAL_VIEWPOINT_SPEED} from './physicalAcquisition'

/** One measured-head-spacing step, not a source estimate or line of bearing.
 * Fixed length is geometry-derived, not fitted against source truth. No claim
 * of guaranteed ascent in noisy or time-varying fields is made.
 */
export function selectLocalGradientStep(environment:AlgorithmEnvironment,position:Vec2,cue:Vec2,dt:number) {
  const inspection=environment.inspectionContract,lifecycle=environment.candidateLifecycle
  if(!inspection||!lifecycle||environment.maxSpeed<=0||!Number.isFinite(dt)||dt<=0||
      ![position.x,position.y,cue.x,cue.y].every(Number.isFinite)||magnitude(cue)<1e-12)return null
  const step=2*environment.activeSniffReach
  if(step<=2*inspection.arrivalRadiusNormalized)return null
  const target=add(position,scale(normalize(cue),step))
  if(Array.from({length:17},(_,i)=>add(position,scale(sub(target,position),i/16))).some(p=>environment.isBlocked(p)))return null
  const travelAllowance=step/(environment.maxSpeed*PHYSICAL_VIEWPOINT_SPEED)+Math.PI/lifecycle.maximumTurnRateRadiansPerSecond+2*dt
  return {target,arrivalRadius:inspection.arrivalRadiusNormalized,travelAllowance,
    returnAllowance:travelAllowance+environment.activeSniffCycleSeconds+dt}
}
