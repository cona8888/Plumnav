import { normalizeGslDesign, tubeTransportSeconds, type GslPhysicalDesign } from './physicalDesign'
import type { LocalInletSamplingConfig, SimulationConfig } from './types'

type Segment = { start: number; end: number; initial: number; target: number; tau: number }
const valueAt = (s: Segment, t: number) => s.target + (s.initial - s.target) * Math.exp(-(t - s.start) / s.tau)
const area = (s: Segment, a: number, b: number) => s.target * (b - a) +
  (s.initial - s.target) * s.tau * (Math.exp(-(a - s.start) / s.tau) - Math.exp(-(b - s.start) / s.tau))

/** Clean prehistory, ideal plug delay, asymmetric first-order sensor, trailing mean.
 * Inlet concentration is zero-order-held between solver ticks. No adsorption,
 * tube dispersion, pump-induced plume flow or source-dependent gain is assumed.
 */
export class LocalInletChannel {
  private inputs: Array<{ time: number; value: number }> = []
  private segments: Segment[] = []
  private target = 0
  private state = 0
  private time = 0
  private started = false
  readonly delay: number

  constructor(private readonly settings: LocalInletSamplingConfig) {
    if (![settings.riseTimeConstantSeconds, settings.recoveryTimeConstantSeconds].every(v => Number.isFinite(v) && v > 0) ||
        !Number.isFinite(settings.averagingSeconds) || settings.averagingSeconds < 0) throw new RangeError('Invalid channel response')
    this.delay = tubeTransportSeconds(settings.tubeLengthMetres, settings.tubeInnerDiameterMetres,
      settings.flowLitresPerMinutePerChannel)
  }

  update(time: number, concentration: number) {
    if (!Number.isFinite(time) || time < 0 || (this.started && time <= this.time) ||
        !Number.isFinite(concentration) || concentration < 0) throw new RangeError('Invalid local inlet history')
    this.started = true
    this.inputs.push({ time: time + this.delay, value: concentration })
    const advance = (end: number) => {
      if (end <= this.time) return
      const segment: Segment = { start: this.time, end, initial: this.state, target: this.target,
        tau: this.target >= this.state ? this.settings.riseTimeConstantSeconds : this.settings.recoveryTimeConstantSeconds }
      this.state = valueAt(segment, end)
      this.segments.push(segment)
      this.time = end
    }
    while (this.inputs.length && this.inputs[0]!.time <= time) {
      const input = this.inputs.shift()!
      advance(input.time)
      this.target = input.value
    }
    advance(time)
    const window = this.settings.averagingSeconds
    const cutoff = time - window
    while (this.segments.length && this.segments[0]!.end <= cutoff) this.segments.shift()
    if (window === 0) return this.state
    // Before time zero the clean instrument contributes zero to a full window.
    return this.segments.reduce((sum, s) => sum + area(s, Math.max(cutoff, s.start), s.end), 0) / window
  }
}

