import {readFileSync} from 'node:fs'
import {expect,it} from 'vitest'
import {buildStage1iCases,buildStage1iConfig,buildStage1iManifest,STAGE1I_SMOKE_INDICES} from './lib/stage1i-campaign-design'

it('freezes the complete Stage 1i factorial without duplicate indices',()=>{
 const cases=buildStage1iCases()
 expect(cases).toHaveLength(13211)
 expect(new Set(cases.map(c=>c.index)).size).toBe(13211)
 expect(cases.filter(c=>c.kind==='baseline')).toHaveLength(11)
 expect(cases.filter(c=>c.kind==='position')).toHaveLength(13200)
 expect(buildStage1iManifest().caseCount).toBe(13211)
})

it('pairs observed and commanded registration on exactly the same perturbation',()=>{
 const cases=buildStage1iCases().filter(c=>c.kind==='position')
 const keys=new Map<string,Set<string>>()
 for(const c of cases){const k=[c.field,c.replicate,c.uncertainty.positionRadiusMetres,c.uncertainty.positionErrorStructure,c.uncertainty.perturbationSeed].join('|');const s=keys.get(k)??new Set();s.add(c.uncertainty.registration);keys.set(k,s)}
 expect(keys.size).toBe(6600)
 expect([...keys.values()].every(v=>v.size===2&&v.has('observed')&&v.has('commanded'))).toBe(true)
})

it('uses a smoke witness spanning baselines, radii, structures, fields and registrations',()=>{
 const cases=buildStage1iCases(),smoke=STAGE1I_SMOKE_INDICES.map(i=>cases[i]!)
 expect(smoke).toHaveLength(20)
 expect(new Set(smoke.map(c=>c.index)).size).toBe(20)
 expect(new Set(smoke.map(c=>c.index%4))).toEqual(new Set([0,1,2,3]))
 expect(new Set(smoke.map(c=>c.uncertainty.registration))).toEqual(new Set(['observed','commanded']))
 expect(new Set(smoke.map(c=>c.uncertainty.positionErrorStructure))).toEqual(new Set(['independent','constant-bias']))
})

it('reproduces the four audited Stage 1h field configurations',()=>{
 const pilot=JSON.parse(readFileSync('research/evidence/si_pose_uncertainty_pilot_2026-09-15/manifest.json','utf8'))
 for(const field of ['offset-peak','saddle','si-continuous','si-pulse']){
  const prior=pilot.configurations.find((x:any)=>x.spec.kind==='baseline'&&x.spec.field===field).config
  expect(buildStage1iConfig(field as any)).toEqual(prior)
 }
})
