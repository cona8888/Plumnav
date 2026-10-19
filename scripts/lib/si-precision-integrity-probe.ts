import type {AlgorithmEnvironment,Vec2} from '../../src/sim/types'
import {SIClockedIntegrityProbe} from './si-clocked-integrity-probe'

/** Research-only 1 mm arrival policy. The configuration's original design
 * radius remains intact and is archived beside this effective value. */
export class SIPrecisionIntegrityProbe extends SIClockedIntegrityProbe {
 constructor(environment:AlgorithmEnvironment,candidate:Vec2,domainMetres:number) {
  if(!Number.isFinite(domainMetres)||domainMetres<=0||!environment.inspectionContract)throw Error('Invalid precision fixture')
  const effective=0.001/domainMetres
  if(effective>=environment.inspectionContract.arrivalRadiusNormalized)throw Error('Precision fixture must tighten arrival radius')
  super({...environment,inspectionContract:{...environment.inspectionContract,arrivalRadiusNormalized:effective}},candidate)
 }
}
