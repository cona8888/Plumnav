export type Vec2 = { x: number; y: number }

/** Constant-wind, reflecting-ground, dilute Gaussian release reference.
 * All rates are actual SI quantities. This is not soil flux or suction CFD.
 */
export type PhysicalAtmosphereConfig = {
  version: 'halfspace-si-v1'
  diffusivityMetresSquaredPerSecond: number
  sourceWidthMetres: number
  releaseHeightMetres: number
  emissionRateKgPerSecond: number
  sourceAgeAtMissionStartSeconds: number
  quadraturePanelSeconds: number
  /** Switching has 50% duty; phase uses time since source initiation. */
  pulse?: { periodSeconds: number; phaseSeconds: number; dutyFraction: 0.5 }
  measurement: {
    concentrationScaleKgPerCubicMetre: number
    backgroundKgPerCubicMetre: number
    noiseKgPerCubicMetre: number
    thresholdKgPerCubicMetre: number
    saturationKgPerCubicMetre: number
    /** Explicit ideal-gas methane bridge for metadata; not calibration. */
    temperatureKelvin: number
    pressurePascal: number
  }
}

export type InspectionContract = {
  version: 'settled-spatial-confirmation-v1'
  offsetNormalized: number
  zoneRadiusNormalized: number
  arrivalRadiusNormalized: number
  settlingSeconds: number
  dwellSeconds: number
  sampleSpacingSeconds: number
  maximumPairSeparationSeconds: number
  minimumSamplesPerWaypoint: number
}

export type LocalInletSamplingConfig = {
  /** SI diffusivity, independently of site size. Omitted by frozen legacy runs. */
  effectiveDiffusivityMetresSquaredPerSecond?: number
  localMaximumPolicy?: 'fresh-cross-v1'
  localMaximumNomination?: 'persistent-turn-v1'
  localMaximumRecentering?: 'higher-flank-v1'
  /** Acquisition-only experiment: gradients guide local moves, never source rays. */
  localGradientPolicy?: 'head-step-v1'
  /** Acquisition may replace expiring rays; actual evidence lifetime is unchanged. */
  rayWindowPolicy?: 'rolling-expiry-v1'
  /** Research-only one-component removal; absent from the M78 reference. */
  bearingAblation?: 'legacy-spacing' | 'wind-bearing' | 'legacy-geometry' | 'no-radius-gate'
  bearingGeometry?: 'linearized-local-bearing-v1'
  acquisitionPolicy?: 'time-budgeted-viewpoints-v1'
  candidateLifecycle?: 'bounded-inspection-v1'
  /** Opt-in, numerically scale-invariant geometry solve; omitted by M73/M74. */
  gradientEstimator?: 'relative-geometry-v1'
  /** Optional acquisition-only policy; omitted in the M73 physical commissioning archive. */
  scanPolicy?: LocalScanPolicy
  version: 'local-inlet-v1'
  fieldInterpretation: 'prescribed-horizontal-slice'
  opposingInletSpacingMetres: number
  /** Slice label only: the 2-D plume does not predict variation with height. */
  inletHeightMetres: number
  robotLengthMetres: number
  robotWidthMetres: number
  referenceWindMetresPerSecond: number
  tubeLengthMetres: number
  tubeInnerDiameterMetres: number
  /** Actual flow PER CHANNEL; no standard-to-actual conversion is assumed. */
  flowLitresPerMinutePerChannel: number
  riseTimeConstantSeconds: number
  recoveryTimeConstantSeconds: number
  averagingSeconds: number
  sampleIntervalSeconds: number
  maximumTurnRateRadiansPerSecond: number
  inspection: InspectionContract
}

export type LocalScanPolicy = {
  version: 'bounded-pose-scans-v1'
  maximumCompletedScansPerPose: number
  relocationDistanceNormalized: number
  arrivalRadiusNormalized: number
  maximumRelocationSeconds: number
}

export type AlgorithmId =
  | 'coverage'
  | 'surge-cast'
  | 'zigzag-spiral'
  | 'infotaxis'
  | 'smc-kl'
  | 'pmfs'
  | 'pulse-sniff'
  | 'quad-sniff'
  | 'quad-sniff-wind'
  | 'quad-sniff-range'
  | 'quad-sniff-corridor'
  | 'quad-sniff-bracket'
  | 'quad-sniff-refine'
  | 'quad-sniff-confirmation'
  | 'quad-sniff-adaptive'
  | 'quad-sniff-staged'
  | 'quad-sniff-legacy'
  | 'quad-passive'

