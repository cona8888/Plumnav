import {expect,it} from 'vitest'
import {createDefaultConfig,validateSimulationConfig} from '../config'
import {SimulationEngine} from '../engine'
import {withLocalInletDesign} from '../localInletSampling'
import {GSL_REFERENCE_DESIGN} from '../physicalDesign'
import {QuadSoilSniffController,type GradientRay} from './quadSoilSniff'
import type {AlgorithmStepInput,AlgorithmDecision,Vec2} from '../types'

function fixture(rolling=true) {
  const config=withLocalInletDesign({...createDefaultConfig('quad-sniff-refine','open'),durationSeconds:600},GSL_REFERENCE_DESIGN,
    {recoveryTimeConstantSeconds:2,maximumTurnRateRadiansPerSecond:Math.PI/4})
  Object.assign(config.localInletSampling!,{gradientEstimator:'relative-geometry-v1',candidateLifecycle:'bounded-inspection-v1',
    acquisitionPolicy:'time-budgeted-viewpoints-v1',bearingGeometry:'linearized-local-bearing-v1',
    ...(rolling?{rayWindowPolicy:'rolling-expiry-v1'}:{})})
  const engine=new SimulationEngine(config),controller=engine.controller as QuadSoilSniffController
  const origin={x:0.504,y:0.5}
  Object.assign(controller,{gradientRays:[{time:14,origin,direction:{x:-1,y:0},weight:1,angularSigma:0.02}],lastGradientDirection:{x:-1,y:0}})
  const input=(time:number,position=origin):AlgorithmStepInput=>({time,dt:0.25,position,heading:0,distance:0,observations:[],
    measurement:{time,valid:false,sampleMode:'passive',concentration:0,hit:false,wind:{x:0.0002,y:0}}})
  const access=controller as unknown as {timeBudgetedAcquisition(input:AlgorithmStepInput):AlgorithmDecision;
    expireGradientRays(time:number):void;gradientRays:GradientRay[];physicalViewpoint:{target:Vec2;deadline:number}|null;
    trustedRayEstimate():unknown}
  return {config,controller,access,input}
}
it('reproduces the oldest-ray stall and permits replacement only in the opt-in policy',()=>{
  const old=fixture(false),revised=fixture()
  expect(old.access.timeBudgetedAcquisition(old.input(80)).phase).toBe('INSUFFICIENT BEARING ACQUISITION BUDGET')
  expect(revised.access.timeBudgetedAcquisition(revised.input(80)).phase).toBe('TIME-BUDGETED PHYSICAL VIEWPOINT')
  expect(revised.access.gradientRays[0]!.time).toBe(14)
  expect(revised.controller.getPhysicalDiagnostics().retentionSeconds).toBe(75)
})
it('keeps a bounded trip after the last ray expires without keeping stale evidence',()=>{
  const {access,input}=fixture()
  access.timeBudgetedAcquisition(input(88))
  const target={...access.physicalViewpoint!.target}
  access.expireGradientRays(89)
  expect(access.gradientRays).toHaveLength(1) // Exact 75-second boundary is retained.
  access.expireGradientRays(89.25)
  expect(access.gradientRays).toHaveLength(0)
  expect(access.physicalViewpoint!.target).toEqual(target)
  expect(access.timeBudgetedAcquisition(input(89.25)).phase).toBe('TIME-BUDGETED PHYSICAL VIEWPOINT')
  expect(access.timeBudgetedAcquisition(input(90,target)).quadSniff).toBeDefined()
  expect(access.trustedRayEstimate()).toBeNull()
})
it('still enforces the mission deadline and travel timeout without declaring absence',()=>{
  const {access,input}=fixture()
  const d=access.timeBudgetedAcquisition(input(590))
  expect(d.phase).toBe('INSUFFICIENT MISSION ACQUISITION BUDGET')
  expect(d.nativeTerminated||d.nativeAbstained).toBeFalsy()
  access.timeBudgetedAcquisition(input(80))
  expect(access.timeBudgetedAcquisition(input(access.physicalViewpoint!.deadline+0.25)).phase).toBe('PHYSICAL VIEWPOINT TIMEOUT')
})
it('does not create a viewpoint or source candidate from an empty ray bank',()=>{
  const {access,input}=fixture()
  access.gradientRays=[]
  expect(access.timeBudgetedAcquisition(input(80))).toBeNull()
  expect(access.physicalViewpoint).toBeNull()
  expect(access.trustedRayEstimate()).toBeNull()
})
it('separates formation from physical acceptance and returns detached diagnostic objects',()=>{
  const {controller,access}=fixture()
  Object.assign(controller,{estimateHistory:[0,1,2].map(time=>({time,point:{x:0.5,y:0.5}})),
    rayEstimate:{point:{x:0.5,y:0.5},rayCount:3,quality:0.5,residual:0,
      physicalUncertainty:{acceptable:false,reducedChiSquare:1,nominalRadius95:0.002}}})
  const before=controller.getPhysicalDiagnostics(),again=controller.getPhysicalDiagnostics()
  expect(before).toEqual(again)
  expect(before.gates.formation).toBe(true)
  expect(before.gates.nominalRadius).toBe(false)
  expect(before.rawRayEligible).toBe(false)
  expect(access.trustedRayEstimate()).toBeNull()
  before.rayTimes[0]=-1
  before.rayEstimate!.point.x=0
  expect(controller.getPhysicalDiagnostics()).toEqual(again)
})
it('validates policy dependencies and leaves archived settings opt-out',()=>{
  expect(fixture(false).config.localInletSampling!.rayWindowPolicy).toBeUndefined()
  const {config}=fixture()
  delete config.localInletSampling!.bearingGeometry
  expect(()=>validateSimulationConfig(config)).toThrow(/Rolling ray window/)
})
