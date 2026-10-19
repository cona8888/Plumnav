import {integrationConfig,type IntegrationSpec} from './si-integration'
import type {SniffPolicy} from './si-encounter-gate'
export type SchedulingSpec=IntegrationSpec&{panel:'encounter-scheduling-v1';worldIndex:number;policy:SniffPolicy}
export const SCHEDULING_ARMS=[{method:'coverage',policy:'reference'},{method:'surge-cast',policy:'reference'},{method:'quad-sniff-refine',policy:'reference'},{method:'quad-sniff-refine',policy:'encounter-gated'}] as const
export function schedulingCases(){
 const out:SchedulingSpec[]=[]
 for(let worldIndex=0;worldIndex<16;worldIndex++)for(const field of ['si-continuous','si-pulse','blank'] as const)for(const arm of SCHEDULING_ARMS)
  for(const navDt of worldIndex<2?[1/16,1/32,1/64]:[1/16])out.push({index:out.length,panel:'encounter-scheduling-v1',worldIndex,replicate:100+worldIndex,field,...arm,navDt,worldSeed:121301+worldIndex,sourceSeed:121501+worldIndex,startSeed:121701+worldIndex,controllerSeed:121901+worldIndex})
 if(out.length!==240)throw Error('Incorrect scheduling design')
 return out
}
export const schedulingConfig=integrationConfig
