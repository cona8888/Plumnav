import {schedulingCases,SCHEDULING_ARMS,type SchedulingSpec} from './si-scheduling-design'
export type TurnSpec=Omit<SchedulingSpec,'panel'>&{panel:'turn-diagnostic'|'turn-fresh'}
export function turnCases(panel:TurnSpec['panel']):TurnSpec[]{
 if(panel==='turn-diagnostic')return schedulingCases().filter(s=>s.worldIndex===1).map((s,index)=>({...s,index,panel}))
 if(panel!=='turn-fresh')throw Error('Unknown turn panel')
 const out:TurnSpec[]=[]
 for(let worldIndex=0;worldIndex<2;worldIndex++)for(const field of ['si-continuous','si-pulse','blank'] as const)for(const arm of SCHEDULING_ARMS)for(const navDt of [1/16,1/32,1/64])
  out.push({index:out.length,panel,worldIndex,replicate:200+worldIndex,field,...arm,navDt,worldSeed:131301+worldIndex,sourceSeed:131501+worldIndex,startSeed:131701+worldIndex,controllerSeed:131901+worldIndex})
 return out
}
