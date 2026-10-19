import {expect,it} from 'vitest'
import {createDefaultConfig,validateSimulationConfig} from '../config'
import {SimulationEngine} from '../engine'
import {withBoundedPoseScans,withLocalInletDesign} from '../localInletSampling'
import {GSL_REFERENCE_DESIGN} from '../physicalDesign'
import {selectLocalGradientStep} from './localGradientStep'
import {QuadSoilSniffController} from './quadSoilSniff'
import type {AlgorithmStepInput,AlgorithmDecision} from '../types'
function fixture() {
  const config=withBoundedPoseScans(withLocalInletDesign({...createDefaultConfig('quad-sniff-refine','open'),
    durationSeconds:120,checkpointSeconds:[120],sensorNoise:0.001,windNoise:0,robotStartPositionOverride:{x:0.5,y:0.5}},GSL_REFERENCE_DESIGN,
    {recoveryTimeConstantSeconds:2,maximumTurnRateRadiansPerSecond:Math.PI/4}))
  Object.assign(config.localInletSampling!,{gradientEstimator:'relative-geometry-v1',candidateLifecycle:'bounded-inspection-v1',
    acquisitionPolicy:'time-budgeted-viewpoints-v1',bearingGeometry:'linearized-local-bearing-v1',
    rayWindowPolicy:'rolling-expiry-v1',localGradientPolicy:'head-step-v1'})
  const engine=new SimulationEngine(config)
  return {config,engine,controller:engine.controller as QuadSoilSniffController}
}
it('uses exactly one head spacing without a bearing or source-distance input',()=>{
  const {engine}=fixture(),p={x:0.5,y:0.5}
  for(const cue of [{x:1,y:0},{x:0,y:1},{x:-2,y:2}]) {
    const plan=selectLocalGradientStep(engine.environment,p,cue,0.25)!
    expect(Math.hypot(plan.target.x-p.x,plan.target.y-p.y)).toBeCloseTo(0.001)
    expect((plan.target.x-p.x)*cue.y-(plan.target.y-p.y)*cue.x).toBeCloseTo(0)
    expect(plan.returnAllowance).toBeGreaterThan(engine.environment.activeSniffCycleSeconds)
  }
})
it('rejects absent, nonfinite and blocked cues',()=>{
  const {engine}=fixture(),p={x:.5,y:.5}
  for(const cue of [{x:0,y:0},{x:NaN,y:1}])expect(selectLocalGradientStep(engine.environment,p,cue,.25)).toBeNull()
  expect(selectLocalGradientStep({...engine.environment,isBlocked:()=>true},p,{x:1,y:0},.25)).toBeNull()
})
it('runs actual channels and bounded motion up a manufactured slope without source rays',()=>{
  const {engine,controller}=fixture(),phases=new Set<string>()
  engine.plume.concentrationAt=p=>Math.max(0,0.5+20*(p.x-0.5))
  while(!engine.isCompleted()) {
    const frame=engine.step();phases.add(frame.decision.phase)
    expect(frame.decision.estimate).toBeNull()
    expect(controller.getPhysicalDiagnostics().rayTimes).toHaveLength(0)
    expect(controller.getPhysicalDiagnostics().heldPrior).toBeNull()
    expect(frame.metrics.nativeDeclaration).toBe(false)
  }
  expect(phases.has('LOCAL GRADIENT HEAD STEP')).toBe(true)
  expect(engine.getFrame().robot.position.x).toBeGreaterThan(.501)
})
it('does not turn blank or uniform sensor input into a directional step or source',()=>{
  for(const concentration of [0,0.5]) {
    const {config}=fixture();config.sensorNoise=0
    const engine=new SimulationEngine(config),phases=new Set<string>()
    engine.plume.concentrationAt=()=>concentration
    while(!engine.isCompleted())phases.add(engine.step().decision.phase)
    expect(phases.has('LOCAL GRADIENT HEAD STEP')).toBe(false)
    expect(engine.getFrame().metrics.nativeDeclaration).toBe(false)
  }
})
it('consumes one target at arrival and does not extend timed-out trips',()=>{
  const {controller}=fixture()
  const input=(time:number,position={x:.5,y:.5}):AlgorithmStepInput=>({time,position,dt:.25,heading:0,distance:0,observations:[],
    measurement:{time,valid:false,concentration:0,hit:false,wind:{x:0,y:0},sampleMode:'passive'}})
  const access=controller as unknown as {localGradientAcquisition(i:AlgorithmStepInput):AlgorithmDecision;localGradientMove:unknown}
  Object.assign(controller,{localGradientMove:{target:{x:.501,y:.5},arrivalRadius:.0001,deadline:20}})
  expect(access.localGradientAcquisition(input(19)).phase).toBe('LOCAL GRADIENT HEAD STEP')
  expect(access.localGradientAcquisition(input(19,{x:.501,y:.5})).quadSniff).toBeDefined()
  expect(access.localGradientMove).toBeNull()
  controller.reset((fixture().engine).environment)
  Object.assign(controller,{localGradientMove:{target:{x:.501,y:.5},arrivalRadius:.0001,deadline:20}})
  expect(access.localGradientAcquisition(input(21)).phase).toBe('LOCAL GRADIENT STEP TIMEOUT')
  expect(access.localGradientMove).toBeNull()
})
it('requires explicit compatible local hardware and prevents mixed ablations',()=>{
  const {config}=fixture();config.localInletSampling!.bearingAblation='wind-bearing'
  expect(()=>validateSimulationConfig(config)).toThrow(/Local gradient acquisition/)
})
