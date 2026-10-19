import { createController } from './algorithms'
import {
  QUAD_CANDIDATE_FORMATION_GATE_NAMES,
  QUAD_DECLARATION_GATE_NAMES,
  estimateQuadGradient,
} from './algorithms/quadSoilSniff'
import {
  activeSniffFrameAt,
  activeSniffStatusAt,
  createActiveSniffEvent,
  type ActiveSniffEvent,
} from './activeSniff'
import { DEFAULT_PHYSICS_STEP_SECONDS, effectiveSensorThreshold, validateSimulationConfig } from './config'
import { createEnvironment } from './environment'
import {
  createControllerObservationModel,
  type ControllerObservationModel,
} from './controllerObservationModel'
import { GridPlume } from './gridPlume'
import { LocalInletChannel } from './localInletSampling'
import { PhysicalHalfspacePlume } from './physicalAtmosphere'
import { add, clamp, distance, normalize, percentile, rotate, scale } from './math'
import { FilamentPlume, type PlumeModel } from './plume'
import {
  createQuadSniffEvent,
  integrateQuadSniffEvent,
  quadSniffEffectiveSampleCount,
  quadSniffFrameAt,
  quadSniffStatusAt,
  quadSniffChannelDirections,
  type QuadSniffEvent,
} from './quadSniff'
import { SeededRandom, hashNumbers } from './rng'
import { createScenario } from './scenarios'
import {
  terrainHeightAt,
  terrainMobilityScale,
  terrainSurfaceDistance,
} from './terrain'
import type {
  AlgorithmController,
  AlgorithmDecision,
  AlgorithmEnvironment,
  ActiveSniffFrame,
  Measurement,
  MetricSnapshot,
  Observation,
  QuadCandidateFormationGateName,
  QuadCandidateFormationStatus,
  QuadDeclarationEvidenceStatus,
  QuadDeclarationGateName,
  QuadSniffChannelId,
  QuadSniffChannelReading,
  QuadSniffFrame,
  QuadSniffStatus,
  Scenario,
  SimulationConfig,
  SimulationFrame,
  Vec2,
} from './types'

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export class SimulationEngine {
  config: SimulationConfig
  scenario: Scenario
  readonly plume: PlumeModel
  readonly observationModel: ControllerObservationModel
  readonly environment: AlgorithmEnvironment
  readonly controller: AlgorithmController

  private rng: SeededRandom
  private time = 0
  private running = false
  private completed = false
  private completionReason: string | null = null
  private position: Vec2
  private heading = 0
  private path: Vec2[]
  private observations: Observation[] = []
  private decision: AlgorithmDecision
  private measurement: Measurement
  private sensorState = 0
  private localChannels: LocalInletChannel[] = []
  private localReadout: number[] = [0, 0, 0, 0]
  private quadSensorStates: Record<QuadSniffChannelId, number> = {
    front: 0,
    left: 0,
    aft: 0,
    right: 0,
  }
  private distanceTravelled = 0
  private surfaceDistanceTravelled = 0
  private elevationGain = 0
  private elevationLoss = 0
  private terrainMobilityTotal = 0
  private terrainMobilitySamples = 0
  private passiveSamples = 0
  private activeReturnSamples = 0
  private hitCount = 0
  private activeReturnHits = 0
  private contactEpisodes = 0
  private plumeTime = 0
  private reacquisitions = 0
  private collisionAttempts = 0
  private falseDeclarations = 0
  private wasHit = false
  private lastHitTime = -Infinity
  private firstDeclarationRecorded = false
  private declarationTimeSeconds: number | null = null
  private declarationErrorNormalized: number | null = null
  private firstAbstentionRecorded = false
  private abstentionTimeSeconds: number | null = null
  private frozenAfterTerminalDecision = false
  private computeTimes: number[] = []
  private checkpoints: Record<number, MetricSnapshot> = {}
  private initialSourceDistance: number | null
  private initialSurfaceSourceDistance: number | null
  private activeSniffEvent: ActiveSniffEvent | null = null
  private displayedActiveSniff: ActiveSniffFrame | null = null
  private lastActiveProbeId: number | null = null
  private quadSniffEvent: QuadSniffEvent | null = null
  private displayedQuadSniff: QuadSniffFrame | null = null
  private lastQuadScanId: number | null = null
  private activeProbeCount = 0
  private quadSniffCycles = 0
  private quadChannelReturns = 0
  private quadPassiveCycles = 0
  private quadPassiveChannelReturns = 0
  private quadPassiveSamplingSeconds = 0
  private quadSuctionEnergy = 0
  private quadContrastTotal = 0
  private quadContrastSamples = 0
  private quadReturnCycles = 0
  private quadValidDirections = 0
  private quadDirectionAbstentions = 0
  private quadSaturatedChannels = 0
  private quadSupportTotal = 0
  private quadIntegrationSamplesTotal = 0
  private quadEffectiveSamplesTotal = 0
  private quadDeclarationEvaluations = 0
  private quadDeclarationCandidateEvaluations = 0
  private quadDeclarationMaxScore = 0
  private quadDeclarationMaxGatesPassed = 0
  private quadDeclarationBestEvidence: QuadDeclarationEvidenceStatus | null = null
  private quadDeclarationGatePasses = Object.fromEntries(
    QUAD_DECLARATION_GATE_NAMES.map((name) => [name, 0]),
  ) as Record<QuadDeclarationGateName, number>
  private quadCandidateFormationEvaluations = 0
  private quadCandidateProvisionalRayEvaluations = 0
  private quadCandidateMaxGradientRayPoolCount = 0
  private quadCandidateMaxProvisionalRayCount = 0
  private quadCandidateMaxQuality = 0
  private quadCandidateMinResidual: number | null = null
  private quadCandidateMaxSurfaceSupport = 0
  private quadCandidateBestFormation: QuadCandidateFormationStatus | null = null
  private quadCandidateGatePasses = Object.fromEntries(
    QUAD_CANDIDATE_FORMATION_GATE_NAMES.map((name) => [name, 0]),
  ) as Record<QuadCandidateFormationGateName, number>
  private activeSamplingSeconds = 0
  private airPulseEnergy = 0

  constructor(config: SimulationConfig) {
    validateSimulationConfig(config)
    this.config = {
      ...config,
      ...(config.physicalAtmosphere ? { physicalAtmosphere: structuredClone(config.physicalAtmosphere) } : {}),
      ...(config.localInletSampling ? { localInletSampling: structuredClone(config.localInletSampling) } : {}),
      checkpointSeconds: [...config.checkpointSeconds],
      sourcePositionOverride: config.sourcePositionOverride
        ? { ...config.sourcePositionOverride }
        : undefined,
      robotStartPositionOverride: config.robotStartPositionOverride
        ? { ...config.robotStartPositionOverride }
        : undefined,
    }
    config = this.config
    this.scenario = createScenario(config.scenarioKind, config.seed, config)
    const local = config.localInletSampling
    if (local) {
      this.localChannels = Array.from({ length: 4 }, () => new LocalInletChannel(local))
    }
    this.plume = config.physicalAtmosphere
      ? new PhysicalHalfspacePlume(this.scenario, config.seed, config)
      : config.physicsMode === 'grid'
      ? new GridPlume(this.scenario, config.seed, {
          resolution: config.gridResolution,
          stepSeconds: config.physicsStepSeconds ?? DEFAULT_PHYSICS_STEP_SECONDS,
        })
      : new FilamentPlume(this.scenario, config.seed)
    const {
      source: _hiddenSource,
      targetStatus: _hiddenTargetStatus,
      ...publicScenario
    } = this.scenario
    this.observationModel = createControllerObservationModel(
      publicScenario,
      config.observationModelSeed,
    )
    this.environment = createEnvironment(
      this.scenario,
      config.controllerSeed,
      this.observationModel,
      config.robotSpeed,
      config.durationSeconds,
      config.activeSniffEnabled,
      config.activeSniffCycleSeconds,
      config.activeSniffReach,
      config.sensorNoise,
      local ? { clearance: Math.hypot(local.robotLengthMetres, local.robotWidthMetres) / (2 * config.domainMeters),
        inspection: local.inspection, scanPolicy: local.scanPolicy, gradientEstimator: local.gradientEstimator,
        acquisitionPolicy: local.acquisitionPolicy,
        rayWindowPolicy: local.rayWindowPolicy,
        localGradientPolicy: local.localGradientPolicy,
        localMaximum: local.localMaximumPolicy ? {version:local.localMaximumPolicy,sensorSaturation:config.sensorSaturation,
          ...(local.localMaximumNomination?{nomination:local.localMaximumNomination}:{}),
          ...(local.localMaximumRecentering?{recentering:local.localMaximumRecentering}:{})} : undefined,
        bearingGeometry: local.bearingGeometry,
        bearingAblation: local.bearingAblation,
        candidateLifecycle: local.candidateLifecycle ? { version: local.candidateLifecycle,
          maximumTurnRateRadiansPerSecond: local.maximumTurnRateRadiansPerSecond } : undefined } : undefined,
    )
    this.controller = createController(config.algorithmId)
    this.controller.reset(this.environment)
    this.rng = new SeededRandom(hashNumbers(config.seed, 9_173))
    this.position = { ...this.scenario.robotStart }
    this.heading = ((config.robotStartHeadingDegrees ?? 0) * Math.PI) / 180
    this.path = [{ ...this.position }]
    this.initialSourceDistance = this.scenario.source
      ? distance(this.position, this.scenario.source)
      : null
    this.initialSurfaceSourceDistance = this.scenario.source
      ? terrainSurfaceDistance(this.scenario, this.position, this.scenario.source)
      : null
    this.measurement = {
      time: 0,
      concentration: 0,
      hit: false,
      wind: this.plume.windAt(this.position, 0),
      valid: true,
      sampleMode: 'passive',
    }
    this.decision = {
      direction: { x: 0, y: 0 },
      estimate: null,
      confidence: 0,
      phase: 'READY',
    }
  }

  setRunning(value: boolean) {
    if (!this.completed) this.running = value
  }

  isRunning() {
    return this.running
  }

  isCompleted() {
    return this.completed
  }

  getTime() {
    return this.time
  }

  private sense(): Measurement {
    if (this.config.localInletSampling) return this.senseLocalInlets()
    const quadEvent = this.quadSniffEvent
    if (quadEvent) {
      integrateQuadSniffEvent(quadEvent, this.time, this.plume)
      const quadSniff = quadSniffStatusAt(quadEvent, this.time)
      this.displayedQuadSniff = quadSniffFrameAt(quadEvent, this.time)
      this.displayedActiveSniff = null
      if (quadSniff.phase !== 'return') {
        return {
          time: this.time,
          concentration: this.sensorState,
          hit: false,
          wind: this.senseWind(),
          valid: false,
          sampleMode: 'blanked',
          quadSniff,
        }
      }
      return this.senseQuadConcentration(quadEvent, quadSniff)
    }

    const activeEvent = this.activeSniffEvent
    if (activeEvent) {
      const activeSniff = activeSniffStatusAt(activeEvent, this.time)
      this.displayedActiveSniff = activeSniffFrameAt(activeEvent, this.time)
      this.displayedQuadSniff = null
      if (activeSniff.phase !== 'return') {
        return {
          time: this.time,
          concentration: this.sensorState,
          hit: false,
          wind: this.senseWind(),
          valid: false,
          sampleMode: 'blanked',
          activeSniff,
        }
      }
      return this.senseConcentration(activeEvent.latentReturn, 'active-return', activeSniff)
    }

    this.displayedActiveSniff = null
    this.displayedQuadSniff = null
    return this.senseConcentration(
      this.plume.concentrationAt(this.position, this.time),
      'passive',
    )
  }

  private senseWind() {
    const trueWind = this.plume.windAt(this.position, this.time)
    const angleNoise = this.rng.normal(0, this.config.windNoise)
    return scale(
      rotate(trueWind, angleNoise),
      1 + this.rng.normal(0, this.config.windNoise * 0.25),
    )
  }

  /** Same four continuous local channels supply the scalar mean and requested array returns. */
  private senseLocalInlets(): Measurement {
    const p = this.config.localInletSampling!
    const radius = p.opposingInletSpacingMetres / (2 * this.config.domainMeters)
    const geometry = quadSniffChannelDirections({ x: Math.cos(this.heading), y: Math.sin(this.heading) })
      .map(({ channel, direction }) => ({ channel, direction, reach: radius, support: 1,
        effectiveOffset: scale(direction, radius) }))
    const values = geometry.map((g, index) => {
      const point = add(this.position, g.effectiveOffset)
      // A blocked inlet is unsupported, never a substitute measurement at the robot centre.
      if (this.environment.isBlocked(point, 0)) throw new Error('Local inlet intersects a wall or domain boundary')
      return this.localChannels[index]!.update(this.time, this.plume.concentrationAt(point, this.time))
    })
    const due = Math.round(this.time / this.config.fixedDt) %
      Math.round(p.sampleIntervalSeconds / this.config.fixedDt) === 0
    if (due) this.localReadout = values.map(value => clamp(value + this.rng.normal(0, this.config.sensorNoise), 0, this.config.sensorSaturation))
    const threshold = effectiveSensorThreshold(this.config)
    const classify = (value: number) => {
      const hit = value >= threshold
      if (hit && this.config.sensorFalseNegativeRate > 0) return this.rng.next() >= this.config.sensorFalseNegativeRate
      if (!hit && this.config.sensorFalsePositiveRate > 0) return this.rng.next() < this.config.sensorFalsePositiveRate
      return hit
    }
    const concentration = this.localReadout.reduce((a, b) => a + b, 0) / 4
    const event = this.quadSniffEvent
    const returned = Boolean(event && this.time >= event.startedAt + event.cycleSeconds && due)
    const readings = geometry.map((g, index): QuadSniffChannelReading => ({ ...g,
      concentration: this.localReadout[index]!, hit: returned ? classify(this.localReadout[index]!) : false,
      integrationSamples: 1, effectiveIntegrationSamples: 1,
      saturated: this.localReadout[index]! >= this.config.sensorSaturation - 1e-9 }))
    const status: QuadSniffStatus | undefined = event ? {
      ...quadSniffStatusAt(event, this.time), channels: geometry,
      phase: returned ? 'return' : 'aspirate', ...(returned ? { readings } : {}),
    } : undefined
    this.displayedActiveSniff = null
    this.displayedQuadSniff = event ? { ...quadSniffFrameAt(event, this.time), ...status!, ...(returned ? { readings } : {}) } : null
    this.sensorState = concentration
    return { time: this.time, concentration, wind: this.senseWind(),
      ...(this.config.physicalAtmosphere ? { localInletReadings: readings.map(({channel,concentration,saturated,effectiveOffset}) =>
        ({channel,concentration,saturated,effectiveOffset:{...effectiveOffset}})) } : {}),
      valid: event ? returned : due,
      hit: event ? returned && readings.some(r => r.hit) : due && classify(concentration),
      sampleMode: event ? returned ? 'quad-passive-return' : 'blanked' : 'passive',
      ...(status ? { quadSniff: status } : {}) }
  }

  private senseConcentration(
    trueConcentration: number,
    sampleMode: 'passive' | 'active-return',
    activeSniff?: Measurement['activeSniff'],
  ): Measurement {
    if (
      sampleMode === 'passive' &&
      (this.config.algorithmId === 'quad-sniff' ||
        this.config.algorithmId === 'quad-sniff-wind' ||
        this.config.algorithmId === 'quad-sniff-range' ||
        this.config.algorithmId === 'quad-sniff-corridor' ||
        this.config.algorithmId === 'quad-sniff-bracket' ||
        this.config.algorithmId === 'quad-sniff-refine' ||
        this.config.algorithmId === 'quad-sniff-confirmation' ||
        this.config.algorithmId === 'quad-sniff-adaptive' ||
        this.config.algorithmId === 'quad-sniff-staged' ||
        this.config.algorithmId === 'quad-sniff-legacy' ||
        this.config.algorithmId === 'quad-passive')
    ) {
      // The four physical channels share the local ambient baseline between
      // aspiration events. Relaxing them here avoids retaining a stale prior
      // scan through a long passive interval when sensor lag is large; their
      // independent noise and active delivery remain applied only on return.
      const baselineAlpha = 1 - Math.exp(
        -this.config.fixedDt / Math.max(0.05, this.config.sensorLag),
      )
      for (const channel of ['front', 'left', 'aft', 'right'] as const) {
        this.quadSensorStates[channel] +=
          (Math.max(0, trueConcentration) - this.quadSensorStates[channel]) *
          baselineAlpha
      }
    }
    const responseAlpha = 1 - Math.exp(-this.config.fixedDt / Math.max(0.05, this.config.sensorLag))
    // Memory acts on the physical signal. Readout noise is added afterwards,
    // so rectified noise is not accumulated as a persistent blank offset.
    this.sensorState += (Math.max(0, trueConcentration) - this.sensorState) * responseAlpha

    const wind = this.senseWind()
    const concentration = clamp(
      this.sensorState + this.rng.normal(0, this.config.sensorNoise),
      0,
      this.config.sensorSaturation,
    )
    const threshold = effectiveSensorThreshold(this.config)
    let hit = concentration >= threshold
    if (hit && this.config.sensorFalseNegativeRate > 0) {
      hit = this.rng.next() >= this.config.sensorFalseNegativeRate
    } else if (!hit && this.config.sensorFalsePositiveRate > 0) {
      hit = this.rng.next() < this.config.sensorFalsePositiveRate
    }
    return {
      time: this.time,
      concentration,
      hit,
      wind,
      valid: true,
      sampleMode,
      activeSniff,
    }
  }

  private senseQuadConcentration(
    event: QuadSniffEvent,
    status: QuadSniffStatus,
  ): Measurement {
    const effectiveIntegrationSamples = quadSniffEffectiveSampleCount(event)
    const threshold = effectiveSensorThreshold(this.config)
    const hasQuadNuisance =
      this.config.quadChannelNoiseCorrelation !== 0 ||
      this.config.quadChannelGainMismatch !== 0 ||
      this.config.quadChannelCrossTalk !== 0 ||
      this.config.quadChannelLagMismatch !== 0
    // The nuisance branch is opt-in and Quad-only. In both branches, channel
    // dynamics act before measurement noise.
    if (!hasQuadNuisance) {
      const responseAlpha = 1 - Math.exp(
        -event.cycleSeconds / Math.max(0.05, this.config.sensorLag),
      )
      return this.finishQuadReturn(event, status, threshold, effectiveIntegrationSamples,
        event.latentChannels.map((channel) => Math.max(0, channel.latentConcentration)),
        () => responseAlpha,
      )
    }

    const gainFactors = [1, -1, 0.5, -0.5] as const
    const gained = event.latentChannels.map((channel, index) =>
      channel.latentConcentration * (1 + this.config.quadChannelGainMismatch * gainFactors[index]!),
    )
    const gainedMean = gained.reduce((sum, value) => sum + value, 0) / Math.max(1, gained.length)
    const sharedNoise = this.rng.normal(
      0,
      this.config.sensorNoise / Math.sqrt(effectiveIntegrationSamples),
    )
    const independentScale = Math.sqrt(1 - this.config.quadChannelNoiseCorrelation)
    const sharedScale = Math.sqrt(this.config.quadChannelNoiseCorrelation)
    const targets = gained.map((value) => Math.max(0,
      (1 - this.config.quadChannelCrossTalk) * value +
        this.config.quadChannelCrossTalk * gainedMean,
    ))
    const readoutNoise = targets.map(() =>
      sharedScale * sharedNoise + independentScale * this.rng.normal(
        0,
        this.config.sensorNoise / Math.sqrt(effectiveIntegrationSamples),
      ))
    return this.finishQuadReturn(event, status, threshold, effectiveIntegrationSamples, targets,
      (_channel, index) => {
        const lagFactor = 1 + this.config.quadChannelLagMismatch * gainFactors[index]!
        return 1 - Math.exp(-event.cycleSeconds / Math.max(0.05, this.config.sensorLag * lagFactor))
      }, readoutNoise,
    )
  }

  /** Applies independent channel response states after optional nuisance synthesis. */
  private finishQuadReturn(
    event: QuadSniffEvent,
    status: QuadSniffStatus,
    threshold: number,
    effectiveIntegrationSamples: number,
    targets: readonly number[],
    responseAlphaFor: (channel: QuadSniffChannelReading['channel'], index: number) => number,
    correlatedReadoutNoise?: readonly number[],
  ): Measurement {
    const readings: QuadSniffChannelReading[] = event.latentChannels.map((channel, index) => {
      const noisyTarget = Math.max(
        0, targets[index] ?? 0,
      )
      const previous = this.quadSensorStates[channel.channel]
      const state = previous + (noisyTarget - previous) * responseAlphaFor(channel.channel, index)
      this.quadSensorStates[channel.channel] = state
      const readoutNoise = correlatedReadoutNoise?.[index] ?? this.rng.normal(
        0,
        this.config.sensorNoise / Math.sqrt(effectiveIntegrationSamples),
      )
      const concentration = clamp(state + readoutNoise, 0, this.config.sensorSaturation)
      let hit = concentration >= threshold
      if (hit && this.config.sensorFalseNegativeRate > 0) {
        hit = this.rng.next() >= this.config.sensorFalseNegativeRate
      } else if (!hit && this.config.sensorFalsePositiveRate > 0) {
        hit = this.rng.next() < this.config.sensorFalsePositiveRate
      }
      return {
        channel: channel.channel,
        direction: { ...channel.direction },
        reach: channel.reach,
        support: channel.support,
        effectiveOffset: { ...channel.effectiveOffset },
        concentration,
        hit,
        integrationSamples: channel.integrationSamples,
        effectiveIntegrationSamples,
        saturated: concentration >= this.config.sensorSaturation - 1e-9,
      }
    })
    const concentration = readings.reduce(
      (sum, reading) => sum + reading.concentration,
      0,
    ) / Math.max(1, readings.length)
    const quadSniff: QuadSniffStatus = {
      ...status,
      channels: status.channels.map((channel) => ({
        ...channel,
        direction: { ...channel.direction },
        effectiveOffset: { ...channel.effectiveOffset },
      })),
      readings,
    }
    this.displayedQuadSniff = {
      ...quadSniffFrameAt(event, this.time),
      readings: readings.map((reading) => ({
        ...reading,
        direction: { ...reading.direction },
        effectiveOffset: { ...reading.effectiveOffset },
      })),
    }
    return {
      time: this.time,
      concentration,
      hit: readings.some((reading) => reading.hit),
      wind: this.senseWind(),
      valid: true,
      sampleMode: event.samplingMode === 'passive-array'
        ? 'quad-passive-return'
        : 'quad-return',
      quadSniff,
    }
  }

  step() {
    if (this.completed) return this.getFrame()
    if (this.frozenAfterTerminalDecision) {
      this.advanceClock()
      return this.getFrame()
    }
    this.measurement = this.sense()
    if (this.measurement.valid) {
      const observation: Observation = { ...this.measurement, position: { ...this.position } }
      this.observations.push(observation)
      if (this.measurement.sampleMode === 'passive') this.passiveSamples += 1
      if (
        this.measurement.sampleMode === 'active-return' ||
        this.measurement.sampleMode === 'quad-return'
      ) {
        this.activeReturnSamples += 1
        if (this.measurement.hit) this.activeReturnHits += 1
      }
      if (
        this.measurement.sampleMode === 'quad-return' ||
        this.measurement.sampleMode === 'quad-passive-return'
      ) {
        const readings = this.measurement.quadSniff?.readings ?? []
        this.quadChannelReturns += readings.length
        if (this.measurement.sampleMode === 'quad-passive-return') {
          this.quadPassiveChannelReturns += readings.length
        }
        const gradient = estimateQuadGradient(readings, this.config.sensorNoise, this.config.localInletSampling?.gradientEstimator)
        const activeStrength = this.measurement.quadSniff?.strength ?? 0
        const passiveArray = this.measurement.quadSniff?.samplingMode === 'passive-array'
        this.quadReturnCycles += 1
        if (gradient.validDirection && (passiveArray || activeStrength >= 0.05)) {
          this.quadValidDirections += 1
        } else {
          this.quadDirectionAbstentions += 1
        }
        this.quadSaturatedChannels += readings.filter(
          (reading) => reading.saturated,
        ).length
        this.quadSupportTotal += readings.reduce(
          (sum, reading) => sum + reading.support,
          0,
        ) / Math.max(1, readings.length)
        this.quadIntegrationSamplesTotal += readings.reduce(
          (sum, reading) => sum + reading.integrationSamples,
          0,
        ) / Math.max(1, readings.length)
        this.quadEffectiveSamplesTotal += readings.reduce(
          (sum, reading) => sum + reading.effectiveIntegrationSamples,
          0,
        ) / Math.max(1, readings.length)
        if (
          gradient.usableChannels >= 3 &&
          (passiveArray || activeStrength >= 0.05)
        ) {
          this.quadContrastTotal += gradient.normalizedContrast
          this.quadContrastSamples += 1
        }
      }
    }

    // Plume-contact metrics use passive samples only, so an active method
    // cannot inflate its encounter count by requesting extra return samples.
    if (this.measurement.valid && this.measurement.sampleMode === 'passive' && this.measurement.hit) {
      this.hitCount += 1
      this.plumeTime += this.config.localInletSampling
        ? Math.min(this.config.localInletSampling.sampleIntervalSeconds, this.time) : this.config.fixedDt
      if (!this.wasHit) {
        this.contactEpisodes += 1
        if (Number.isFinite(this.lastHitTime) && this.time - this.lastHitTime > 1.5) this.reacquisitions += 1
      }
      this.lastHitTime = this.time
    }
    if (this.measurement.valid && this.measurement.sampleMode === 'passive') this.wasHit = this.measurement.hit

    const computeStart = now()
    this.decision = this.controller.step({
      time: this.time,
      dt: this.config.fixedDt,
      position: { ...this.position },
      heading: this.heading,
      measurement: this.measurement,
      observations: this.observations,
      distance: this.distanceTravelled,
    })
    const computeDuration = Math.max(0, now() - computeStart)
    this.computeTimes.push(computeDuration)

    const declarationEvidence = this.decision.quadDeclarationEvidence
    if (declarationEvidence) {
      const formation = declarationEvidence.candidateFormation
      this.quadCandidateFormationEvaluations += 1
      if (formation.provisionalCandidate) this.quadCandidateProvisionalRayEvaluations += 1
      this.quadCandidateMaxGradientRayPoolCount = Math.max(
        this.quadCandidateMaxGradientRayPoolCount,
        formation.gradientRayPoolCount,
      )
      this.quadCandidateMaxProvisionalRayCount = Math.max(
        this.quadCandidateMaxProvisionalRayCount,
        formation.provisionalRayCount ?? 0,
      )
      this.quadCandidateMaxQuality = Math.max(
        this.quadCandidateMaxQuality,
        formation.provisionalRayQuality ?? 0,
      )
      if (formation.provisionalRayResidual !== null) {
        this.quadCandidateMinResidual = this.quadCandidateMinResidual === null
          ? formation.provisionalRayResidual
          : Math.min(this.quadCandidateMinResidual, formation.provisionalRayResidual)
      }
      this.quadCandidateMaxSurfaceSupport = Math.max(
        this.quadCandidateMaxSurfaceSupport,
        formation.surfaceSupportCount,
      )
      for (const gate of QUAD_CANDIDATE_FORMATION_GATE_NAMES) {
        if (formation.gates[gate]) this.quadCandidateGatePasses[gate] += 1
      }
      const replacesBestFormation =
        formation.gatesPassed > (this.quadCandidateBestFormation?.gatesPassed ?? -1) ||
        (
          formation.gatesPassed === (this.quadCandidateBestFormation?.gatesPassed ?? -1) &&
          (formation.provisionalRayQuality ?? -1) >
            (this.quadCandidateBestFormation?.provisionalRayQuality ?? -1)
        )
      if (replacesBestFormation) {
        this.quadCandidateBestFormation = {
          ...formation,
          provisionalCandidate: formation.provisionalCandidate
            ? { ...formation.provisionalCandidate }
            : null,
          gates: { ...formation.gates },
        }
      }
      this.quadDeclarationEvaluations += 1
      if (declarationEvidence.candidate) this.quadDeclarationCandidateEvaluations += 1
      this.quadDeclarationMaxScore = Math.max(
        this.quadDeclarationMaxScore,
        declarationEvidence.score,
      )
      for (const gate of QUAD_DECLARATION_GATE_NAMES) {
        if (declarationEvidence.gates[gate]) this.quadDeclarationGatePasses[gate] += 1
      }
      const replacesBest =
        declarationEvidence.gatesPassed > this.quadDeclarationMaxGatesPassed ||
        (
          declarationEvidence.gatesPassed === this.quadDeclarationMaxGatesPassed &&
          declarationEvidence.score > (this.quadDeclarationBestEvidence?.score ?? -1)
        )
      this.quadDeclarationMaxGatesPassed = Math.max(
        this.quadDeclarationMaxGatesPassed,
        declarationEvidence.gatesPassed,
      )
      if (replacesBest) {
        this.quadDeclarationBestEvidence = {
          ...declarationEvidence,
          candidate: declarationEvidence.candidate
            ? { ...declarationEvidence.candidate }
            : null,
          gates: { ...declarationEvidence.gates },
          candidateFormation: {
            ...declarationEvidence.candidateFormation,
            provisionalCandidate: declarationEvidence.candidateFormation.provisionalCandidate
              ? { ...declarationEvidence.candidateFormation.provisionalCandidate }
              : null,
            gates: { ...declarationEvidence.candidateFormation.gates },
          },
          raw: { ...declarationEvidence.raw },
        }
      }
    }

    // A completed return is consumed exactly once. The controller can react to
    // the tagged scalar in this step, but it never sees the private footprint.
    if (this.measurement.sampleMode === 'active-return') this.activeSniffEvent = null
    if (
      this.measurement.sampleMode === 'quad-return' ||
      this.measurement.sampleMode === 'quad-passive-return'
    ) this.quadSniffEvent = null

    if (this.decision.nativeTerminated && this.decision.nativeAbstained) {
      throw new Error('A controller cannot declare a source and abstain in the same step')
    }

    if (
      this.decision.nativeTerminated &&
      !this.firstDeclarationRecorded &&
      !this.firstAbstentionRecorded
    ) {
      this.firstDeclarationRecorded = true
      const declarationError = this.scenario.source
        ? this.decision.estimate
          ? distance(this.decision.estimate, this.scenario.source)
          : Math.SQRT2
        : null
      this.declarationTimeSeconds = this.time
      this.declarationErrorNormalized = declarationError
      if (declarationError === null || declarationError > this.config.successThreshold) {
        this.falseDeclarations += 1
      }
      if (this.config.stopOnNativeDeclaration) {
        this.completed = true
        this.running = false
        this.completionReason = this.decision.terminationReason ?? 'Native source declaration'
      } else {
        // Fixed-budget research checkpoints carry the declared estimate
        // forward. No controller is allowed to keep moving or assimilating
        // after declaring, which gives every method the same semantics.
        this.frozenAfterTerminalDecision = true
      }
    }

    if (
      this.decision.nativeAbstained &&
      !this.firstDeclarationRecorded &&
      !this.firstAbstentionRecorded
    ) {
      this.firstAbstentionRecorded = true
      this.abstentionTimeSeconds = this.time
      if (this.config.stopOnNativeDeclaration) {
        this.completed = true
        this.running = false
        this.completionReason = this.decision.terminationReason ?? 'Native source abstention'
      } else {
        this.frozenAfterTerminalDecision = true
      }
    }

    let acceptedActiveSampling = false
    if (
      !this.completed &&
      !this.frozenAfterTerminalDecision &&
      this.config.activeSniffEnabled &&
      !this.config.localInletSampling &&
      !this.activeSniffEvent &&
      !this.quadSniffEvent &&
      this.decision.activeSniff &&
      this.decision.activeSniff.probeId !== this.lastActiveProbeId
    ) {
      const event = createActiveSniffEvent({
        command: this.decision.activeSniff,
        origin: this.position,
        time: this.time,
        strengthScale: this.config.activeSniffStrength,
        reach: this.environment.horizontalReachForSurfaceDistance(
          this.decision.activeSniff.direction,
          this.config.activeSniffReach,
        ),
        cycleSeconds: this.config.activeSniffCycleSeconds,
        plume: this.plume,
        isBlocked: this.environment.isBlocked,
      })
      if (event) {
        this.activeSniffEvent = event
        this.displayedActiveSniff = activeSniffFrameAt(event, this.time)
        this.lastActiveProbeId = event.probeId
        this.activeProbeCount += 1
        this.airPulseEnergy += event.strength ** 2 * (event.cycleSeconds / 3)
        acceptedActiveSampling = true
      }
    }

    if (
      !this.completed &&
      !this.frozenAfterTerminalDecision &&
      (this.config.activeSniffEnabled || this.config.algorithmId === 'quad-passive') &&
      !this.activeSniffEvent &&
      !this.quadSniffEvent &&
      this.decision.quadSniff &&
      this.decision.quadSniff.scanId !== this.lastQuadScanId
    ) {
      const event = createQuadSniffEvent({
        command: this.config.localInletSampling ? { ...this.decision.quadSniff,
          forward: { x: Math.cos(this.heading), y: Math.sin(this.heading) } } : this.decision.quadSniff,
        origin: this.position,
        time: this.time,
        strengthScale: this.config.activeSniffStrength,
        samplingMode: this.config.localInletSampling || this.config.algorithmId === 'quad-passive'
          ? 'passive-array'
          : 'active-suction',
        ...(this.config.localInletSampling ? {
          passiveArrayRadius: this.config.localInletSampling.opposingInletSpacingMetres / (2 * this.config.domainMeters),
        } : {}),
        cycleSeconds: this.config.activeSniffCycleSeconds,
        reachForDirection: (direction) =>
          this.environment.horizontalReachForSurfaceDistance(
            direction,
            this.config.activeSniffReach,
          ),
        // Local mode uses this event only as a public dwell clock. No remote or
        // unfiltered plume query is made while constructing it.
        plume: this.config.localInletSampling
          ? { ...this.plume, concentrationAt: () => 0 } as PlumeModel : this.plume,
        isBlocked: this.config.localInletSampling ? point => this.environment.isBlocked(point, 0) : this.environment.isBlocked,
      })
      if (event) {
        this.quadSniffEvent = event
        this.displayedQuadSniff = quadSniffFrameAt(event, this.time)
        this.lastQuadScanId = event.scanId
        this.quadSniffCycles += 1
        if (event.samplingMode === 'passive-array') this.quadPassiveCycles += 1
        acceptedActiveSampling = true
      }
    }

    if (
      !this.completed &&
      !this.frozenAfterTerminalDecision &&
      this.measurement.sampleMode !== 'blanked' &&
      !acceptedActiveSampling
    ) {
      let requestedDirection = normalize(this.decision.direction, { x: 0, y: 0 })
      const local = this.config.localInletSampling
      if (local && Math.hypot(requestedDirection.x, requestedDirection.y) > 0) {
        const desired = Math.atan2(requestedDirection.y, requestedDirection.x)
        const delta = Math.atan2(Math.sin(desired - this.heading), Math.cos(desired - this.heading))
        const limit = local.maximumTurnRateRadiansPerSecond * this.config.fixedDt
        this.heading += clamp(delta, -limit, limit)
        // Rotate in place until aligned; avoid translating away from a small inspection target.
        requestedDirection = Math.abs(delta) > limit + 1e-9 ? { x: 0, y: 0 }
          : { x: Math.cos(this.heading), y: Math.sin(this.heading) }
      }
      const mobilityScale = terrainMobilityScale(this.scenario, requestedDirection)
      const speed =
        this.config.robotSpeed *
        clamp(this.decision.speedScale ?? 1, 0, local ? 1 : 1.5) *
        mobilityScale
      const displacement = scale(requestedDirection, speed * this.config.fixedDt)
      const proposed = add(this.position, displacement)
      if (this.movementIsBlocked(proposed)) {
        this.collisionAttempts += 1
      } else {
        const travelled = distance(this.position, proposed)
        if (travelled > 0) {
          const surfaceTravelled = terrainSurfaceDistance(
            this.scenario,
            this.position,
            proposed,
          )
          const elevationChange =
            terrainHeightAt(this.scenario, proposed) -
            terrainHeightAt(this.scenario, this.position)
          this.heading = Math.atan2(displacement.y, displacement.x)
          this.position = proposed
          this.distanceTravelled += travelled
          this.surfaceDistanceTravelled += surfaceTravelled
          if (elevationChange >= 0) this.elevationGain += elevationChange
          else this.elevationLoss += -elevationChange
          this.terrainMobilityTotal += mobilityScale
          this.terrainMobilitySamples += 1
          this.path.push({ ...this.position })
        }
      }
    }

    this.advanceClock()
    return this.getFrame()
  }

  private advanceClock() {
    const previousTime = this.time
    const activeEvent = this.activeSniffEvent ?? this.quadSniffEvent
    if (activeEvent) {
      const remainingCycle = Math.max(
        0,
        activeEvent.startedAt + activeEvent.cycleSeconds - this.time,
      )
      const remainingRun = Math.max(0, this.config.durationSeconds - this.time)
      const sampledSeconds = Math.min(
        this.config.fixedDt,
        remainingCycle,
        remainingRun,
      )
      if (
        this.activeSniffEvent ||
        this.quadSniffEvent?.samplingMode === 'active-suction'
      ) {
        this.activeSamplingSeconds += sampledSeconds
      }
      if (this.quadSniffEvent) {
        // Dimensionless actuation-cost proxy. Accruing by elapsed draw time
        // keeps a run that ends mid-cycle from being charged a full cycle.
        this.quadSuctionEnergy +=
          4 * this.quadSniffEvent.strength ** 2 * sampledSeconds
        if (this.quadSniffEvent.samplingMode === 'passive-array') {
          this.quadPassiveSamplingSeconds += sampledSeconds
        }
      }
    }
    this.time = Math.min(this.config.durationSeconds, this.time + this.config.fixedDt)
    for (const checkpoint of this.config.checkpointSeconds) {
      if (previousTime < checkpoint && this.time >= checkpoint && !this.checkpoints[checkpoint]) {
        this.checkpoints[checkpoint] = this.getMetrics(checkpoint)
      }
    }

    if (this.time >= this.config.durationSeconds && !this.completed) {
      this.completed = true
      this.running = false
      this.completionReason = 'Fixed research time budget reached'
    }
  }

  private movementIsBlocked(proposed: Vec2) {
    const travel = distance(this.position, proposed)
    const probes = Math.max(1, Math.ceil(travel / 0.008))
    for (let index = 1; index <= probes; index += 1) {
      const amount = index / probes
      const point = {
        x: this.position.x + (proposed.x - this.position.x) * amount,
        y: this.position.y + (proposed.y - this.position.y) * amount,
      }
      if (this.environment.isBlocked(point)) return true
    }
    return false
  }

  runToCompletion() {
    while (!this.completed) this.step()
    return this.getFrame()
  }

  getMetrics(elapsedOverride?: number): MetricSnapshot {
    const estimate = this.decision.estimate
    const source = this.scenario.source
    const elapsedSeconds = elapsedOverride ?? this.time
    // A missing estimate in a source-present trial is conservatively scored as
    // the maximum possible unit-square error. In a true no-target trial,
    // localization error and source-referenced path overhead are not defined.
    const normalizedError = source
      ? estimate
        ? distance(estimate, source)
        : Math.SQRT2
      : null
    const surfaceError = source
      ? estimate
        ? terrainSurfaceDistance(this.scenario, estimate, source)
        : Math.max(
            ...[
              { x: 0, y: 0 },
              { x: 0, y: 1 },
              { x: 1, y: 0 },
              { x: 1, y: 1 },
            ].map((corner) => terrainSurfaceDistance(
              this.scenario,
              source,
              corner,
            )),
          )
      : null
    const pathOverhead = this.initialSourceDistance === null
      ? null
      : this.distanceTravelled / Math.max(1e-6, this.initialSourceDistance)
    const surfacePathOverhead = this.initialSurfaceSourceDistance === null
      ? null
      : this.surfaceDistanceTravelled / Math.max(1e-6, this.initialSurfaceSourceDistance)
    const atDeadline = elapsedSeconds >= this.config.durationSeconds - 1e-9
    const terminalOutcome: MetricSnapshot['terminalOutcome'] = this.firstDeclarationRecorded
      ? source === null
        ? 'spurious-declaration'
        : this.declarationErrorNormalized !== null &&
            this.declarationErrorNormalized <= this.config.successThreshold
          ? 'correct-declaration'
          : 'wrong-declaration'
      : this.firstAbstentionRecorded
        ? source === null
          ? 'correct-abstention'
          : 'missed-source-abstention'
        : atDeadline
          ? source === null
            ? 'correct-rejection-at-deadline'
            : 'deadline-nondeclaration-present'
          : 'pending'
    const absentTrialResolved = source === null && (
      this.firstDeclarationRecorded || this.firstAbstentionRecorded || atDeadline
    )
    return {
      elapsedSeconds,
      ...(this.config.localInletSampling ? {
        localSamplingAirLitres: 4 * this.config.localInletSampling.flowLitresPerMinutePerChannel / 60 *
          (this.declarationTimeSeconds ?? this.abstentionTimeSeconds ?? elapsedSeconds),
      } : {}),
      targetStatus: this.scenario.targetStatus,
      terminalOutcome,
      normalizedError,
      errorMeters: normalizedError === null
        ? null
        : normalizedError * this.config.domainMeters,
      surfaceErrorNormalized: surfaceError,
      surfaceErrorMeters: surfaceError === null
        ? null
        : surfaceError * this.config.domainMeters,
      success: normalizedError === null
        ? null
        : normalizedError <= this.config.successThreshold,
      pathLengthNormalized: this.distanceTravelled,
      pathLengthMeters: this.distanceTravelled * this.config.domainMeters,
      normalizedPathOverhead: pathOverhead,
      surfacePathLengthNormalized: this.surfaceDistanceTravelled,
      surfacePathLengthMeters: this.surfaceDistanceTravelled * this.config.domainMeters,
      surfacePathOverhead,
      elevationGainMeters: this.elevationGain * this.config.domainMeters,
      elevationLossMeters: this.elevationLoss * this.config.domainMeters,
      meanTerrainMobilityScale:
        this.terrainMobilitySamples > 0
          ? this.terrainMobilityTotal / this.terrainMobilitySamples
          : 1,
      samples: this.observations.length,
      passiveSamples: this.passiveSamples,
      activeReturnSamples: this.activeReturnSamples,
      hitCount: this.hitCount,
      activeReturnHits: this.activeReturnHits,
      contactEpisodes: this.contactEpisodes,
      plumeTimeSeconds: this.plumeTime,
      reacquisitions: this.reacquisitions,
      nativeDeclaration: this.firstDeclarationRecorded,
      declarationTimeSeconds: this.declarationTimeSeconds,
      declarationErrorNormalized: this.declarationErrorNormalized,
      falseDeclarations: this.falseDeclarations,
      spuriousDeclaration: source === null && this.firstDeclarationRecorded,
      nativeAbstention: this.firstAbstentionRecorded,
      abstentionTimeSeconds: this.abstentionTimeSeconds,
      correctRejection: absentTrialResolved
        ? !this.firstDeclarationRecorded
        : null,
      correctAbstention: source === null && this.firstAbstentionRecorded,
      collisionAttempts: this.collisionAttempts,
      activeProbeCount: this.activeProbeCount,
      quadSniffCycles: this.quadSniffCycles,
      quadChannelReturns: this.quadChannelReturns,
      quadPassiveCycles: this.quadPassiveCycles,
      quadPassiveChannelReturns: this.quadPassiveChannelReturns,
      quadPassiveSamplingSeconds: this.quadPassiveSamplingSeconds,
      quadSuctionEnergy: this.quadSuctionEnergy,
      meanQuadContrast:
        this.quadContrastTotal / Math.max(1, this.quadContrastSamples),
      quadValidDirections: this.quadValidDirections,
      quadDirectionAbstentions: this.quadDirectionAbstentions,
      quadSaturatedChannels: this.quadSaturatedChannels,
      meanQuadSupport:
        this.quadSupportTotal / Math.max(1, this.quadReturnCycles),
      meanQuadIntegrationSamples:
        this.quadIntegrationSamplesTotal / Math.max(1, this.quadReturnCycles),
      meanQuadEffectiveSamples:
        this.quadEffectiveSamplesTotal / Math.max(1, this.quadReturnCycles),
      quadDeclarationEvaluations: this.quadDeclarationEvaluations,
      quadDeclarationCandidateEvaluations: this.quadDeclarationCandidateEvaluations,
      quadDeclarationMaxScore: this.quadDeclarationMaxScore,
      quadDeclarationMaxGatesPassed: this.quadDeclarationMaxGatesPassed,
      quadDeclarationBestEvidence: this.quadDeclarationBestEvidence
        ? {
            ...this.quadDeclarationBestEvidence,
            candidate: this.quadDeclarationBestEvidence.candidate
              ? { ...this.quadDeclarationBestEvidence.candidate }
              : null,
            gates: { ...this.quadDeclarationBestEvidence.gates },
            candidateFormation: {
              ...this.quadDeclarationBestEvidence.candidateFormation,
              provisionalCandidate: this.quadDeclarationBestEvidence.candidateFormation.provisionalCandidate
                ? { ...this.quadDeclarationBestEvidence.candidateFormation.provisionalCandidate }
                : null,
              gates: { ...this.quadDeclarationBestEvidence.candidateFormation.gates },
            },
            raw: { ...this.quadDeclarationBestEvidence.raw },
          }
        : null,
      quadDeclarationGatePasses: { ...this.quadDeclarationGatePasses },
      quadCandidateFormationEvaluations: this.quadCandidateFormationEvaluations,
      quadCandidateProvisionalRayEvaluations: this.quadCandidateProvisionalRayEvaluations,
      quadCandidateMaxGradientRayPoolCount: this.quadCandidateMaxGradientRayPoolCount,
      quadCandidateMaxProvisionalRayCount: this.quadCandidateMaxProvisionalRayCount,
      quadCandidateMaxQuality: this.quadCandidateMaxQuality,
      quadCandidateMinResidual: this.quadCandidateMinResidual,
      quadCandidateMaxSurfaceSupport: this.quadCandidateMaxSurfaceSupport,
      quadCandidateBestFormation: this.quadCandidateBestFormation
        ? {
            ...this.quadCandidateBestFormation,
            provisionalCandidate: this.quadCandidateBestFormation.provisionalCandidate
              ? { ...this.quadCandidateBestFormation.provisionalCandidate }
              : null,
            gates: { ...this.quadCandidateBestFormation.gates },
          }
        : null,
      quadCandidateGatePasses: { ...this.quadCandidateGatePasses },
      activeSamplingSeconds: this.activeSamplingSeconds,
      airPulseEnergy: this.airPulseEnergy,
      meanComputeMs:
        this.computeTimes.reduce((sum, duration) => sum + duration, 0) /
        Math.max(1, this.computeTimes.length),
      p95ComputeMs: percentile(this.computeTimes, 0.95),
      estimate: estimate ? { ...estimate } : null,
    }
  }

  getFrame(): SimulationFrame {
    return {
      config: this.config,
      scenario: this.scenario,
      time: this.time,
      running: this.running,
      completed: this.completed,
      completionReason: this.completionReason,
      activeSniff: this.activeSniffEvent
        ? activeSniffFrameAt(this.activeSniffEvent, this.time)
        : this.displayedActiveSniff,
      quadSniff: this.quadSniffEvent
        ? quadSniffFrameAt(
            this.quadSniffEvent,
            this.completed && this.measurement.sampleMode === 'blanked'
              ? Math.min(
                  this.time,
                  this.quadSniffEvent.startedAt +
                    this.quadSniffEvent.cycleSeconds - 1e-9,
                )
              : this.time,
          )
        : this.displayedQuadSniff,
      robot: {
        position: { ...this.position },
        heading: this.heading,
        path: this.path,
      },
      measurement: this.measurement,
      observations: this.observations,
      decision: this.decision,
      metrics: this.getMetrics(),
      checkpoints: this.checkpoints,
    }
  }
}
