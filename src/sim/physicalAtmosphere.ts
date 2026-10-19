import { HalfspaceTransport } from './halfspaceTransport'
import { FilamentPlume } from './plume'
import type { PhysicalAtmosphereConfig, Scenario, SimulationConfig, Vec2 } from './types'

export const methanePpmPerMassConcentration = (temperature: number, pressure: number) =>
  1e6 * 8.314462618 * temperature / (pressure * 0.01604)

/** Validate at the engine boundary, including manually constructed configs. */
export function validatePhysicalAtmosphere(config: SimulationConfig, threshold: number) {
  const a = config.physicalAtmosphere
  if (!a) return
  const p = config.localInletSampling, m = a.measurement
  if (a.version !== 'halfspace-si-v1' || !p || config.scenarioKind !== 'open' ||
      config.terrainSlopeDegrees !== 0 || config.gasBuoyancy !== 'neutral' || config.physicsMode !== 'filament') {
    throw new Error('SI halfspace requires local inlets, flat open neutral transport and the research override')
  }
  if (!m) throw new Error('SI halfspace requires a measurement contract')
  for (const [name, value] of Object.entries({ D: a.diffusivityMetresSquaredPerSecond, width: a.sourceWidthMetres,
    panel: a.quadraturePanelSeconds, scale: m.concentrationScaleKgPerCubicMetre, threshold: m.thresholdKgPerCubicMetre,
    saturation: m.saturationKgPerCubicMetre, temperature: m.temperatureKelvin, pressure: m.pressurePascal })) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Invalid physical atmosphere ${name}`)
  }
  for (const value of [a.releaseHeightMetres, a.emissionRateKgPerSecond, a.sourceAgeAtMissionStartSeconds,
    m.backgroundKgPerCubicMetre, m.noiseKgPerCubicMetre]) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid nonnegative SI quantity')
  }
  if (m.thresholdKgPerCubicMetre >= m.saturationKgPerCubicMetre || m.backgroundKgPerCubicMetre >= m.saturationKgPerCubicMetre) {
    throw new RangeError('SI threshold/background must be below saturation')
  }
  if (a.pulse && (a.pulse.dutyFraction !== 0.5 || !Number.isFinite(a.pulse.periodSeconds) ||
      a.pulse.periodSeconds <= 0 || !Number.isFinite(a.pulse.phaseSeconds))) throw new RangeError('Invalid 50% pulse contract')
  const equal = (x: number, y: number) => Math.abs(x - y) <= 1e-12 * Math.max(Math.abs(x), Math.abs(y), 1e-30)
  const scale = m.concentrationScaleKgPerCubicMetre
  if (!equal(p.effectiveDiffusivityMetresSquaredPerSecond ?? NaN, a.diffusivityMetresSquaredPerSecond) ||
      !equal(config.sensorNoise, m.noiseKgPerCubicMetre / scale) ||
      !equal(config.sensorSaturation, m.saturationKgPerCubicMetre / scale) ||
      !equal(threshold, m.thresholdKgPerCubicMetre / scale) ||
      !equal(config.sensorPpmPerNormalizedUnit, scale * methanePpmPerMassConcentration(m.temperatureKelvin, m.pressurePascal))) {
    throw new Error('SI atmosphere and instrument units disagree')
  }
  if (config.diffusivityScale !== 1 || config.emissionRateScale !== 1 || config.windSpeedScale !== 1 ||
      config.gustStrength !== 0 || config.turbulenceScale !== 0 || config.sensorProfileId !== 'custom') {
    throw new Error('SI halfspace forbids conflicting legacy forcing and sensor presets')
  }
}

/** Pointwise 3-D atmosphere sampled at the real inlet height by a 2-D robot.
 * Source position and release history remain private to the forward model.
 * Empty display puffs are intentional: this opt-in field is a research backend.
 */
export class PhysicalHalfspacePlume extends FilamentPlume {
  private readonly field: HalfspaceTransport
  private readonly contract: PhysicalAtmosphereConfig
  private readonly domain: number
  private readonly inletHeight: number
  constructor(scenario: Scenario, seed: number, config: SimulationConfig) {
    super(scenario, seed)
    this.contract = structuredClone(config.physicalAtmosphere!)
    this.domain = config.domainMeters
    this.inletHeight = config.localInletSampling!.inletHeightMetres
    const a = this.contract, source = scenario.source
    this.field = new HalfspaceTransport({
      source: { x: (source?.x ?? 0) * this.domain, y: (source?.y ?? 0) * this.domain, z: a.releaseHeightMetres },
      wind: { x: scenario.baseWind.x * this.domain, y: scenario.baseWind.y * this.domain },
      diffusivity: a.diffusivityMetresSquaredPerSecond, sigma: a.sourceWidthMetres,
      rateKgPerSecond: scenario.targetStatus === 'emitting' ? a.emissionRateKgPerSecond : 0,
      panelSeconds: a.quadraturePanelSeconds,
      ...(a.pulse ? { pulse: { periodSeconds: a.pulse.periodSeconds, phaseSeconds: a.pulse.phaseSeconds } } : {}),
    })
  }
  override windAt(_point: Vec2, _time: number) { return { ...this.scenario.baseWind } }
  override transportAt(point: Vec2, time: number) { return this.windAt(point, time) }
  override puffsAt(_time: number) { return [] }
  override concentrationAt(point: Vec2, time: number) {
    const a = this.contract, m = a.measurement
    const excess = this.field.evaluate({ x: point.x * this.domain, y: point.y * this.domain, z: this.inletHeight },
      time + a.sourceAgeAtMissionStartSeconds).concentration
    return (excess + m.backgroundKgPerCubicMetre) / m.concentrationScaleKgPerCubicMetre
  }
  /** Released excess mass in kg; excludes the infinite uniform background. */
  override totalMassAt(time: number) { return this.field.integratedMassAt(time + this.contract.sourceAgeAtMissionStartSeconds) }
}
