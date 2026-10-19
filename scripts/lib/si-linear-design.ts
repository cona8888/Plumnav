import {turnCases,type TurnSpec} from './si-turn-design'
import {SCHEDULING_ARMS} from './si-scheduling-design'
export type LinearSpec=Omit<TurnSpec,'panel'>&{panel:'linear-diagnostic'|'linear-fresh'}
export function linearCases(panel:LinearSpec['panel']):LinearSpec[]{
 if(panel==='linear-diagnostic')return turnCases('turn-fresh').filter(s=>s.worldIndex===1).map((s,index)=>({...s,index,panel}))
 if(panel!=='linear-fresh')throw Error('Unknown response panel')
 const out:LinearSpec[]=[]
 for(let worldIndex=0;worldIndex<4;worldIndex++)for(const field of ['si-continuous','si-pulse','blank'] as const)for(const arm of SCHEDULING_ARMS)for(const navDt of [1/16,1/32,1/64])
  out.push({index:out.length,panel,worldIndex,replicate:300+worldIndex,field,...arm,navDt,worldSeed:141301+worldIndex,sourceSeed:141501+worldIndex,startSeed:141701+worldIndex,controllerSeed:141901+worldIndex})
 return out
}
