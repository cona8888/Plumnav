import {linearCases,type LinearSpec} from './si-linear-design'
import {SCHEDULING_ARMS} from './si-scheduling-design'
export const STUDY='fine-scheduling-v1'
export const WITNESS_WORLDS=[0,5,10,15]
export type FineSchedulingSpec=LinearSpec&{studyId:typeof STUDY;caseRole:'primary'|'resolution-witness'|'compatibility'}
// The unchanged engine's panel tag is retained for type/schema compatibility.
// Study identity and statistical role are separate, explicit provenance fields.
export function fineSchedulingCases(mode:'preflight'|'campaign'):FineSchedulingSpec[]{
 if(mode==='preflight')return linearCases('linear-fresh').filter(s=>s.worldIndex===0&&s.field==='si-continuous'&&s.navDt===1/64).map(s=>({...s,studyId:STUDY,caseRole:'compatibility'}))
 if(mode!=='campaign')throw Error('Unknown scheduling study mode')
 const out:FineSchedulingSpec[]=[]
 for(let worldIndex=0;worldIndex<16;worldIndex++)for(const field of ['si-continuous','si-pulse','blank'] as const)for(const arm of SCHEDULING_ARMS)
  for(const navDt of WITNESS_WORLDS.includes(worldIndex)?[1/64,1/16,1/32]:[1/64])out.push({index:out.length,panel:'linear-fresh',studyId:STUDY,caseRole:navDt===1/64?'primary':'resolution-witness',worldIndex,replicate:400+worldIndex,field,...arm,navDt,worldSeed:151301+worldIndex,sourceSeed:151501+worldIndex,startSeed:151701+worldIndex,controllerSeed:151901+worldIndex})
 if(out.length!==288||out.filter(s=>s.caseRole==='primary').length!==192)throw Error('Invalid study counts')
 return out
}