export function validateLocalInletConfig(config: SimulationConfig) {
  const p = config.localInletSampling
  if (!p) return
  if((p.localMaximumNomination!==undefined&&(p.localMaximumNomination!=='persistent-turn-v1'||p.localMaximumPolicy!=='fresh-cross-v1'))||
    (p.localMaximumRecentering!==undefined&&(p.localMaximumRecentering!=='higher-flank-v1'||p.localMaximumPolicy!=='fresh-cross-v1'))) {
    throw new Error('Local maximum nomination/recentering requires the explicit fresh cross contract')
  }
  if(p.localMaximumPolicy!==undefined&&(p.localMaximumPolicy!=='fresh-cross-v1'||p.localGradientPolicy!=='head-step-v1')) {
    throw new Error('Local maximum verification requires head-step acquisition')
  }
  if (p.localGradientPolicy !== undefined && (p.localGradientPolicy !== 'head-step-v1' ||
      config.algorithmId !== 'quad-sniff-refine' || p.rayWindowPolicy !== 'rolling-expiry-v1' || p.bearingAblation !== undefined)) {
    throw new Error('Local gradient acquisition requires the rolling physical reference without bearing ablations')
  }
  if (p.rayWindowPolicy !== undefined && (p.rayWindowPolicy !== 'rolling-expiry-v1' ||
      p.bearingGeometry !== 'linearized-local-bearing-v1' || p.acquisitionPolicy !== 'time-budgeted-viewpoints-v1')) {
    throw new Error('Rolling ray window requires physical bearing geometry and timed acquisition')
  }
  if (p.bearingAblation !== undefined && (p.bearingGeometry !== 'linearized-local-bearing-v1' ||
      !['legacy-spacing', 'wind-bearing', 'legacy-geometry', 'no-radius-gate'].includes(p.bearingAblation))) {
    throw new Error('Bearing ablations require the explicit physical bearing model')
  }
  if (p.bearingGeometry !== undefined && (p.bearingGeometry !== 'linearized-local-bearing-v1' ||
      p.acquisitionPolicy !== 'time-budgeted-viewpoints-v1' || p.gradientEstimator !== 'relative-geometry-v1')) {
    throw new Error('Physical bearing geometry requires timed acquisition and relative local gradients')
  }
  if (p.acquisitionPolicy !== undefined && (p.acquisitionPolicy !== 'time-budgeted-viewpoints-v1' ||
      p.candidateLifecycle !== 'bounded-inspection-v1')) throw new Error('Time-budgeted acquisition requires bounded physical inspection')
  if (p.candidateLifecycle !== undefined && (p.candidateLifecycle !== 'bounded-inspection-v1' ||
      config.algorithmId !== 'quad-sniff-refine' || config.scenarioKind !== 'open' || config.robotSpeed <= 0)) {
    throw new Error('Bounded inspection requires local-inlet refinement in an open world with positive mobility')
  }
  if (p.version !== 'local-inlet-v1' || p.fieldInterpretation !== 'prescribed-horizontal-slice') throw new Error('Unknown local inlet contract')
  if (p.effectiveDiffusivityMetresSquaredPerSecond !== undefined &&
      (!Number.isFinite(p.effectiveDiffusivityMetresSquaredPerSecond) || p.effectiveDiffusivityMetresSquaredPerSecond <= 0 ||
        config.diffusivityScale !== 1)) throw new RangeError('SI diffusivity requires a positive coefficient and unit legacy multiplier')
  if (p.gradientEstimator !== undefined && p.gradientEstimator !== 'relative-geometry-v1') throw new Error('Unknown gradient estimator')
  for (const key of ['opposingInletSpacingMetres', 'inletHeightMetres', 'robotLengthMetres', 'robotWidthMetres',
    'referenceWindMetresPerSecond', 'tubeInnerDiameterMetres', 'flowLitresPerMinutePerChannel',
    'riseTimeConstantSeconds', 'recoveryTimeConstantSeconds', 'sampleIntervalSeconds',
    'maximumTurnRateRadiansPerSecond'] as const) {
    if (!Number.isFinite(p[key]) || p[key] <= 0) throw new RangeError(`Invalid local inlet ${key}`)
  }
  for (const key of ['tubeLengthMetres', 'averagingSeconds'] as const) {
    if (!Number.isFinite(p[key]) || p[key] < 0) throw new RangeError(`Invalid local inlet ${key}`)
  }
  if (p.opposingInletSpacingMetres >= Math.min(p.robotLengthMetres, p.robotWidthMetres) ||
      Math.hypot(p.robotLengthMetres, p.robotWidthMetres) >= config.domainMeters) throw new RangeError('Head must fit inside the robot and domain')
  const ticks = p.sampleIntervalSeconds / config.fixedDt
  if (ticks < 1 || Math.abs(ticks - Math.round(ticks)) > 1e-9) throw new RangeError('Sample cadence must be an integer number of engine ticks')
  if (config.terrainSlopeDegrees !== 0 || config.algorithmId === 'pulse-sniff') throw new Error('Local inlet v1 supports flat slices and no pulse-jet controller')
  if (config.activeSniffCycleSeconds !== p.inspection.dwellSeconds ||
      Math.abs(config.activeSniffReach - p.opposingInletSpacingMetres / (2 * config.domainMeters)) > 1e-12) throw new Error('Local scan clock/geometry disagree with physical contract')
  if ([config.quadChannelNoiseCorrelation, config.quadChannelGainMismatch,
    config.quadChannelCrossTalk, config.quadChannelLagMismatch].some(v => v !== 0)) throw new Error('Local inlet v1 does not implement quad nuisance presets')
  const c = p.inspection
  const scan = p.scanPolicy
  if (scan) {
    if (scan.version !== 'bounded-pose-scans-v1' ||
        !Number.isInteger(scan.maximumCompletedScansPerPose) || scan.maximumCompletedScansPerPose < 1 ||
        !Number.isFinite(scan.relocationDistanceNormalized) || scan.relocationDistanceNormalized <= 0 || scan.relocationDistanceNormalized >= 0.25 ||
        !Number.isFinite(scan.arrivalRadiusNormalized) || scan.arrivalRadiusNormalized <= 0 || scan.arrivalRadiusNormalized >= scan.relocationDistanceNormalized / 2 ||
        !Number.isFinite(scan.maximumRelocationSeconds) || scan.maximumRelocationSeconds <= 0) throw new RangeError('Invalid bounded scan policy')
  }
  const minimumSettling = tubeTransportSeconds(p.tubeLengthMetres, p.tubeInnerDiameterMetres,
    p.flowLitresPerMinutePerChannel) - Math.log(0.05) * Math.max(p.riseTimeConstantSeconds, p.recoveryTimeConstantSeconds) + p.averagingSeconds
  if (c.version !== 'settled-spatial-confirmation-v1') throw new Error('Unknown inspection contract')
  for (const [key, value] of Object.entries(c)) {
    if (key !== 'version' && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) throw new RangeError(`Invalid inspection ${key}`)
  }
  if (c.settlingSeconds < minimumSettling - 1e-9 ||
      c.arrivalRadiusNormalized >= c.zoneRadiusNormalized || c.zoneRadiusNormalized >= c.offsetNormalized / 2 ||
      c.offsetNormalized >= 0.25 || !Number.isInteger(c.minimumSamplesPerWaypoint) || c.minimumSamplesPerWaypoint < 2 ||
      c.sampleSpacingSeconds < p.sampleIntervalSeconds || c.dwellSeconds < c.settlingSeconds +
        c.minimumSamplesPerWaypoint * c.sampleSpacingSeconds) throw new RangeError('Inconsistent inspection geometry/timing')
}

