import {expect,it} from 'vitest'
import type {AlgorithmEnvironment,AlgorithmStepInput,Vec2} from '../src/sim/types'
import {SIPoseUncertaintyProbe} from './lib/si-pose-uncertainty-probe'

const environment={inspectionContract:{offsetNormalized:.001,arrivalRadiusNormalized:.0001,settlingSeconds:0,dwellSeconds:2,sampleSpacingSeconds:1,minimumSamplesPerWaypoint:2},sensorNoise:.001,maxSpeed:.0046,isBlocked:()=>false} as unknown as AlgorithmEnvironment
const input=(time:number,position:Vec2,heading:number):AlgorithmStepInput=>({time,dt:.0625,position,heading,distance:0,observations:[],measurement:{time,concentration:1,valid:true,hit:true,sampleMode:'passive',wind:{x:0,y:0},localInletReadings:Array.from({length:4},(_,i)=>({channel:(['front','left','aft','right'] as const)[i]!,concentration:1,saturated:false,effectiveOffset:{x:0,y:0}}))}})

it('bounds deterministic waypoint and heading perturbations',()=>{
 const spec={positionRadiusMetres:.05,headingBoundRadians:.2,registration:'observed' as const,perturbationSeed:6101}
 const a=new SIPoseUncertaintyProbe(environment,{x:.5,y:.5},100,spec),b=new SIPoseUncertaintyProbe(environment,{x:.5,y:.5},100,spec)
 expect(a.positionOffsetsMetres).toEqual(b.positionOffsetsMetres);expect(a.headingOffsetsRadians).toEqual(b.headingOffsetsRadians)
 expect(Math.max(...a.positionOffsetsMetres.map(v=>Math.hypot(v.x,v.y)))).toBeLessThanOrEqual(.05)
 expect(Math.max(...a.headingOffsetsRadians.map(Math.abs))).toBeLessThanOrEqual(.2)
})

it('uses one shared translation for the constant-bias structure',()=>{
 const p=new SIPoseUncertaintyProbe(environment,{x:.5,y:.5},100,{positionRadiusMetres:.03,headingBoundRadians:0,registration:'observed',perturbationSeed:6102,positionErrorStructure:'constant-bias'})
 expect(new Set(p.positionOffsetsMetres.map(v=>`${v.x},${v.y}`)).size).toBe(1)
})

it('stores commanded rather than actual coordinates in the unregistered arm',()=>{
 const p=new SIPoseUncertaintyProbe(environment,{x:.5,y:.5},100,{positionRadiusMetres:.05,headingBoundRadians:.2,registration:'commanded',perturbationSeed:6101})
 const target=p.actualTargets[0]!,heading=p.desiredHeadings[0]!
 expect(p.step(input(0,target,0)).phase).toBe('SI POSE ORIENTATION')
 p.step(input(1,target,heading))
 expect(p.visits[0]!.samples).toHaveLength(1)
 expect(p.visits[0]!.samples[0]!.x).toBeCloseTo(0,12);expect(p.visits[0]!.samples[0]!.y).toBeCloseTo(0,12)
})
