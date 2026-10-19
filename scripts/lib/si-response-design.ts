import {integrationConfig} from './si-integration'
import {fineSchedulingCases} from './si-fine-scheduling-design'
import {SCHEDULING_ARMS} from './si-scheduling-design'
import type {LinearSpec} from './si-linear-design'
import {validateSimulationConfig} from '../../src/sim/config'

export const RESPONSE_STUDY='scheduling-response-replication-v1' as const
export const RESPONSE_WITNESSES=[0,10,20,31]
export type ResponseSpec=LinearSpec&{studyId:typeof RESPONSE_STUDY;caseRole:'primary'|'resolution-witness'|'compatibility'|'diagnostic';responseScale:1|2;referenceIndex?:number}

export function responseConfig(s:ResponseSpec){
 if(s.studyId!==RESPONSE_STUDY||![1,2].includes(s.responseScale))throw Error('Invalid response study settings')
 const c=integrationConfig(s),p=c.localInletSampling!
 p.riseTimeConstantSeconds*=s.responseScale
 p.recoveryTimeConstantSeconds*=s.responseScale
 validateSimulationConfig(c)
 return c
}

export function responseCases(mode:'nominal-preflight'|'nominal-only'):ResponseSpec[]{
 const out:ResponseSpec[]=[]
 if(mode==='nominal-preflight'){
  const previous=fineSchedulingCases('campaign')
  for(const old of previous.filter(s=>s.worldIndex===0&&s.caseRole==='primary'))
   out.push({...old,index:out.length,studyId:RESPONSE_STUDY,caseRole:'compatibility',responseScale:1,referenceIndex:old.index})
  if(out.length!==12)throw Error('Nominal preflight count')
  return out
 }
 if(mode!=='nominal-only')throw Error('Only the prospectively declared nominal fallback is eligible')
 for(let worldIndex=0;worldIndex<32;worldIndex++)for(const responseScale of [1,2] as const)
  for(const field of ['si-continuous','si-pulse','blank'] as const)for(const arm of SCHEDULING_ARMS)
   for(const navDt of RESPONSE_WITNESSES.includes(worldIndex)?[1/64,1/16,1/32]:[1/64])
    out.push({index:out.length,panel:'linear-fresh',studyId:RESPONSE_STUDY,caseRole:navDt===1/64?'primary':'resolution-witness',responseScale,worldIndex,replicate:700+worldIndex,field,...arm,navDt,worldSeed:181301+worldIndex,sourceSeed:181501+worldIndex,startSeed:181701+worldIndex,controllerSeed:181901+worldIndex})
 if(out.length!==960)throw Error('Campaign count')
 return out.filter(s=>s.responseScale===1)
}

export function responsePlan(){
 return Object.fromEntries((['nominal-preflight','nominal-only'] as const).map(mode=>{
  const cases=responseCases(mode)
  return [mode,{cases,configs:cases.map(responseConfig)}]
 }))
}