/** An opt-in numerical reference, not a commercial instrument calibration.
 * Position is normalized by L; engine clocks remain SI seconds (NOT L/U time).
 * Flow belongs to each of four continuously pumped channels.
 */
export function withLocalInletDesign(base: SimulationConfig, design: GslPhysicalDesign, options: {
  recoveryTimeConstantSeconds: number; maximumTurnRateRadiansPerSecond: number
}): SimulationConfig {
  const n = normalizeGslDesign(design)
  const dt = base.fixedDt
  const settle = n.derived.tubeDelaySeconds - Math.log(0.05) *
    Math.max(design.sensorTimeConstantSeconds, options.recoveryTimeConstantSeconds) + design.averagingSeconds
  const dwell = Math.ceil(Math.max(design.dwellSeconds, settle + 2 * design.sampleIntervalSeconds + dt) / dt) * dt
  const offset = design.inspectionStepMetres / design.domainMetres
  const localInletSampling: LocalInletSamplingConfig = {
    version: 'local-inlet-v1', fieldInterpretation: 'prescribed-horizontal-slice',
    opposingInletSpacingMetres: design.opposingInletSpacingMetres, inletHeightMetres: design.inletHeightMetres,
    robotLengthMetres: design.robotLengthMetres, robotWidthMetres: design.robotWidthMetres,
    referenceWindMetresPerSecond: design.referenceWindMetresPerSecond,
    ...(design.effectiveDiffusivityMetresSquaredPerSecond !== undefined
      ? { effectiveDiffusivityMetresSquaredPerSecond: design.effectiveDiffusivityMetresSquaredPerSecond } : {}),
    tubeLengthMetres: design.tubeLengthMetres, tubeInnerDiameterMetres: design.tubeInnerDiameterMetres,
    flowLitresPerMinutePerChannel: design.actualFlowLitresPerMinute,
    riseTimeConstantSeconds: design.sensorTimeConstantSeconds,
    recoveryTimeConstantSeconds: options.recoveryTimeConstantSeconds,
    averagingSeconds: design.averagingSeconds, sampleIntervalSeconds: design.sampleIntervalSeconds,
    maximumTurnRateRadiansPerSecond: options.maximumTurnRateRadiansPerSecond,
    inspection: { version: 'settled-spatial-confirmation-v1', offsetNormalized: offset,
      zoneRadiusNormalized: offset * 0.2, arrivalRadiusNormalized: offset * 0.1,
      settlingSeconds: settle, dwellSeconds: dwell, sampleSpacingSeconds: design.sampleIntervalSeconds,
      maximumPairSeparationSeconds: 2 * dwell + 2 * design.inspectionStepMetres / Math.max(1e-9, design.robotSpeedMetresPerSecond),
      minimumSamplesPerWaypoint: 2 },
  }
  const config: SimulationConfig = { ...base, checkpointSeconds: [...base.checkpointSeconds],
    domainMeters: design.domainMetres, robotSpeed: design.robotSpeedMetresPerSecond / design.domainMetres,
    sensorProfileId: 'custom', sensorLag: design.sensorTimeConstantSeconds,
    activeSniffReach: design.opposingInletSpacingMetres / (2 * design.domainMetres),
    activeSniffCycleSeconds: dwell, localInletSampling }
  if (design.effectiveDiffusivityMetresSquaredPerSecond !== undefined) config.diffusivityScale = 1
  validateLocalInletConfig(config)
  return config
}

/** Optional anti-stall experiment: two scans, then one head-spacing relocation.
 * Travel allowance is three times nominal 0.6-speed travel plus a half turn;
 * it is an engineering timeout, not an inferred plume decorrelation time.
 */
export function withBoundedPoseScans(base: SimulationConfig): SimulationConfig {
  if (!base.localInletSampling || base.robotSpeed <= 0) throw new Error('Bounded pose scans require local sensing and positive mobility')
  const result = structuredClone(base)
  const p = result.localInletSampling!
  const separation = p.opposingInletSpacingMetres / result.domainMeters
  p.scanPolicy = { version: 'bounded-pose-scans-v1', maximumCompletedScansPerPose: 2,
    relocationDistanceNormalized: separation, arrivalRadiusNormalized: separation * 0.1,
    maximumRelocationSeconds: Math.PI / p.maximumTurnRateRadiansPerSecond + 3 * separation / (0.6 * result.robotSpeed) }
  validateLocalInletConfig(result)
  return result
}
