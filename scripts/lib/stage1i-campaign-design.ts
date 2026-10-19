import {createHash} from 'node:crypto'
import {createDefaultConfig} from '../../src/sim/config'
import {GSL_REFERENCE_DESIGN} from '../../src/sim/physicalDesign'
import {SI_HALFSPACE_REFERENCE,withSIResearchDesign} from './si-research-config'
import type {SimulationConfig} from '../../src/sim/types'
import type {SIPoseUncertaintySpec} from './si-pose-uncertainty-probe'

export const STAGE1I_SCHEMA='si-pose-registration-replication-v1'
export const STAGE1I_FIELDS=['peak','offset-peak','ridge','saddle','plateau','uniform','blank','clipped-peak','si-continuous','si-narrow','si-pulse'] as const
export const STAGE1I_RADII=[.005,.01,.015,.02,.03,.05] as const
export const STAGE1I_STRUCTURES=['independent','constant-bias'] as const
export const STAGE1I_REGISTRATIONS=['observed','commanded'] as const
export const STAGE1I_REPLICATES=50
export type Stage1iField=typeof STAGE1I_FIELDS[number]
export type Stage1iCase={index:number;field:Stage1iField;kind:'baseline'|'position';replicate:number|null;uncertainty:SIPoseUncertaintySpec}
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value
export const stage1iStableJson=(value:unknown)=>`${JSON.stringify(canonical(value),null,2)}\n`
export const stage1iSha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')

export const buildStage1iCases=():Stage1iCase[]=>{
 const cases:Stage1iCase[]=STAGE1I_FIELDS.map((field,index)=>({index,field,kind:'baseline',replicate:null,uncertainty:{positionRadiusMetres:0,headingBoundRadians:0,registration:'observed',perturbationSeed:710001,positionErrorStructure:'independent'}}))
 for(let replicate=0;replicate<STAGE1I_REPLICATES;replicate++)for(const radius of STAGE1I_RADII)for(const structure of STAGE1I_STRUCTURES)for(const field of STAGE1I_FIELDS)for(const registration of STAGE1I_REGISTRATIONS)cases.push({index:cases.length,field,kind:'position',replicate,uncertainty:{positionRadiusMetres:radius,headingBoundRadians:0,registration,perturbationSeed:710001+replicate,positionErrorStructure:structure}})
 if(cases.length!==13211||cases.some((c,i)=>c.index!==i))throw Error('Stage 1i case construction failed')
 return cases
}

export const buildStage1iConfig=(field:Stage1iField):SimulationConfig=>{
 const atmosphere=structuredClone(SI_HALFSPACE_REFERENCE);atmosphere.measurement.noiseKgPerCubicMetre=0
 if(field==='si-narrow')atmosphere.sourceWidthMetres=.075
 if(field==='si-pulse'){atmosphere.pulse={periodSeconds:20,phaseSeconds:0,dutyFraction:.5};atmosphere.emissionRateKgPerSecond=4e-9}
 return withSIResearchDesign({...createDefaultConfig('quad-sniff-refine','open'),seed:98001,fixedDt:.0625,durationSeconds:330,checkpointSeconds:[330],windDirectionDegrees:90,windNoise:0,sourcePositionOverride:{x:.5,y:.5},robotStartPositionOverride:{x:field.startsWith('si-')?.501:.5,y:.5},robotStartHeadingDegrees:0,stopOnNativeDeclaration:false},{...GSL_REFERENCE_DESIGN,referenceWindMetresPerSecond:.02},atmosphere)
}

export const buildStage1iManifest=()=>{
 const cases=buildStage1iCases(),configs=Object.fromEntries(STAGE1I_FIELDS.map(field=>[field,buildStage1iConfig(field)]))
 const body={schemaVersion:STAGE1I_SCHEMA,caseCount:cases.length,worldSeed:98001,acceptedDt:.0625,durationSeconds:330,verifierNoiseAllowanceC0:.001,fields:STAGE1I_FIELDS,radiiMetres:STAGE1I_RADII,errorStructures:STAGE1I_STRUCTURES,registrations:STAGE1I_REGISTRATIONS,replicates:STAGE1I_REPLICATES,perturbationSeedRange:[710001,710050],positiveFields:['peak','offset-peak','si-continuous'],controlFields:['ridge','saddle','plateau','uniform','blank','clipped-peak','si-narrow','si-pulse'],configs,casesSha256:stage1iSha256(stage1iStableJson(cases)),protocol:'research/protocols/si_pose_registration_replication_2026-09-15.md'}
 return {...body,manifestSha256:stage1iSha256(stage1iStableJson(body))}
}

export const STAGE1I_SMOKE_INDICES=(()=>{const cases=buildStage1iCases(),indices=new Set<number>()
 for(const field of ['offset-peak','saddle','si-continuous','si-pulse'] as Stage1iField[])indices.add(cases.find(c=>c.kind==='baseline'&&c.field===field)!.index)
 for(const radius of [.005,.05])for(const structure of STAGE1I_STRUCTURES)for(const field of ['offset-peak','si-continuous'] as Stage1iField[])for(const registration of STAGE1I_REGISTRATIONS)indices.add(cases.find(c=>c.kind==='position'&&c.field===field&&c.replicate===0&&c.uncertainty.positionRadiusMetres===radius&&c.uncertainty.positionErrorStructure===structure&&c.uncertainty.registration===registration)!.index)
 return [...indices].sort((a,b)=>a-b)
})()