export type ScenarioKind = 'open' | 'obstructed'

export type PhysicsMode = 'filament' | 'grid'

export type GasBuoyancy = 'neutral' | 'dense' | 'light'

/** Ground-truth target condition. This field is never exposed to controllers. */
export type TargetStatus = 'emitting' | 'zero-emission' | 'absent'

export type TerminalOutcome =
  | 'pending'
  | 'correct-declaration'
  | 'wrong-declaration'
  | 'spurious-declaration'
  | 'correct-abstention'
  | 'missed-source-abstention'
  | 'correct-rejection-at-deadline'
  | 'deadline-nondeclaration-present'

export type Obstacle = {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export type Scenario = {
  kind: ScenarioKind
  name: string
  shortName: string
  description: string
  /** Private target coordinate; null only for a true target-absent trial. */
  source: Vec2 | null
  /** Private truth label; excluded from AlgorithmEnvironment. */
  targetStatus: TargetStatus
  robotStart: Vec2
  baseWind: Vec2
  turbulence: number
  gustStrength: number
  diffusivity: number
  /** Dimensionless multiplier of source mass emitted per unit time. */
  emissionRateScale: number
  /** 0 for no geometry; 1-5 for recursive process-floor geometry. */
  obstacleComplexityLevel: number
  /** Planar terrain inclination represented as a 2.5D height gradient. */
  terrainSlopeDegrees: number
  /** Compass direction toward increasing elevation; 0° north, clockwise. */
  terrainUphillDirectionDegrees: number
  /** Reduced-order near-surface gas response relative to ambient air. */
  gasBuoyancy: GasBuoyancy
  /** Dimensionless multiplier for slope-driven gas transport. */
  terrainGasDriftScale: number
  /** Reference grade at which the robot mobility proxy becomes strongly limited. */
  robotSlopeLimitDegrees: number
  /** Scenario baseline used to preserve emitted puff mass as diffusivity changes. */
  referenceDiffusivity: number
  intermittency: number
  obstacles: Obstacle[]
}

export type SimulationConfig = {
  /** Opt-in SI research field; overrides the legacy display plume selection. */
  physicalAtmosphere?: PhysicalAtmosphereConfig
  /** Omit to retain the legacy sensing and confirmation implementation. */
  localInletSampling?: LocalInletSamplingConfig
  algorithmId: AlgorithmId
  scenarioKind: ScenarioKind
  /** Private world/layout seed; never exposed to an algorithm controller. */
  seed: number
  /** Independent private seed used only for hidden source placement. */
  sourceSeed: number
  /** Independent seed for controller-side exploration and particle sampling. */
  controllerSeed: number
  /** Independent seed for the controller's declared observation/likelihood model. */
  observationModelSeed: number
  /** Emitting target, present but non-emitting target, or true no-target trial. */
  targetStatus: TargetStatus
  /**
   * Optional private ground-truth placement used by frozen research manifests.
   * It is consumed by the world builder and is never included in
   * AlgorithmEnvironment.
   */
  sourcePositionOverride?: Vec2
  /** Optional prescribed robot start used to remove the legacy left/right prior. */
  robotStartPositionOverride?: Vec2
  /** Initial plan heading: 0° points along +x and 90° along +y. */
  robotStartHeadingDegrees?: number
  domainMeters: number
  durationSeconds: number
  checkpointSeconds: number[]
  /** Physics solver timestep; independent of controller/sensor/motion cadence. */
  physicsStepSeconds?: number
  fixedDt: number
  robotSpeed: number
  /** Commercially anchored response preset; custom preserves the dimensionless controls. */
  sensorProfileId: SensorProfileId
  /** Declared bridge from the dimensionless plume field to a notional methane concentration. */
  sensorPpmPerNormalizedUnit: number
  /** Absolute normalized detection floor; zero delegates to the legacy scenario threshold. */
  sensorDetectionFloor: number
  sensorNoise: number
  sensorLag: number
  windNoise: number
  sensorThresholdScale: number
  sensorSaturation: number
  sensorFalsePositiveRate: number
  sensorFalseNegativeRate: number
  /**
   * Quad-return white-noise shared fraction in [0, 1]. This is a robustness
   * proxy, not a calibrated pump-noise model; 1 makes all channel noise equal.
   */
  quadChannelNoiseCorrelation: number
  /** Deterministic maximum fractional channel gain deviation for Quad returns. */
  quadChannelGainMismatch: number
  /** Fraction of gain-adjusted Quad signal mixed with the four-channel mean. */
  quadChannelCrossTalk: number
  /** Deterministic maximum fractional sensor-lag deviation for Quad returns. */
  quadChannelLagMismatch: number
  activeSniffEnabled: boolean
  activeSniffStrength: number
  activeSniffReach: number
  activeSniffCycleSeconds: number
  physicsMode: PhysicsMode
  gridResolution: number
  /** Compass direction the mean wind travels toward; 0° north, clockwise. */
  windDirectionDegrees: number
  windSpeedScale: number
  turbulenceScale: number
  gustStrength: number
  diffusivityScale: number
  /** Dimensionless multiplier of source mass emitted per unit time. */
  emissionRateScale: number
  /** Recursive process-floor geometry level in [0, 5]. */
  obstacleComplexityLevel: number
  /** Planar 2.5D terrain controls. */
  terrainSlopeDegrees: number
  terrainUphillDirectionDegrees: number
  gasBuoyancy: GasBuoyancy
  terrainGasDriftScale: number
  robotSlopeLimitDegrees: number
  successThreshold: number
  stopOnNativeDeclaration: boolean
}

export type SensorProfileId =
  | 'normalized-reference'
  | 'custom'
  | 'mps-mems'
  | 'mems-mos-tgs8410'
  | 'budget-mq4'
  | 'ndir-platinum'
  | 'tdlas-extractive'
  | 'crds-g2401'

export type SampleMode =
  | 'passive'
  | 'blanked'
  | 'active-return'
  | 'quad-return'
  | 'quad-passive-return'

export type ActiveSniffPhase = 'exhale' | 'settle' | 'return'

export type ActiveSniffCommand = {
  probeId: number
  direction: Vec2
  strength?: number
}

export type ActiveSniffStatus = {
  probeId: number
  phase: ActiveSniffPhase
  direction: Vec2
  strength: number
  progress: number
}

export type ActiveSniffFrame = ActiveSniffStatus & {
  origin: Vec2
  reach: number
  startedAt: number
}

export type QuadSniffChannelId = 'front' | 'left' | 'aft' | 'right'

export type QuadSniffPhase = 'aspirate' | 'return'

export type QuadSamplingMode = 'active-suction' | 'passive-array'

export type QuadSniffCommand = {
  scanId: number
  /** Body-forward bearing in world/plan coordinates. */
  forward: Vec2
  strength?: number
}

/** Public geometry for one inlet; it deliberately contains no plume value. */
export type QuadSniffChannelGeometry = {
  channel: QuadSniffChannelId
  direction: Vec2
  /** Terrain-correct plan projection of the requested surface reach. */
  reach: number
  /** Weighted fraction of the nominal kernel retained after obstacle clipping. */
  support: number
  /** Effective retained-kernel centroid relative to the robot, in plan coordinates. */
  effectiveOffset: Vec2
}

/** Sensor-processed return. Raw/latent plume values never use this public type. */
export type QuadSniffChannelReading = QuadSniffChannelGeometry & {
  concentration: number
  hit: boolean
  /** Number of time-aligned aspiration samples averaged before this return. */
  integrationSamples: number
  /** White-noise-equivalent sample count after duration weighting. */
  effectiveIntegrationSamples: number
  /** True when the processed channel reached the configured sensor ceiling. */
  saturated?: boolean
}

export type QuadSniffStatus = {
  scanId: number
  phase: QuadSniffPhase
  forward: Vec2
  strength: number
  /** Distinguishes pump-driven capture from four spatially separated passive heads. */
  samplingMode: QuadSamplingMode
  progress: number
  channels: QuadSniffChannelGeometry[]
  /** Present only after the engine has applied sensor dynamics and noise. */
  readings?: QuadSniffChannelReading[]
}

export type QuadSniffFrame = QuadSniffStatus & {
  origin: Vec2
  startedAt: number
  cycleSeconds: number
}

export type QuadDeclarationGateName =
  | 'candidate'
  | 'stability-count'
  | 'stability-span'
  | 'stability-radius'
  | 'surface-count'
  | 'surface-score'
  | 'passive-core-count'
  | 'passive-core-hits'
  | 'passive-ring-count'
  | 'passive-core-mean'
  | 'passive-contrast'
  | 'recent-passive-hit'
  | 'candidate-distance'
  | 'aggregate-score'

export type QuadCandidateFormationGateName =
  | 'provisional-ray'
  | 'ray-count'
  | 'ray-quality'
  | 'ray-residual'
  | 'surface-support'

/** Uncensored controller-visible state immediately before trusted-candidate gating. */
export type QuadCandidateFormationStatus = {
  provisionalCandidate: Vec2 | null
  gradientRayPoolCount: number
  provisionalRayCount: number | null
  provisionalRayQuality: number | null
  provisionalRayResidual: number | null
  surfaceSupportCount: number
  trustedCandidate: boolean
  gatesPassed: number
  gates: Record<QuadCandidateFormationGateName, boolean>
}

/** Truth-blind declaration state emitted only when a new Quad return is consumed. */
export type QuadDeclarationEvidenceStatus = {
  ready: boolean
  candidate: Vec2 | null
  score: number
  rayScore: number
  stabilityScore: number
  surfaceScore: number
  passiveScore: number
  gatesPassed: number
  gates: Record<QuadDeclarationGateName, boolean>
  /** Recorded even when the trusted candidate is rejected. */
  candidateFormation: QuadCandidateFormationStatus
  raw: {
    rayQuality: number
    rayResidual: number
    stabilityCount: number
    stabilitySpan: number
    stabilityRadius: number
    surfaceCount: number
    surfaceMeanScore: number
    passiveCoreCount: number
    passiveCoreHits: number
    passiveRingCount: number
    passiveCoreMean: number
    passiveContrast: number
    secondsSincePassiveHit: number | null
    distanceToCandidate: number | null
  }
}

export type Measurement = {
  /** SI research telemetry: a mean below saturation can hide a clipped inlet. */
  localInletReadings?: Array<Pick<QuadSniffChannelReading, 'channel' | 'concentration' | 'saturated' | 'effectiveOffset'>>
  time: number
  concentration: number
  hit: boolean
  wind: Vec2
  valid: boolean
  sampleMode: SampleMode
  activeSniff?: ActiveSniffStatus
  quadSniff?: QuadSniffStatus
}

export type Observation = Measurement & {
  position: Vec2
}

export type WeightedPoint = Vec2 & {
  weight: number
  strength?: number
}

export type DebugGrid = {
  width: number
  height: number
  values: number[]
  label: string
  palette: 'belief' | 'information' | 'hit-map'
}

export type AlgorithmDebug = {
  target?: Vec2
  grid?: DebugGrid
  particles?: WeightedPoint[]
  candidates?: Vec2[]
  note?: string
}

export type AlgorithmDecision = {
  direction: Vec2
  speedScale?: number
  estimate: Vec2 | null
  confidence: number
  phase: string
  nativeTerminated?: boolean
  /** Explicit no-source decision; distinct from merely reaching the deadline. */
  nativeAbstained?: boolean
  terminationReason?: string
  activeSniff?: ActiveSniffCommand
  quadSniff?: QuadSniffCommand
  /** Diagnostic telemetry derived only from controller-visible measurements. */
  quadDeclarationEvidence?: QuadDeclarationEvidenceStatus
  /** Audit trail for the M65+ local centre/cardinal confirmation experiment. */
  quadBracketEvidence?: QuadBracketEvidenceStatus
  debug?: AlgorithmDebug
}

export type QuadBracketGateName =
  | 'confirmation-completed'
  | 'accessible-flank-directions'
  | 'core-samples'
  | 'sampled-flank-directions'
  | 'core-hits'
  | 'directional-wins'
  | 'paired-samples'
  | 'paired-win-fraction'
  | 'ray-quality'
  | 'ray-residual'
  | 'stability-count'
  | 'stability-span'
  | 'stability-radius'
  | 'candidate-distance'

export type QuadBracketEvidenceStatus = {
  candidate: Vec2
  startedAt: number
  completedAt: number | null
  accessibleFlankDirections: number
  coreCount: number
  coreHits: number
  flankCounts: [number, number, number, number]
  sampledFlankDirections: number
  directionalWins: number
  pairCount: number
  pairedWinFraction: number
  coreMedian: number
  flankMedians: [number, number, number, number]
  rayQuality: number
  rayResidual: number
  stabilityCount: number
  stabilitySpan: number
  stabilityRadius: number
  candidateDistance: number
  gates: Record<QuadBracketGateName, boolean>
  gatesPassed: number
  ready: boolean
}

export type AlgorithmMetadata = {
  id: AlgorithmId
  index: string
  name: string
  shortName: string
  family: string
  color: string
  summary: string
  principle: string
  sensors: string[]
  assumptions: string[]
  strengths: string[]
  limitations: string[]
  citationLabel: string
  citationUrl: string
}

export type AlgorithmEnvironment = {
  localMaximum?: {version:'fresh-cross-v1';sensorSaturation:number;
    nomination?:LocalInletSamplingConfig['localMaximumNomination'];recentering?:LocalInletSamplingConfig['localMaximumRecentering']}
  localGradientPolicy?: LocalInletSamplingConfig['localGradientPolicy']
  rayWindowPolicy?: LocalInletSamplingConfig['rayWindowPolicy']
  bearingAblation?: LocalInletSamplingConfig['bearingAblation']
  bearingGeometry?: 'linearized-local-bearing-v1'
  acquisitionPolicy?: 'time-budgeted-viewpoints-v1'
  candidateLifecycle?: { version: 'bounded-inspection-v1'; maximumTurnRateRadiansPerSecond: number }
  gradientEstimator?: 'relative-geometry-v1'
  localScanPolicy?: LocalScanPolicy
  /** Public inspection limits only; no source or detectability truth. */
  inspectionContract?: InspectionContract
  /** Public scenario; source coordinate and target-presence truth are excluded. */
  scenario: Omit<Scenario, 'source' | 'targetStatus'>
  /** Controller-only randomness, deliberately independent of the private world seed. */
  controllerSeed: number
  /** Version and independent seed of the controller-side prediction model. */
  observationModelVersion: string
  observationModelSeed: number
  maxSpeed: number
  /** Public fixed mission budget, used only for evidence-based terminal timing. */
  durationSeconds: number
  /** Public actuator timing/range settings; these contain no plume truth. */
  activeSniffEnabled: boolean
  activeSniffCycleSeconds: number
  activeSniffReach: number
  /** Public calibrated per-sample concentration-noise standard deviation. */
  sensorNoise: number
  isBlocked: (point: Vec2, clearance?: number) => boolean
  windAt: (point: Vec2, time: number) => Vec2
  /** Dimensionless Poisson encounter rate per sensor sample; p(hit) = 1 - exp(-rate). */
  expectedHitRate: (candidateSource: Vec2, samplePoint: Vec2, time: number) => number
  safeDirection: (from: Vec2, desired: Vec2) => Vec2
  /** Direction-dependent horizontal speed multiplier on the sloped surface. */
  terrainMobilityScale: (direction: Vec2) => number
  /** Plan projection of a commanded straight axial distance along the surface. */
  horizontalReachForSurfaceDistance: (direction: Vec2, surfaceDistance: number) => number
}

export type AlgorithmStepInput = {
  time: number
  dt: number
  position: Vec2
  heading: number
  measurement: Measurement
  observations: readonly Observation[]
  distance: number
}

export interface AlgorithmController {
  readonly metadata: AlgorithmMetadata
  reset(environment: AlgorithmEnvironment): void
  step(input: AlgorithmStepInput): AlgorithmDecision
}

export type MetricSnapshot = {
  /** Only local-inlet mode: continuous actual flow through four channels. */
  localSamplingAirLitres?: number
  elapsedSeconds: number
  targetStatus: TargetStatus
  terminalOutcome: TerminalOutcome
  normalizedError: number | null
  errorMeters: number | null
  surfaceErrorNormalized: number | null
  surfaceErrorMeters: number | null
  /** Current estimate lies within tolerance; this is not terminal-declaration success. */
  success: boolean | null
  pathLengthNormalized: number
  pathLengthMeters: number
  normalizedPathOverhead: number | null
  surfacePathLengthNormalized: number
  surfacePathLengthMeters: number
  surfacePathOverhead: number | null
  elevationGainMeters: number
  elevationLossMeters: number
  meanTerrainMobilityScale: number
  samples: number
  passiveSamples: number
  activeReturnSamples: number
  hitCount: number
  activeReturnHits: number
  contactEpisodes: number
  plumeTimeSeconds: number
  reacquisitions: number
  nativeDeclaration: boolean
  declarationTimeSeconds: number | null
  declarationErrorNormalized: number | null
  falseDeclarations: number
  spuriousDeclaration: boolean
  nativeAbstention: boolean
  abstentionTimeSeconds: number | null
  /** Available once a target-absent trial reaches a terminal decision or its fixed deadline. */
  correctRejection: boolean | null
  /** True only when a controller explicitly abstains in a target-absent trial. */
  correctAbstention: boolean
  collisionAttempts: number
  activeProbeCount: number
  activeSamplingSeconds: number
  airPulseEnergy: number
  quadSniffCycles: number
  quadChannelReturns: number
  quadPassiveCycles: number
  quadPassiveChannelReturns: number
  quadPassiveSamplingSeconds: number
  quadSuctionEnergy: number
  meanQuadContrast: number
  quadValidDirections: number
  quadDirectionAbstentions: number
  quadSaturatedChannels: number
  meanQuadSupport: number
  meanQuadIntegrationSamples: number
  meanQuadEffectiveSamples: number
  quadDeclarationEvaluations: number
  quadDeclarationCandidateEvaluations: number
  quadDeclarationMaxScore: number
  quadDeclarationMaxGatesPassed: number
  quadDeclarationBestEvidence: QuadDeclarationEvidenceStatus | null
  quadDeclarationGatePasses: Record<QuadDeclarationGateName, number>
  quadCandidateFormationEvaluations: number
  quadCandidateProvisionalRayEvaluations: number
  quadCandidateMaxGradientRayPoolCount: number
  quadCandidateMaxProvisionalRayCount: number
  quadCandidateMaxQuality: number
  quadCandidateMinResidual: number | null
  quadCandidateMaxSurfaceSupport: number
  quadCandidateBestFormation: QuadCandidateFormationStatus | null
  quadCandidateGatePasses: Record<QuadCandidateFormationGateName, number>
  meanComputeMs: number
  p95ComputeMs: number
  estimate: Vec2 | null
}

export type SimulationFrame = {
  config: SimulationConfig
  scenario: Scenario
  time: number
  running: boolean
  completed: boolean
  completionReason: string | null
  activeSniff: ActiveSniffFrame | null
  quadSniff: QuadSniffFrame | null
  robot: {
    position: Vec2
    heading: number
    path: Vec2[]
  }
  measurement: Measurement
  observations: readonly Observation[]
  decision: AlgorithmDecision
  metrics: MetricSnapshot
  checkpoints: Record<number, MetricSnapshot>
}

export type BatchResult = {
  algorithmId: AlgorithmId
  scenarioKind: ScenarioKind
  seed: number
  checkpointSeconds: number
  /** Immutable per-run configuration snapshot used for reproducible export. */
  config: SimulationConfig
  /** Controller-side model provenance; never inferred from the truth plume. */
  observationModelVersion: string
  observationModelSeed: number
  metrics: MetricSnapshot
  /** Effective capped grid solver timestep; null for the filament model. */
  effectivePhysicsStepSeconds?: number | null
}

export type BatchSummary = {
  algorithmId: AlgorithmId
  scenarioKind: ScenarioKind
  targetStatus: TargetStatus
  /** 0 for open flow or the clear process-flow control; 1-5 for geometry. */
  obstacleComplexityLevel: number
  terrainSlopeDegrees: number
  terrainUphillDirectionDegrees: number
  gasBuoyancy: GasBuoyancy
  terrainGasDriftScale: number
  robotSlopeLimitDegrees: number
  runs: number
  checkpointSeconds: number
  medianNormalizedError: number | null
  p90NormalizedError: number | null
  successRate: number | null
  medianTimeSeconds: number
  medianPathOverhead: number | null
  medianSurfacePathOverhead: number | null
  medianTerrainMobilityScale: number
  medianElevationGainMeters: number
  medianComputeMs: number
  medianPlumeContacts: number
  medianActiveProbes: number
  medianPulseEnergy: number
  medianQuadSniffCycles: number
  medianQuadSuctionEnergy: number
  medianQuadContrast: number
  medianQuadValidDirectionRate: number
  medianQuadSupport: number
  medianQuadIntegrationSamples: number
  medianQuadEffectiveSamples: number
  declarationRate: number
  correctDeclarationRate: number
  falseDeclarationRate: number
  spuriousDeclarationRate: number
  correctRejectionRate: number | null
  correctAbstentionRate: number | null
}
