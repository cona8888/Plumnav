import { describe, expect, it } from 'vitest'
import { createDefaultConfig, validateSimulationConfig } from '../src/sim/config'
import { SimulationEngine } from '../src/sim/engine'
import { withLocalInletDesign } from '../src/sim/localInletSampling'
import { GSL_REFERENCE_DESIGN } from '../src/sim/physicalDesign'
import { HalfspaceTransport } from './lib/halfspace-transport'
import { SI_HALFSPACE_REFERENCE, withSIResearchDesign } from './lib/si-research-config'
import { siScaleAnalysis } from './lib/si-scale-analysis'
import { batchResultsToCsv, runBatch, summarizeBatch } from '../src/sim/batch'
const build = (L = 100) => withSIResearchDesign({ ...createDefaultConfig('quad-sniff-refine', 'open'),
  durationSeconds: 20, checkpointSeconds: [20], windNoise: 0,
  sourcePositionOverride: { x: .5, y: .5 }, robotStartPositionOverride: { x: .5 + .4 / L, y: .5 } },
  { ...GSL_REFERENCE_DESIGN, domainMetres: L, referenceWindMetresPerSecond: .02 })

describe('explicit SI atmosphere', () => {
  it('maps diffusivity into the spatially normalized scenario at different domain sizes', () => {
    for (const L of [10, 100, 1000]) {
      const config = build(L), engine = new SimulationEngine(config)
      expect(engine.scenario.diffusivity * L * L).toBeCloseTo(.001, 12)
      expect(engine.scenario.referenceDiffusivity * L * L).toBeCloseTo(.001, 12)
      expect(engine.config.sensorPpmPerNormalizedUnit).toBeCloseTo(1.5252745447)
    }
  })
  it('preserves default legacy diffusivity but honors optional SI diffusivity without the halfspace', () => {
    const base = createDefaultConfig('quad-sniff-refine','open')
    const old = withLocalInletDesign(base, GSL_REFERENCE_DESIGN,{recoveryTimeConstantSeconds:2,maximumTurnRateRadiansPerSecond:1})
    expect(new SimulationEngine(old).scenario.diffusivity).toBe(.000035)
    const si = withLocalInletDesign(base,{...GSL_REFERENCE_DESIGN,effectiveDiffusivityMetresSquaredPerSecond:.001},
      {recoveryTimeConstantSeconds:2,maximumTurnRateRadiansPerSecond:1})
    expect(new SimulationEngine(si).scenario.diffusivity).toBe(1e-7)
  })
  it('gives the same SI field and filtered measurements after domain coordinate changes', () => {
    const traces = [10,100].map(L => {
      const e = new SimulationEngine(build(L)), samples:number[]=[]
      e.controller.step=()=>({direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase:'FIXTURE'})
      while(!e.isCompleted()){const f=e.step();samples.push(f.measurement.concentration)}
      return samples
    })
    traces[0]!.forEach((value,i)=>expect(value).toBeCloseTo(traces[1]![i]!,10))
  })
  it('matches the frozen halfspace kernel at physical inlet height, including pulse and background', () => {
    for(const pulse of [undefined,{periodSeconds:20,phaseSeconds:5,dutyFraction:.5 as const}]) {
      const c=build(),a=c.physicalAtmosphere!;a.pulse=pulse;a.measurement.backgroundKgPerCubicMetre=1e-8
      const e=new SimulationEngine(c),U=e.scenario.baseWind
      const f=new HalfspaceTransport({source:{x:50,y:50,z:.025},wind:{x:U.x*100,y:U.y*100},diffusivity:.001,
        sigma:.15,rateKgPerSecond:2e-9,panelSeconds:2,pulse})
      for(const time of [0,7,20])expect(e.plume.concentrationAt({x:.504,y:.501},time)).toBeCloseTo(
        (f.evaluate({x:50.4,y:50.1,z:.05},time+300).concentration+1e-8)/1e-6,12)
    }
  })
  it.each(['absent','zero-emission'] as const)('retains background but emits no excess gas for %s', targetStatus => {
    const c=build();c.targetStatus=targetStatus;c.physicalAtmosphere!.measurement.backgroundKgPerCubicMetre=1e-8
    if(targetStatus==='absent')delete c.sourcePositionOverride
    const e=new SimulationEngine(c)
    expect(e.plume.concentrationAt({x:.5,y:.5},20)).toBe(.01)
    expect(e.plume.totalMassAt!(20)).toBe(0)
    expect('source' in e.observationModel.scenario).toBe(false)
    expect('physicalAtmosphere' in e.environment).toBe(false)
    expect('measurement' in e.observationModel.scenario).toBe(false)
  })
  it('rejects conflicting scalar units, forcing, pulse duty and legacy switches', () => {
    const edits:Array<(c:ReturnType<typeof build>)=>void>=[c=>{c.sensorNoise=.2},c=>{c.diffusivityScale=2},
      c=>{c.emissionRateScale=2},c=>{c.sensorPpmPerNormalizedUnit=1000},c=>{c.gustStrength=.1},
      c=>{c.physicalAtmosphere!.diffusivityMetresSquaredPerSecond=.002},c=>{c.physicsMode='grid'},
      c=>{c.physicalAtmosphere!.pulse={periodSeconds:20,phaseSeconds:0,dutyFraction:.4 as .5}}]
    for(const edit of edits){const c=build();edit(c);expect(()=>validateSimulationConfig(c)).toThrow()}
  })
  it('does not retain caller-mutable atmosphere or pulse objects', () => {
    const c=build();c.physicalAtmosphere!.pulse={periodSeconds:20,phaseSeconds:0,dutyFraction:.5}
    const e=new SimulationEngine(c),before=e.plume.concentrationAt({x:.501,y:.5},10)
    c.physicalAtmosphere!.emissionRateKgPerSecond=999;c.physicalAtmosphere!.pulse.phaseSeconds=10
    expect(e.plume.concentrationAt({x:.501,y:.5},10)).toBe(before)
    expect(e.config.physicalAtmosphere!.emissionRateKgPerSecond).toBe(2e-9)
  })
  it('exposes partial inlet saturation even when the scalar mean is below the limit', () => {
    const c=build();c.physicalAtmosphere!.sourceWidthMetres=.075
    c.robotStartPositionOverride={x:.501,y:.5};c.windDirectionDegrees=90
    const e=new SimulationEngine(c);e.controller.step=()=>({direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase:'SATURATION FIXTURE'})
    let partial=false
    while(!e.isCompleted()) {const m=e.step().measurement
      expect(m.localInletReadings).toHaveLength(4)
      if(m.valid && m.localInletReadings!.some(r=>r.saturated)&&m.concentration<c.sensorSaturation)partial=true
    }
    expect(partial).toBe(true)
  })
  it('records SI contracts in CSV and separates atmospheric forcing in summaries', async () => {
    const c=build();c.durationSeconds=2;c.checkpointSeconds=[2]
    const one=await runBatch(c,['quad-sniff-refine'],['open'],1)
    c.physicalAtmosphere!.emissionRateKgPerSecond=4e-9
    const two=await runBatch(c,['quad-sniff-refine'],['open'],1)
    const combined=[...one.results,...two.results]
    expect(summarizeBatch(combined)).toHaveLength(2)
    const csv=batchResultsToCsv(combined)
    expect(csv).toContain('si_configuration_json');expect(csv).toContain('halfspace-si-v1')
    expect(csv).toContain('concentrationScaleKgPerCubicMetre')
  })
})
it('exports calculated local scale groups with consistent SI source forcing',()=>{
  const a=siScaleAnalysis(build(),.1,20),b=siScaleAnalysis(build(10),.1,20)
  expect(a.groups.peclet).toBeCloseTo(2);expect(a.groups.sourceStrength).toBeCloseTo(10)
  expect(a.groups.motionMemoryRecovery).toBeCloseTo(3.25398223686)
  expect(a.groups.dwellToVariationPeriod).toBe(.6)
  expect(a.groups.motionMemoryRecovery).toBe(b.groups.motionMemoryRecovery)
  expect(a.quantities.nineVisitDwellAndTranslationLowerBoundSeconds).toBe(116)
  expect(()=>siScaleAnalysis(build(),0)).toThrow()
  expect(SI_HALFSPACE_REFERENCE.measurement.concentrationScaleKgPerCubicMetre).toBe(1e-6)
})
