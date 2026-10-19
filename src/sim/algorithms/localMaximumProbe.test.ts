import {expect,it} from 'vitest'
import {createDefaultConfig,validateSimulationConfig} from '../config'
import {SimulationEngine} from '../engine'
import {withBoundedPoseScans,withLocalInletDesign} from '../localInletSampling'
import {GSL_REFERENCE_DESIGN} from '../physicalDesign'
import {LocalMaximumProbe,evaluateLocalMaximumVisits} from './localMaximumProbe'
import {QuadSoilSniffController} from './quadSoilSniff'
import type {AlgorithmStepInput} from '../types'
const input=(time:number,x=.5,concentration=0):AlgorithmStepInput=>({time,dt:.25,position:{x,y:.5},heading:0,distance:0,observations:[],
  measurement:{time,concentration,valid:false,hit:false,sampleMode:'passive',wind:{x:0,y:0}}})
it('requires a complete flank permutation and copies the requested order',()=>{
  const {engine}=fixture(600)
  expect(()=>new LocalMaximumProbe(engine.environment,[0,0,2,3])).toThrow(/permute/)
  const order=[3,2,1,0],probe=new LocalMaximumProbe(engine.environment,order)
  order.reverse();probe.start(input(0))
  const v=probe.snapshot().active!.visits
  expect(v).toHaveLength(9)
  expect(v[1]!.target.y).toBeCloseTo(.499)
  expect(v[7]!.target.x).toBeCloseTo(.501)
  expect(v.every(x=>x.samples.length===0)).toBe(true)
})
function fixture(duration=300) {
  const config=withBoundedPoseScans(withLocalInletDesign({...createDefaultConfig('quad-sniff-refine','open'),
    durationSeconds:duration,checkpointSeconds:[duration],sensorNoise:.001,windNoise:0,robotStartPositionOverride:{x:.5,y:.5}},GSL_REFERENCE_DESIGN,
    {recoveryTimeConstantSeconds:2,maximumTurnRateRadiansPerSecond:Math.PI/4}))
  Object.assign(config.localInletSampling!,{gradientEstimator:'relative-geometry-v1',candidateLifecycle:'bounded-inspection-v1',
    acquisitionPolicy:'time-budgeted-viewpoints-v1',bearingGeometry:'linearized-local-bearing-v1',rayWindowPolicy:'rolling-expiry-v1',
    localGradientPolicy:'head-step-v1',localMaximumPolicy:'fresh-cross-v1'})
  const engine=new SimulationEngine(config),probe=new LocalMaximumProbe(engine.environment)
  return {config,engine,probe}
}
it('requires rising separated observations and a weak final direction to trigger',()=>{
  const {probe}=fixture()
  probe.observeScan(input(14,.503),.4,true,true)
  probe.observeScan(input(28,.502),.5,true,true)
  expect(probe.snapshot().active).toBeNull()
  probe.observeScan(input(42,.501),.6,false,true)
  expect(probe.snapshot().active?.visits).toHaveLength(9)
  const {probe:flat}=fixture()
  for(let i=0;i<3;i++)flat.observeScan(input(14+i*14,.503-i*.001),.5,false,true)
  expect(flat.snapshot().active).toBeNull()
})
it('requires every flank below both fresh cores; rejects flat, ridge and temporal drift',()=>{
  const check=(means:number[])=>evaluateLocalMaximumVisits(means.map(value=>({target:{x:.5,y:.5},arrivedAt:0,
    samples:[{time:8,value,hit:true},{time:9,value,hit:true}]})),.001,2)
  expect(check([1,.98,1,.98,1,.98,1,.98,1]).supported).toBe(true)
  expect(check(Array(9).fill(1)).supported).toBe(false)
  expect(check([1,.98,1,.98,1,1,1,1,1]).supported).toBe(false)
  expect(check([1,.8,1.2,.8,1.4,.8,1.6,.8,1.8]).supported).toBe(false)
  expect(check([1,.999,1,.999,1,.999,1,.999,1]).supported).toBe(false)
})
it('exposes temporal aliasing: visit-level contrast alone cannot prove spatial origin',()=>{
  // The same values could arise from spatially uniform gas alternating with
  // visit time. This deliberately accepted counterexample bounds the claim.
  const values=[1,.98,1,.98,1,.98,1,.98,1]
  const visits=values.map((value,i)=>({target:{x:.5,y:.5},arrivedAt:i*15,
    samples:[{time:i*15+8,value,hit:true},{time:i*15+9,value,hit:true}]}))
  expect(evaluateLocalMaximumVisits(visits,.001,2).supported).toBe(true)
})
it.each(['peak','blank','uniform','ridge','plateau','intermittent'] as const)('runs a seeded verification circuit through actual sensors: %s',field=>{
  const {engine,probe}=fixture()
  Object.assign(engine.controller,{localMaximum:probe}) // Verification-only fixture; not unseeded acquisition.
  probe.start(input(0))
  engine.plume.concentrationAt=(p,t)=>{
    const x=(p.x-.5)*100,y=(p.y-.5)*100,r=Math.hypot(x,y)
    if(field==='blank')return 0
    if(field==='uniform'||field==='plateau'&&r<.3)return 1
    const c=.01+Math.exp(-(field==='ridge'?x*x:r*r)/(2*.6**2))
    return field==='intermittent'&&t%20>=10?.01:c
  }
  while(!engine.isCompleted())engine.step()
  const result=probe.snapshot().results[0]!
  expect(result).toBeDefined()
  expect(result.status==='supported').toBe(field==='peak')
  expect(engine.getFrame().metrics.nativeDeclaration).toBe(false)
  expect((engine.controller as QuadSoilSniffController).getPhysicalDiagnostics().heldPrior).toBeNull()
  if(field==='peak')expect(result.visits.every(v=>v.samples.every(s=>s.time>=v.arrivedAt!+engine.environment.inspectionContract!.settlingSeconds))).toBe(true)
})
it('rejects blocked patterns and inadequate mission time without silently omitting flanks',()=>{
  const {engine}=fixture(),p=new LocalMaximumProbe({...engine.environment,isBlocked:()=>true})
  p.start(input(0));expect(p.snapshot().results[0]?.reason).toBe('blocked-pattern')
  const {probe}=fixture(120);probe.start(input(0))
  expect(probe.snapshot().results[0]?.reason).toBe('insufficient-mission-budget')
})
it('times out missing valid samples and exposes only detached historical results',()=>{
  const {probe}=fixture();probe.start(input(0));const d=probe.snapshot().active!.deadline
  expect(probe.step(input(d+1))?.phase).toBe('LOCAL HOTSPOT PROBE TIMEOUT')
  const snapshot=probe.snapshot();snapshot.results[0]!.candidate.x=0
  expect(probe.snapshot().results[0]!.candidate.x).toBe(.5)
})
it('requires the acquisition component explicitly',()=>{
  const {config}=fixture();delete config.localInletSampling!.localGradientPolicy
  expect(()=>validateSimulationConfig(config)).toThrow(/Local maximum verification/)
})
it('nominates persistent strong gas without demanding a monotonic rise',()=>{
  const {engine}=fixture(),probe=new LocalMaximumProbe({...engine.environment,localMaximum:{...engine.environment.localMaximum!,nomination:'persistent-turn-v1'}})
  for(let i=0;i<3;i++)probe.observeScan(input(14+i*14),[.5,.48,.5][i]!,false,true,{x:1,y:0},false)
  expect(probe.snapshot().active).not.toBeNull()
  expect(probe.snapshot().nominationReason).toBe('persistent-signal-unreliable-direction')
})
it('nominates a measured direction reversal but not persistent aligned ascent',()=>{
  const {engine}=fixture()
  for(const reverse of [false,true]) {
    const probe=new LocalMaximumProbe({...engine.environment,localMaximum:{...engine.environment.localMaximum!,nomination:'persistent-turn-v1'}})
    for(let i=0;i<3;i++)probe.observeScan(input(14+i*14,.503-i*.001),.5,true,true,{x:reverse&&i===2?-1:1,y:0},true)
    expect(Boolean(probe.snapshot().active)).toBe(reverse)
  }
})
it('requires persistent signal, full support and time span in the new nomination rule',()=>{
  const {engine}=fixture()
  for(const mode of ['weak','unsupported','too-fast']) {
    const probe=new LocalMaximumProbe({...engine.environment,localMaximum:{...engine.environment.localMaximum!,nomination:'persistent-turn-v1'}})
    for(let i=0;i<3;i++)probe.observeScan(input(14+i*(mode==='too-fast'?1:14)),mode==='weak'?.1:.5,false,mode!=='unsupported',{x:1,y:0},false)
    expect(probe.snapshot().active).toBeNull()
  }
})
function completedSyntheticProbe(higher:boolean) {
  const {engine}=fixture(600),probe=new LocalMaximumProbe({...engine.environment,localMaximum:{...engine.environment.localMaximum!,recentering:'higher-flank-v1'}})
  probe.start(input(0))
  const access=probe as unknown as {active:{visits:Array<{samples:Array<{time:number;value:number;hit:boolean}>}>};finish(time:number,reason:string):void}
  access.active.visits.forEach((v,i)=>v.samples=[8,9].map(time=>({time,value:i===1&&higher?1.01:1,hit:true})))
  access.finish(150,'completed') // Unit-only completed samples, not a physical trajectory.
  return {probe,access}
}
it('a higher flank proposes only half an offset and creates a completely fresh circuit',()=>{
  const {probe}=completedSyntheticProbe(true),old=probe.snapshot().results[0]!
  expect(old.status).toBe('rejected')
  expect(probe.snapshot().pendingRecenter!.x).toBeCloseTo(.5005)
  probe.step(input(151))
  const next=probe.snapshot().active!
  expect(next.startedAt).toBe(151)
  expect(next.candidate.x).toBeCloseTo(.5005)
  expect(next.visits.every(v=>v.samples.length===0)).toBe(true)
  expect(probe.snapshot().results[0]).toEqual(old)
})
it('does not recenter on equal/flat measurements or bypass the attempt cap',()=>{
  expect(completedSyntheticProbe(false).probe.snapshot().pendingRecenter).toBeNull()
  const {probe,access}=completedSyntheticProbe(true)
  probe.step(input(151))
  access.active.visits.forEach((v,i)=>v.samples=[160,161].map(time=>({time,value:i===1?1.01:1,hit:true})))
  access.finish(300,'completed')
  expect(probe.snapshot().results).toHaveLength(2)
  expect(probe.snapshot().pendingRecenter).toBeNull()
  probe.start(input(301));expect(probe.snapshot().active).toBeNull()
})
it('does not waive the mission budget for a recentering proposal',()=>{
  const {probe}=completedSyntheticProbe(true)
  probe.step(input(550))
  expect(probe.snapshot().active).toBeNull()
  expect(probe.snapshot().results[1]?.reason).toBe('insufficient-mission-budget')
})
it('requires the verification contract for either experimental option',()=>{
  for(const key of ['localMaximumNomination','localMaximumRecentering'] as const) {
    const {config}=fixture();delete config.localInletSampling!.localMaximumPolicy
    if(key==='localMaximumNomination')config.localInletSampling![key]='persistent-turn-v1'
    else config.localInletSampling![key]='higher-flank-v1'
    expect(()=>validateSimulationConfig(config)).toThrow(/nomination\/recentering/)
  }
})
