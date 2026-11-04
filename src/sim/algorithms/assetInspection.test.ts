import { describe, expect, it, vi } from 'vitest'
import { createDefaultConfig, validateSimulationConfig } from '../config'
import { runBatch } from '../batch'
import { SimulationEngine } from '../engine'
import { GSL_REFERENCE_DESIGN } from '../physicalDesign'
import { SI_HALFSPACE_REFERENCE, withSIResearchDesign } from '../../../scripts/lib/si-research-config'
import { AssetInspectionController } from './assetInspection'

const stations = [{ x: 0.35, y: 0.5 }, { x: 0.65, y: 0.5 }]
function config() {
  return withSIResearchDesign({ ...createDefaultConfig('asset-inspection', 'open'), assetVerification: undefined,
    inspectionStations: structuredClone(stations), robotStartPositionOverride: { x: 0.5, y: 0.45 },
    sourcePositionOverride: { ...stations[1]! } },
  { ...GSL_REFERENCE_DESIGN, domainMetres: 5, robotSpeedMetresPerSecond: 0.2, referenceWindMetresPerSecond: 0.02 },
  { ...SI_HALFSPACE_REFERENCE, measurement: { ...SI_HALFSPACE_REFERENCE.measurement, noiseKgPerCubicMetre: 0 } })
}

describe('two-pass mapped fitting inspection', () => {
  it('inspects every station equally with settled evidence before nominating a fitting for reinspection', () => {
    const c = config()
    const engine = new SimulationEngine(c)
    const controller = engine.controller as AssetInspectionController
    c.inspectionStations![1]!.x = 0.3
    vi.spyOn(engine.plume, 'concentrationAt').mockImplementation(p => p.x > 0.5 ? 0.8 : 0.03)
    const frame = engine.runToCompletion()
    expect(frame.decision.estimate).toEqual(stations[1])
    expect(controller.getNominatedStationIndex()).toBe(1)
    expect(frame.decision.phase).toBe('FITTING FLAGGED FOR REINSPECTION')
    expect(frame.decision.confidence).toBe(0)
    expect(frame.metrics.nativeDeclaration).toBe(false)
    expect(frame.metrics.terminalOutcome).toBe('unresolved-survey')
    expect(frame.metrics.collisionAttempts).toBe(0)
    const visits = controller.getVisits()
    expect(visits.map(v => [v.pass, v.stationIndex])).toEqual([[1, 0], [1, 1], [2, 0], [2, 1]])
    for (const v of visits) {
      expect(v.departedAt - v.arrivedAt).toBeGreaterThanOrEqual(c.localInletSampling!.inspection.dwellSeconds)
      expect(v.sampleCount).toBeGreaterThanOrEqual(c.localInletSampling!.inspection.minimumSamplesPerWaypoint)
      expect(v.hitCount).toBe(v.stationIndex === 1 ? v.sampleCount : 0)
      expect(v.clippedCount).toBe(0)
    }
    visits[0]!.stationIndex = 100
    expect(controller.getVisits()[0]!.stationIndex).toBe(0)
  })

  it.each(['blank', 'clipped', 'reversed winner'] as const)('abstains for %s evidence', mode => {
    const c = config()
    const engine = new SimulationEngine(c)
    const controller = engine.controller as AssetInspectionController
    vi.spyOn(engine.plume, 'concentrationAt').mockImplementation(p => {
      if (mode === 'blank') return 0
      const secondPass = controller.getVisits().length >= stations.length
      const peak = mode === 'reversed winner' && secondPass ? p.x < 0.5 : p.x > 0.5
      return peak ? mode === 'clipped' ? 10 : 0.8 : 0.01
    })
    const frame = engine.runToCompletion()
    expect(frame.decision.nativeAbstained).toBe(true)
    expect(frame.decision.estimate).toBeNull()
    expect(frame.decision.phase).toBe('NO FITTING FLAGGED')
    expect(controller.getNominatedStationIndex()).toBeNull()
    expect(controller.getVisits()).toHaveLength(4)
    if (mode === 'clipped') expect(controller.getVisits().some(v => v.clippedCount > 0)).toBe(true)
  })

  it('abstains if strong readings have insufficient contrast above the sensor noise', () => {
    const c = config()
    const measurement = c.physicalAtmosphere!.measurement
    measurement.noiseKgPerCubicMetre = 0.03 * measurement.concentrationScaleKgPerCubicMetre
    c.sensorNoise = 0.03
    const engine = new SimulationEngine(c)
    vi.spyOn(engine.plume, 'concentrationAt').mockReturnValue(0.4)
    expect(engine.runToCompletion().decision.nativeAbstained).toBe(true)
    const visits = (engine.controller as AssetInspectionController).getVisits()
    expect(visits.every(v => v.hitCount >= 2)).toBe(true)
    expect(Math.abs(visits[0]!.median! - visits[1]!.median!)).toBeLessThan(3 * c.sensorNoise)
  })

  it('leaves a partial survey undecided at its deadline', () => {
    const c = { ...config(), durationSeconds: 15, checkpointSeconds: [15] }
    const engine = new SimulationEngine(c)
    vi.spyOn(engine.plume, 'concentrationAt').mockReturnValue(0.8)
    const frame = engine.runToCompletion()
    expect((engine.controller as AssetInspectionController).getNominatedStationIndex()).toBeNull()
    expect(frame.metrics.terminalOutcome).toBe('unresolved-survey')
    expect(frame.decision.estimate).toBeNull()
  })

  it('checks clearance, separation and the local SI contract', () => {
    const c = config()
    expect(() => new SimulationEngine({ ...c, inspectionStations: [stations[0]!] })).toThrow(/two inspection/)
    expect(() => new SimulationEngine({ ...c, inspectionStations: [stations[0]!, stations[0]!] })).toThrow(/distinct/)
    expect(() => new SimulationEngine({ ...c, inspectionStations: [stations[0]!, { x: 0, y: 0.45 }] })).toThrow(/clearance/)
    expect(() => validateSimulationConfig({ ...c, physicalAtmosphere: undefined })).toThrow(/SI local-inlet/)
    expect(() => new SimulationEngine({ ...c, robotStartPositionOverride: { x: 0.01, y: 0.5 } })).toThrow(/reachable start/)
  })
})

