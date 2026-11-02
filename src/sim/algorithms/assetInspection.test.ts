import { describe, expect, it, vi } from 'vitest'
import { createDefaultConfig, validateSimulationConfig } from '../config'
import { SimulationEngine } from '../engine'
import { GSL_REFERENCE_DESIGN } from '../physicalDesign'
import { SI_HALFSPACE_REFERENCE, withSIResearchDesign } from '../../../scripts/lib/si-research-config'
import { AssetInspectionController } from './assetInspection'

const stations = [{ x: 0.35, y: 0.5 }, { x: 0.65, y: 0.5 }]
function config() {
  return withSIResearchDesign({ ...createDefaultConfig('asset-inspection', 'open'),
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
    expect(frame.metrics.terminalOutcome).toBe('missed-source-abstention')
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
    expect(frame.metrics.terminalOutcome).toBe('deadline-nondeclaration-present')
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