describe('opt-in wind bracket and fitting revisit', () => {
  const v = { version: 'wind-bracket-v1' as const, offsetMetres: 0.4, minimumWindMetresPerSecond: 0.005 }
  function run(c: ReturnType<typeof config>, field?: (x: number) => number) {
    const engine = new SimulationEngine(c)
    if (field) vi.spyOn(engine.plume, 'concentrationAt').mockImplementation(p => field(p.x))
    const frame = engine.runToCompletion()
    const controller = engine.controller as AssetInspectionController
    return { frame, nominated: controller.getNominatedStationIndex(), screening: controller.getVisits(), checks: controller.getVerificationVisits() }
  }

  it('uses a distinct, settled upwind view to discriminate an advected plume from an on-fitting release', () => {
    const c = { ...config(), assetVerification: v, windDirectionDegrees: 90, windNoise: 0, durationSeconds: 450, checkpointSeconds: [450] }
    const on = run(c)
    expect(on.nominated).toBe(1)
    expect(on.frame.metrics.nativeDeclaration).toBe(false)
    expect(on.checks.map(r => r.role)).toEqual(['upwind', 'crosswind-left', 'crosswind-right', 'fitting'])
    expect(on.checks[0]!.position.x).toBeCloseTo(stations[1]!.x - v.offsetMetres / c.domainMeters, 2)
    expect(on.checks.every(r => r.windAligned && r.sampleCount >= 2 && r.departedAt - r.arrivedAt >= c.activeSniffCycleSeconds)).toBe(true)
    const transported = { ...c, sourcePositionOverride: { x: stations[1]!.x - 0.5 / c.domainMeters, y: 0.5 } }
    expect(run({ ...transported, assetVerification: undefined }).nominated).toBe(1)
    const off = run(transported)
    expect(off.nominated).toBeNull()
    expect(off.checks.map(r => r.role)).toEqual(['upwind'])
    expect(off.checks[0]!.median!).toBeGreaterThan(off.screening[1]!.median!)
    expect(off.frame.metrics.nativeDeclaration).toBe(false)
    const blank = run({ ...c, targetStatus: 'absent', sourcePositionOverride: undefined })
    expect(blank.nominated).toBeNull()
    expect(blank.checks).toHaveLength(0)
  })

  it.each([-1, 1])('vetoes a release 0.25 m across the wind on side %s', side => {
    const c = { ...config(), assetVerification: v, windDirectionDegrees: 90, windNoise: 0,
      durationSeconds: 450, checkpointSeconds: [450], sourcePositionOverride: { x: stations[1]!.x, y: 0.5 + side * 0.25 / 5 } }
    expect(run({ ...c, assetVerification: undefined }).nominated).toBe(1)
    const off = run(c)
    expect(off.nominated).toBeNull()
    const last = off.checks.at(-1)!
    expect(last.role).toBe(side < 0 ? 'crosswind-left' : 'crosswind-right')
    expect(last.position.y).toBeCloseTo(0.5 + side * 0.4 / 5, 2)
    expect(last.median!).toBeGreaterThan(off.screening[1]!.median!)
    expect(off.frame.decision.terminationReason).toContain(last.role)
    expect(off.frame.metrics.nativeDeclaration).toBe(false)
  })

  it('withholds a flag for overlapping station neighbourhoods and a wind reversal during reinspection', () => {
    const c = { ...config(), assetVerification: v, windDirectionDegrees: 90, windNoise: 0, durationSeconds: 450, checkpointSeconds: [450] }
    const overlap = run({ ...c, assetVerification: { ...v, offsetMetres: 0.8 } })
    expect(overlap.checks).toHaveLength(0)
    expect(overlap.frame.decision.terminationReason).toContain('isolated and accessible')
    const engine = new SimulationEngine(c)
    const inspection = engine.controller as AssetInspectionController
    vi.spyOn(engine.plume, 'windAt').mockImplementation(() => ({
      x: (inspection.getVisits().length < 4 ? 1 : -1) * 0.02 / c.domainMeters, y: 0,
    }))
    engine.runToCompletion()
    expect(inspection.getVerificationVisits()).toHaveLength(1)
    expect(inspection.getVerificationVisits().every(r => !r.windAligned)).toBe(true)
    expect(inspection.getNominatedStationIndex()).toBeNull()
    expect(() => validateSimulationConfig({ ...c, assetVerification: { ...v, offsetMetres: 0.05 } })).toThrow(/offset/)
  })

  it('declines a comparison with insufficient remaining time, weak wind, or clipped control gas', () => {
    const c = { ...config(), assetVerification: v, windDirectionDegrees: 90, windNoise: 0, durationSeconds: 450, checkpointSeconds: [450] }
    const strong = (x: number) => x > 0.5 ? 0.8 : 0.02
    const weakWind = run({ ...c, assetVerification: { ...v, minimumWindMetresPerSecond: 0.03 } }, strong)
    expect(weakWind.frame.decision.terminationReason).toContain('Wind')
    expect(weakWind.checks).toHaveLength(0)
    const budget = weakWind.screening.at(-1)!.departedAt + 1
    const short = run({ ...c, durationSeconds: budget, checkpointSeconds: [budget] }, strong)
    expect(short.nominated).toBeNull()
    expect(short.frame.decision.terminationReason).toContain('Insufficient time')
    const clipped = run(c, x => x > 0.55 && x < 0.59 ? 10 : strong(x))
    expect(clipped.checks[0]!.clippedCount).toBeGreaterThan(0)
    expect(clipped.nominated).toBeNull()
  })
})

// Old stored configurations omit the option. Newly created inspections use the wind-bracket policy.
it('preserves explicit legacy recipes and passes verification only to its own benchmark arm', async () => {
  const c = { ...config(), durationSeconds: 2, checkpointSeconds: [2],
    assetVerification: createDefaultConfig('asset-inspection', 'open').assetVerification }
  expect(c.assetVerification?.version).toBe('wind-bracket-v1')
  const { results: runs } = await runBatch(c, ['asset-inspection', 'coverage'], ['open'], 1)
  expect(runs[0]!.config.assetVerification?.version).toBe('wind-bracket-v1')
  expect(runs[1]!.config.assetVerification).toBeUndefined()
  expect(runs[1]!.config.inspectionStations).toBeUndefined()
})
