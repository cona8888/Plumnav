import { describe, expect, it } from 'vitest'
import {
  createCoverageController,
  createSurgeCastController,
  createZigzagSpiralController,
  SurgeCastController,
  ZigzagSpiralController,
} from '../src/sim/algorithms/reactive'
import type {
  AlgorithmController,
  AlgorithmDecision,
  AlgorithmEnvironment,
  AlgorithmStepInput,
  Measurement,
  Obstacle,
  Observation,
  Vec2,
} from '../src/sim/types'
import {
  BASELINE_REPLAY_DIAGNOSTIC_SCHEMA_VERSION,
  readSurgeCastDiagnostic,
  readZigzagSpiralDiagnostic,
  type SurgeCastDiagnosticState,
} from './baseline-replay-diagnostics'
import {
  ReplayFixtureRecorder,
  canonicalReplayJsonValue,
  stableReplayJson,
  type ReplayAccessLevel,
  type ReplayEnvironmentFunctionContracts,
} from './baseline-replay-capture'

/**
 * Executable development-behaviour replays for the three reactive comparators.
 *
 * Passing these fixtures establishes only deterministic behaviour of the local
 * transparent/custom implementations. It is deliberately not an equation-level
 * or canonical-paper equivalence claim.
 */
const REPLAY_SCHEMA_VERSION = 'baseline-reactive-black-box-replay-v1' as const
const DOMAIN: readonly [number, number, number, number] = [0, 1, 0, 1]
const DEFAULT_START: Vec2 = { x: 0.5, y: 0.5 }
const ZERO: Vec2 = { x: 0, y: 0 }
const CLEARANCE = 0.014
const LOOK_AHEAD = 0.034
const OBSERVATION_MODEL_SEED = 7_001

type StepSpecification = {
  time: number
  dt: number
  position: Vec2
  concentration?: number
  hit?: boolean
  wind?: Vec2
  heading?: number
  valid?: boolean
  sampleMode?: Measurement['sampleMode']
}

type RecordedFrame = {
  input: AlgorithmStepInput
  decision: AlgorithmDecision
}

type ReactiveReplayTrace = {
  schemaVersion: typeof REPLAY_SCHEMA_VERSION
  accessLevel: 'black-box'
  claimBoundary: 'development-behaviour-only'
  environment: {
    domain: typeof DOMAIN
    obstacles: Obstacle[]
    robotStart: Vec2
    robotStartHeading: number
    controllerSeed: number
    observationModelVersion: string
    observationModelSeed: number
  }
  frames: RecordedFrame[]
}

type HarnessOptions = {
  controllerSeed: number
  observationModelSeed: number
  robotStart?: Vec2
  robotStartHeading?: number
  obstacles?: Obstacle[]
  heldOutSource?: Vec2
  expectedHitRate?: AlgorithmEnvironment['expectedHitRate']
  expectedHitRateContract?: ReplayEnvironmentFunctionContracts['expectedHitRate']
}

const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
const scale = (value: Vec2, factor: number): Vec2 => ({
  x: value.x * factor,
  y: value.y * factor,
})
const subtract = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
const magnitude = (value: Vec2) => Math.hypot(value.x, value.y)
const distance = (a: Vec2, b: Vec2) => magnitude(subtract(a, b))
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y
const normalize = (value: Vec2): Vec2 => {
  const norm = magnitude(value)
  return norm > 1e-12 ? scale(value, 1 / norm) : ZERO
}
const rotate = (value: Vec2, angle: number): Vec2 => ({
  x: value.x * Math.cos(angle) - value.y * Math.sin(angle),
  y: value.x * Math.sin(angle) + value.y * Math.cos(angle),
})

const canonicalJson = (value: unknown) => stableReplayJson(value)
const cloneCanonical = <T>(value: T): T => canonicalReplayJsonValue(value) as T

const isInsideObstacle = (point: Vec2, obstacle: Obstacle, clearance: number) =>
  point.x >= obstacle.x - clearance &&
  point.x <= obstacle.x + obstacle.width + clearance &&
  point.y >= obstacle.y - clearance &&
  point.y <= obstacle.y + obstacle.height + clearance

const makeBlockagePredicate = (obstacles: readonly Obstacle[]) =>
  (point: Vec2, clearance = CLEARANCE) =>
    point.x < clearance ||
    point.x > 1 - clearance ||
    point.y < clearance ||
    point.y > 1 - clearance ||
    obstacles.some((obstacle) => isInsideObstacle(point, obstacle, clearance))

const segmentIsClear = (
  from: Vec2,
  direction: Vec2,
  length: number,
  isBlocked: AlgorithmEnvironment['isBlocked'],
) => {
  for (let index = 1; index <= 16; index += 1) {
    const probe = add(from, scale(direction, (length * index) / 16))
    if (isBlocked(probe)) return false
  }
  return true
}

const makeSafeDirection = (
  isBlocked: AlgorithmEnvironment['isBlocked'],
): AlgorithmEnvironment['safeDirection'] => (from, desired) => {
  const preferred = normalize(desired)
  if (magnitude(preferred) <= 1e-12) return ZERO
  const turns = [
    0,
    Math.PI / 6,
    -Math.PI / 6,
    Math.PI / 3,
    -Math.PI / 3,
    Math.PI / 2,
    -Math.PI / 2,
    Math.PI,
  ]
  for (const turn of turns) {
    const candidate = rotate(preferred, turn)
    if (segmentIsClear(from, candidate, LOOK_AHEAD, isBlocked)) return candidate
  }
  return ZERO
}

const expectValidBlackBoxDecision = (decision: AlgorithmDecision) => {
  expect(Number.isFinite(decision.direction.x)).toBe(true)
  expect(Number.isFinite(decision.direction.y)).toBe(true)
  expect(magnitude(decision.direction)).toBeLessThanOrEqual(1 + 1e-12)
  if (decision.nativeTerminated) expect(magnitude(decision.direction)).toBeLessThanOrEqual(1e-12)

  if (decision.estimate !== null) {
    expect(Number.isFinite(decision.estimate.x)).toBe(true)
    expect(Number.isFinite(decision.estimate.y)).toBe(true)
    expect(decision.estimate.x).toBeGreaterThanOrEqual(0)
    expect(decision.estimate.x).toBeLessThanOrEqual(1)
    expect(decision.estimate.y).toBeGreaterThanOrEqual(0)
    expect(decision.estimate.y).toBeLessThanOrEqual(1)
  }
  expect(Number.isFinite(decision.confidence)).toBe(true)
  expect(decision.confidence).toBeGreaterThanOrEqual(0)
  expect(decision.confidence).toBeLessThanOrEqual(1)
}

class SourceBlindReplayHarness {
  readonly environment: AlgorithmEnvironment
  readonly functionContracts: ReplayEnvironmentFunctionContracts
  readonly trace: ReactiveReplayTrace
  /** Held by the fixture only; it is never copied into AlgorithmEnvironment. */
  readonly privateTruth: { source?: Vec2 }

  readonly controller: AlgorithmController
  private observations: Observation[] = []
  private previousPosition: Vec2
  private travelledDistance = 0

  constructor(factory: () => AlgorithmController, options: HarnessOptions) {
    const robotStart = { ...(options.robotStart ?? DEFAULT_START) }
    const obstacles = (options.obstacles ?? []).map((obstacle) => ({ ...obstacle }))
    const controllerSeed = options.controllerSeed
    const robotStartHeading = options.robotStartHeading ?? 0
    const isBlocked = makeBlockagePredicate(obstacles)
    const safeDirection = makeSafeDirection(isBlocked)

    this.privateTruth = options.heldOutSource
      ? { source: { ...options.heldOutSource } }
      : {}
    this.environment = {
      scenario: {
        kind: 'open',
        name: 'Reactive replay fixture',
        shortName: 'Replay',
        description: 'Source-blind deterministic black-box fixture',
        robotStart: { ...robotStart },
        baseWind: { x: 0, y: 0 },
        turbulence: 0,
        gustStrength: 0,
        diffusivity: 0.02,
        emissionRateScale: 1,
        obstacleComplexityLevel: obstacles.length > 0 ? 1 : 0,
        terrainSlopeDegrees: 0,
        terrainUphillDirectionDegrees: 0,
        gasBuoyancy: 'neutral',
        terrainGasDriftScale: 0,
        robotSlopeLimitDegrees: 25,
        referenceDiffusivity: 0.02,
        intermittency: 0,
        obstacles,
      },
      controllerSeed,
      observationModelVersion: 'reactive-replay-observation-model-v1',
      observationModelSeed: options.observationModelSeed,
      maxSpeed: 0.08,
      activeSniffEnabled: false,
      activeSniffCycleSeconds: 0.75,
      activeSniffReach: 0.065,
      sensorNoise: 0,
      isBlocked,
      windAt: () => ({ x: 0, y: 0 }),
      expectedHitRate: options.expectedHitRate ?? (() => 0),
      safeDirection,
      terrainMobilityScale: () => 1,
      horizontalReachForSurfaceDistance: (_direction, surfaceDistance) => surfaceDistance,
    }
    this.functionContracts = {
      isBlocked: {
        id: 'reactive-replay-rectangle-clearance-v1',
        parameters: { domain: DOMAIN, clearance: CLEARANCE },
      },
      windAt: {
        id: 'reactive-replay-zero-environment-wind-v1',
        parameters: { x: 0, y: 0 },
      },
      expectedHitRate: options.expectedHitRateContract ?? {
        id: 'reactive-replay-constant-zero-rate-v1',
        equation: 'rate(candidateSource, samplePoint, time) = 0',
        parameters: { rate: 0 },
      },
      safeDirection: {
        id: 'reactive-replay-sampled-segment-fan-v1',
        parameters: {
          lookAhead: LOOK_AHEAD,
          segmentSamples: 16,
          turnsRadians: [
            0,
            Math.PI / 6,
            -Math.PI / 6,
            Math.PI / 3,
            -Math.PI / 3,
            Math.PI / 2,
            -Math.PI / 2,
            Math.PI,
          ],
        },
      },
      terrainMobilityScale: {
        id: 'reactive-replay-flat-mobility-v1',
        equation: 'scale(direction) = 1',
      },
      horizontalReachForSurfaceDistance: {
        id: 'reactive-replay-flat-reach-v1',
        equation: 'horizontalReach(direction, surfaceDistance) = surfaceDistance',
      },
    }
    expect('source' in this.environment).toBe(false)
    expect('source' in this.environment.scenario).toBe(false)
    expect('targetStatus' in this.environment.scenario).toBe(false)

    this.trace = {
      schemaVersion: REPLAY_SCHEMA_VERSION,
      accessLevel: 'black-box',
      claimBoundary: 'development-behaviour-only',
      environment: {
        domain: DOMAIN,
        obstacles: cloneCanonical(obstacles),
        robotStart: { ...robotStart },
        robotStartHeading,
        controllerSeed,
        observationModelVersion: this.environment.observationModelVersion,
        observationModelSeed: this.environment.observationModelSeed,
      },
      frames: [],
    }
    this.previousPosition = { ...robotStart }
    this.controller = factory()
    this.controller.reset(this.environment)
  }

  step(specification: StepSpecification) {
    const position = { ...specification.position }
    this.travelledDistance += distance(this.previousPosition, position)
    this.previousPosition = position
    const measurement: Measurement = {
      time: specification.time,
      concentration: specification.concentration ?? 0,
      hit: specification.hit ?? false,
      wind: { ...(specification.wind ?? ZERO) },
      valid: specification.valid ?? true,
      sampleMode: specification.sampleMode ?? 'passive',
    }
    const observation: Observation = { ...measurement, position: { ...position } }
    // Match SimulationEngine: invalid current measurements still reach step(),
    // but are not appended to the controller's observation history.
    if (measurement.valid) this.observations.push(observation)
    const input: AlgorithmStepInput = {
      time: specification.time,
      dt: specification.dt,
      position,
      heading: specification.heading ?? this.trace.environment.robotStartHeading,
      measurement,
      observations: this.observations.map((entry) => cloneCanonical(entry)),
      distance: this.travelledDistance,
    }
    const decision = this.controller.step(input)
    expectValidBlackBoxDecision(decision)
    this.trace.frames.push({
      input: cloneCanonical(input),
      decision: cloneCanonical(decision),
    })
    return decision
  }
}

const decisionTrace = (trace: ReactiveReplayTrace) =>
  trace.frames.map((frame) => frame.decision)

const scientificDecisionProjection = (decision: AlgorithmDecision) => ({
  direction: decision.direction,
  speedScale: decision.speedScale ?? null,
  estimate: decision.estimate,
  confidence: decision.confidence,
  phase: decision.phase,
  nativeTerminated: decision.nativeTerminated ?? null,
  nativeAbstained: decision.nativeAbstained ?? null,
  terminationReason: decision.terminationReason ?? null,
  activeSniff: decision.activeSniff ?? null,
  quadSniff: decision.quadSniff ?? null,
  debug: decision.debug
    ? {
        target: decision.debug.target ?? null,
        grid: decision.debug.grid ?? null,
        particles: decision.debug.particles ?? null,
        candidates: decision.debug.candidates ?? null,
      }
    : null,
})

const scientificDecisionTrace = (trace: ReactiveReplayTrace) =>
  decisionTrace(trace).map(scientificDecisionProjection)

type ReplayExecution = {
  trace: ReactiveReplayTrace
  harness: SourceBlindReplayHarness
}

const createFixtureRecorder = (
  fixtureId: string,
  algorithmId: string,
  execution: ReplayExecution,
  accessLevel: ReplayAccessLevel = 'black-box',
) => new ReplayFixtureRecorder({
  fixtureId,
  algorithmId,
  accessLevel,
  controllerSeed: execution.harness.environment.controllerSeed,
  environment: execution.harness.environment,
  functionContracts: execution.harness.functionContracts,
  observationModel: {
    id: execution.harness.environment.observationModelVersion,
    usesRng: false,
    seed: null,
    controllerExposedSeed: execution.harness.environment.observationModelSeed,
    seedUsed: false,
    equation: 'Measurements are the finite deterministic values stored in the replay trace.',
    parameters: { cadence: 'direct deterministic fixture stream' },
  },
  notes: [
    'Development-behavior-only evidence; no canonical-paper equivalence claim.',
    'Held-out source truth is retained by the harness and excluded from controller inputs.',
  ],
})

const recordPrimaryExecution = (
  recorder: ReplayFixtureRecorder,
  execution: ReplayExecution,
) => {
  execution.trace.frames.forEach((frame, index) => recorder.recordCompletedStep(
    frame.input,
    frame.decision,
    `primary-step-${index + 1}`,
  ))
}

const recordSubtrace = (
  recorder: ReplayFixtureRecorder,
  label: string,
  execution: ReplayExecution,
) => recorder.recordCompletedTrace({
  label,
  environment: execution.harness.environment,
  functionContracts: execution.harness.functionContracts,
  frames: execution.trace.frames,
})

const expectDeterministicAndSourceBlind = <T extends ReplayExecution>(
  replay: (heldOutSource?: Vec2) => T,
  primaryTruth: Vec2 = { x: 0.17, y: 0.73 },
  peerTruth: Vec2 = { x: 0.83, y: 0.19 },
) => {
  const first = replay(primaryTruth)
  const second = replay(primaryTruth)
  const sourceAugmentedHarness = replay(peerTruth)
  expect(canonicalJson(second.trace)).toBe(canonicalJson(first.trace))
  expect(canonicalJson(sourceAugmentedHarness.trace)).toBe(canonicalJson(first.trace))
  return Object.assign(first, {
    peerReplays: { duplicate: second, heldOut: sourceAugmentedHarness },
  })
}

const recordDeterminismAndTruthPeers = (
  recorder: ReplayFixtureRecorder,
  execution: ReplayExecution & {
    peerReplays: { duplicate: ReplayExecution; heldOut: ReplayExecution }
  },
  fixtureId: string,
  primaryTruth: Vec2 = { x: 0.17, y: 0.73 },
  peerTruth: Vec2 = { x: 0.83, y: 0.19 },
) => {
  recordSubtrace(recorder, 'duplicate-reset-replay', execution.peerReplays.duplicate)
  recordSubtrace(recorder, 'different-held-out-source', execution.peerReplays.heldOut)
  declareDeterminismAndTruthCases(recorder, fixtureId, primaryTruth, peerTruth)
}

const declareDeterminismAndTruthCases = (
  recorder: ReplayFixtureRecorder,
  fixtureId: string,
  primaryTruth: Vec2 = { x: 0.17, y: 0.73 },
  peerTruth: Vec2 = { x: 0.83, y: 0.19 },
) => {
  const primaryTruthId = `${fixtureId}-truth-primary-present`
  const peerTruthId = `${fixtureId}-truth-peer-present`
  recorder.heldOutTruthRecord({
    truthId: primaryTruthId,
    truthClass: 'source-present',
    source: primaryTruth,
    prespecifiedBasis: 'Primary source-blind deterministic replay condition.',
  })
  recorder.heldOutTruthRecord({
    truthId: peerTruthId,
    truthClass: 'source-present',
    source: peerTruth,
    prespecifiedBasis: 'Prespecified alternate harness-only truth excluded from controller inputs.',
  })
  recorder.evaluatorCase({
    caseId: `COM03-${fixtureId}-01`,
    assertionId: 'COM-03',
    role: 'held-out-truth-pair',
    primaryEndpoint: 'primary',
    peerEndpoint: 'different-held-out-source',
    primaryResetOrdinal: 1,
    peerResetOrdinal: 3,
    primaryTruthId,
    peerTruthId,
  })
  recorder.evaluatorCase({
    caseId: `COM04-${fixtureId}-01`,
    assertionId: 'COM-04',
    role: 'fresh-reset-duplicate',
    primaryEndpoint: 'primary',
    peerEndpoint: 'duplicate-reset-replay',
    primaryResetOrdinal: 1,
    peerResetOrdinal: 2,
    freshControllerInstances: true,
  })
}

const flattenPoints = (points: readonly Vec2[]) => points.flatMap((point) => [point.x, point.y])

const independentCoverageRoute = (): Vec2[] => {
  const margin = 0.055
  const step = (1 - margin * 2) / 8
  const route: Vec2[] = []
  let startsAtTop = false
  for (let lane = 0; lane < 9; lane += 1) {
    const x = margin + lane * step
    const startY = startsAtTop ? margin : 1 - margin
    const endY = startsAtTop ? 1 - margin : margin
    if (lane === 0) route.push({ x, y: startY })
    route.push({ x, y: endY })
    if (lane < 8) route.push({ x: x + step, y: endY })
    startsAtTop = !startsAtTop
  }
  return route
}

const seededUniformAt = (seed: number, targetIndex: number) => {
  let state = seed >>> 0 || 0x9e37_79b9
  let result = 0
  for (let index = 0; index <= targetIndex; index += 1) {
    let value = (state += 0x6d2b_79f5)
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    result = ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
  return result
}

describe('reactive baseline black-box replay fixtures (development behaviour only)', () => {
  it('[C1] replays monotone boustrophedon lane endpoints/connectors and terminal completion', () => {
    // A pre-sample null estimate cannot be queried through the public contract:
    // every call to step necessarily supplies a measurement. This fixture starts
    // with the protocol's first finite zero-concentration sample.
    const run = (heldOutSource?: Vec2) => {
      const harness = new SourceBlindReplayHarness(createCoverageController, {
        controllerSeed: 1,
        observationModelSeed: OBSERVATION_MODEL_SEED,
        robotStart: { x: 0.05, y: 0.05 },
        heldOutSource,
      })
      const targets: Vec2[] = []
      let position = { x: 0.05, y: 0.05 }
      let terminal: AlgorithmDecision | undefined
      for (let index = 0; index < 30; index += 1) {
        const decision = harness.step({
          time: index * 0.25,
          dt: 0.25,
          position,
          concentration: 0,
          hit: false,
          wind: ZERO,
        })
        if (decision.nativeTerminated) {
          terminal = decision
          break
        }
        expect(decision.phase).toBe('BOUSTROPHEDON SWEEP')
        const target = decision.debug?.target
        expect(target).toBeDefined()
        targets.push({ ...target! })
        position = { ...target! }
      }
      return { trace: harness.trace, harness, targets, terminal }
    }

    const result = expectDeterministicAndSourceBlind(run)
    const { targets, terminal } = result
    const laneMargin = 0.055
    const laneStep = (1 - laneMargin * 2) / 8
    const laneIndices = targets.map((target) => {
      const lane = Math.round((target.x - laneMargin) / laneStep)
      expect(Math.abs(target.x - (laneMargin + lane * laneStep))).toBeLessThanOrEqual(1e-12)
      expect(Math.min(Math.abs(target.y - laneMargin), Math.abs(target.y - (1 - laneMargin))))
        .toBeLessThanOrEqual(1e-12)
      expect(lane).toBeGreaterThanOrEqual(0)
      expect(lane).toBeLessThanOrEqual(8)
      return lane
    })
    for (let index = 1; index < targets.length; index += 1) {
      const previous = targets[index - 1]!
      const current = targets[index]!
      const laneIncrement = laneIndices[index]! - laneIndices[index - 1]!
      expect([0, 1]).toContain(laneIncrement)
      if (laneIncrement === 0) expect(current.y).not.toBe(previous.y)
      if (laneIncrement === 1) expect(current.y).toBe(previous.y)
    }
    expect(laneIndices[0]).toBe(0)
    expect(laneIndices.at(-1)).toBe(8)
    expect(terminal?.phase).toBe('COVERAGE COMPLETE')
    expect(terminal?.nativeTerminated).toBe(true)
    expect(terminal?.direction).toEqual(ZERO)

    const expectedRoute = independentCoverageRoute()
    const recorder = createFixtureRecorder('C1', 'coverage', result)
    recordPrimaryExecution(recorder, result)
    recordDeterminismAndTruthPeers(recorder, result, 'C1')
    recorder.reference('independent-route-and-tracker-expectation', {
      route: expectedRoute,
      firstSamplePose: { x: 0.05, y: 0.05 },
      equalConcentrationTieRule: 'retain first finite maximum',
    })
    recorder.nonNumeric({
      id: 'C1-01',
      passed: result.trace.frames.slice(0, -1).every(
        (frame) => frame.decision.phase === 'BOUSTROPHEDON SWEEP',
      ),
      comparison: 'exact-state',
    })
    recorder.numeric({
      id: 'C1-02',
      actual: flattenPoints(targets),
      expected: flattenPoints(expectedRoute),
      tolerance: 1e-12,
      quantity: 'normalized-target-coordinate',
      comparison: 'ordered-geometry',
    })
    recorder.numeric({
      id: 'C1-03',
      actual: magnitude(terminal!.direction),
      expected: 0,
      tolerance: 1e-12,
      quantity: 'terminal-direction-norm',
      comparison: 'terminal-contract',
      details: {
        phaseExact: terminal?.phase === 'COVERAGE COMPLETE',
        nativeTerminatedExact: terminal?.nativeTerminated === true,
        observed: terminal ?? null,
      },
    })
    const observedEstimates = result.trace.frames.flatMap((frame) =>
      frame.decision.estimate ? [frame.decision.estimate.x, frame.decision.estimate.y] : [],
    )
    recorder.numeric({
      id: 'C1-04',
      actual: observedEstimates,
      expected: result.trace.frames.flatMap(() => [0.05, 0.05]),
      tolerance: 1e-12,
      quantity: 'estimate-coordinate',
      comparison: 'first-maximum-geometry',
    })
    recorder.finish()
  })

  it('[C2] selects the finite concentration maximum and ignores hit-only changes to its location', () => {
    const poses: Vec2[] = [
      { x: 0.2, y: 0.3 },
      { x: 0.72, y: 0.61 },
      { x: 0.42, y: 0.81 },
    ]
    const concentrations = [0.2, 0.8, 0.5]
    const run = (
      hits: readonly boolean[],
      heldOutSource?: Vec2,
      measuredWind: Vec2 = ZERO,
    ) => {
      const harness = new SourceBlindReplayHarness(createCoverageController, {
        controllerSeed: 9,
        observationModelSeed: OBSERVATION_MODEL_SEED,
        robotStart: poses[0],
        heldOutSource,
      })
      const estimates = poses.map((position, index) => harness.step({
        time: index * 0.25,
        dt: 0.25,
        position,
        concentration: concentrations[index],
        hit: hits[index],
        wind: measuredWind,
      }).estimate)
      return { trace: harness.trace, harness, estimates }
    }

    const primaryTruth = { x: 0.17, y: 0.73 }
    const primary = run([false, false, false], primaryTruth)
    const repeat = run([false, false, false], primaryTruth)
    const changedHits = run([true, false, true], primaryTruth)
    const withHeldOutTruth = run([false, false, false], { x: 0.83, y: 0.19 })
    const changedMeasuredWind = run(
      [false, false, false],
      primaryTruth,
      { x: 0.6, y: -0.8 },
    )
    expect(canonicalJson(repeat.trace)).toBe(canonicalJson(primary.trace))
    expect(canonicalJson(decisionTrace(withHeldOutTruth.trace)))
      .toBe(canonicalJson(decisionTrace(primary.trace)))
    expect(primary.estimates.at(-1)).toEqual(poses[1])
    expect(changedHits.estimates.at(-1)).toEqual(poses[1])
    expect(canonicalJson(scientificDecisionTrace(changedMeasuredWind.trace)))
      .toBe(canonicalJson(scientificDecisionTrace(primary.trace)))
    expect(distance(primary.estimates.at(-1)!, poses[1]!)).toBeLessThanOrEqual(1e-12)

    const recorder = createFixtureRecorder('C2', 'coverage', primary)
    recordPrimaryExecution(recorder, primary)
    recordSubtrace(recorder, 'duplicate-reset-replay', repeat)
    recordSubtrace(recorder, 'changed-hit-flags', changedHits)
    recordSubtrace(recorder, 'different-held-out-source', withHeldOutTruth)
    recordSubtrace(recorder, 'changed-measured-wind', changedMeasuredWind)
    declareDeterminismAndTruthCases(recorder, 'C2', primaryTruth)
    recorder.evaluatorCase({
      caseId: 'COM05-C2-measured-wind-01',
      assertionId: 'COM-05',
      role: 'ignored-field-metamorphic',
      primaryEndpoint: 'primary',
      peerEndpoint: 'changed-measured-wind',
      primaryResetOrdinal: 1,
      peerResetOrdinal: 5,
      ignoredField: 'measured-wind',
    })
    recorder.reference('independent-max-and-tie-reference', {
      poses,
      concentrations,
      expectedFirstMaximumIndex: 1,
      expectedEstimate: poses[1],
    })
    recorder.numeric({
      id: 'C2-01',
      actual: [primary.estimates.at(-1)!.x, primary.estimates.at(-1)!.y],
      expected: [poses[1]!.x, poses[1]!.y],
      tolerance: 1e-12,
      quantity: 'estimate-coordinate',
      comparison: 'argmax-first-tie',
    })
    recorder.nonNumeric({
      id: 'C2-02',
      passed: canonicalJson(primary.estimates) === canonicalJson(changedHits.estimates),
      comparison: 'canonical-projection-exact',
    })
    recorder.finish()
  })

  it('[C3] filters a lane-crossing wall command through the fixture clearance policy', () => {
    const wall: Obstacle = {
      id: 'one-cell-wall',
      x: 0.045,
      y: 0.42,
      width: 0.02,
      height: 0.04,
    }
    const start = { x: 0.055, y: 0.39 }
    const run = (heldOutSource?: Vec2) => {
      const harness = new SourceBlindReplayHarness(createCoverageController, {
        controllerSeed: 1,
        observationModelSeed: OBSERVATION_MODEL_SEED,
        robotStart: start,
        obstacles: [wall],
        heldOutSource,
      })
      const decision = harness.step({
        time: 0,
        dt: 0.1,
        position: start,
        concentration: 0,
        hit: false,
        wind: ZERO,
      })
      return { trace: harness.trace, harness, decision }
    }

    const result = expectDeterministicAndSourceBlind(run)
    const { harness, decision } = result
    expect(decision.phase).toBe('BOUSTROPHEDON SWEEP')
    expect(magnitude(decision.direction)).toBeGreaterThan(0)
    expect(segmentIsClear(start, decision.direction, LOOK_AHEAD, harness.environment.isBlocked))
      .toBe(true)
    expect(harness.environment.isBlocked(add(start, scale({ x: 0, y: 1 }, LOOK_AHEAD))))
      .toBe(true)
    // This establishes controller delegation under the source-blind fixture's
    // explicit segment policy. Production createEnvironment geometry is outside
    // this local replay and needs its own safety-integration fixture.
    const independentProbes = Array.from({ length: 16 }, (_, index) =>
      add(start, scale(decision.direction, (LOOK_AHEAD * (index + 1)) / 16)),
    )
    const dilatedWall = {
      left: wall.x - CLEARANCE,
      right: wall.x + wall.width + CLEARANCE,
      bottom: wall.y - CLEARANCE,
      top: wall.y + wall.height + CLEARANCE,
    }
    const clearanceResiduals = independentProbes.map((probe) => {
      const insideDilatedWall = probe.x >= dilatedWall.left &&
        probe.x <= dilatedWall.right &&
        probe.y >= dilatedWall.bottom &&
        probe.y <= dilatedWall.top
      if (!insideDilatedWall) return 0
      return Math.min(
        probe.x - dilatedWall.left,
        dilatedWall.right - probe.x,
        probe.y - dilatedWall.bottom,
        dilatedWall.top - probe.y,
      )
    })
    const recorder = createFixtureRecorder('C3', 'coverage', result)
    recordPrimaryExecution(recorder, result)
    recordDeterminismAndTruthPeers(recorder, result, 'C3')
    recorder.reference('independent-clearance-dilated-wall-checker', {
      wall,
      clearance: CLEARANCE,
      oneStepDistance: LOOK_AHEAD,
      sampledPoints: independentProbes,
      straightLaneProbeIsBlocked: true,
    })
    recorder.numeric({
      id: 'C3-01',
      actual: clearanceResiduals,
      expected: clearanceResiduals.map(() => 0),
      tolerance: 1e-12,
      quantity: 'clearance-residual',
      comparison: 'segment-clearance',
      details: { sampleCount: independentProbes.length, geometryTolerance: 1e-12 },
    })
    recorder.finish()
  })

  it('[S1] replays declared acquisition actions without an upwind/cast claim before contact', () => {
    const run = (heldOutSource?: Vec2) => {
      const harness = new SourceBlindReplayHarness(createSurgeCastController, {
        controllerSeed: 12,
        observationModelSeed: OBSERVATION_MODEL_SEED,
        robotStart: DEFAULT_START,
        heldOutSource,
      })
      const waypointsFor = (startsHigh: boolean): Vec2[] => Array.from(
        { length: 7 },
        (_, index) => ({
          x: 0.06 + (index / 6) * 0.88,
          y: (index % 2 === 0 ? startsHigh : !startsHigh) ? 0.08 : 0.92,
        }),
      )
      const first = harness.step({
        time: 0,
        dt: 0.25,
        position: DEFAULT_START,
        concentration: 0,
        hit: false,
        wind: ZERO,
      })
      const lowFirst = waypointsFor(false)
      const alignment = (target: Vec2) => dot(
        first.direction,
        normalize(subtract(target, DEFAULT_START)),
      )
      // Independent seed-12 expectation: the acquisition table starts at y=0.92.
      const declaredWaypoints = lowFirst
      expect(alignment(declaredWaypoints[0]!)).toBeGreaterThan(1 - 1e-12)

      const actions = [first]
      for (let index = 0; index < declaredWaypoints.length; index += 1) {
        const position = declaredWaypoints[index]!
        const decision = harness.step({
          time: (index + 1) * 0.25,
          dt: 0.25,
          position,
          concentration: 0,
          hit: false,
          wind: ZERO,
        })
        expect(decision.phase).toBe('PLUME ACQUISITION SWEEP')
        expect(decision.phase).not.toContain('UPWIND')
        expect(decision.phase).not.toContain('CAST')
        actions.push(decision)
        const nextWaypoint = declaredWaypoints[index + 1]
        if (nextWaypoint) {
          expect(dot(decision.direction, normalize(subtract(nextWaypoint, position))))
            .toBeGreaterThan(1 - 1e-12)
        } else {
          expect(decision.direction).toEqual(ZERO)
        }
      }
      // Infer each acquisition waypoint from the returned public action at the
      // preceding controlled pose and its independently declared edge band. The
      // private waypoint array/index and the human-readable debug target remain
      // uninspected. This turns action alignment into an ordered-geometry trace.
      const inferredWaypoints = declaredWaypoints.map((target, index) => {
        const origin = index === 0 ? DEFAULT_START : declaredWaypoints[index - 1]!
        const action = actions[index]!
        expect(Math.abs(action.direction.y)).toBeGreaterThan(1e-12)
        const travelToEdge = (target.y - origin.y) / action.direction.y
        return add(origin, scale(action.direction, travelToEdge))
      })
      const directionAlignmentResiduals = declaredWaypoints.map((target, index) => {
        const origin = index === 0 ? DEFAULT_START : declaredWaypoints[index - 1]!
        return 1 - dot(actions[index]!.direction, normalize(subtract(target, origin)))
      })
      return {
        trace: harness.trace,
        harness,
        declaredWaypoints,
        inferredWaypoints,
        directionAlignmentResiduals,
        actions,
      }
    }

    const result = expectDeterministicAndSourceBlind(run)
    const { declaredWaypoints, inferredWaypoints } = result
    expect(declaredWaypoints).toHaveLength(7)
    expect(inferredWaypoints).toHaveLength(7)
    for (let index = 0; index < declaredWaypoints.length; index += 1) {
      expect(declaredWaypoints[index]!.x).toBeCloseTo(0.06 + (index / 6) * 0.88, 12)
      expect([0.08, 0.92]).toContain(declaredWaypoints[index]!.y)
      if (index > 0) {
        expect(declaredWaypoints[index]!.y).not.toBe(declaredWaypoints[index - 1]!.y)
      }
    }

    const recorder = createFixtureRecorder('S1', 'surge-cast', result)
    recordPrimaryExecution(recorder, result)
    recordDeterminismAndTruthPeers(recorder, result, 'S1')
    recorder.reference('independent-acquisition-expectation', {
      controllerSeed: 12,
      expectedWaypointTable: declaredWaypoints,
      expectedPublicPhase: 'PLUME ACQUISITION SWEEP',
      inferenceContract:
        'Intersect each returned public action ray with the independently declared alternating edge band.',
    })
    recorder.nonNumeric({
      id: 'S1-01',
      passed: result.actions.every(
        (decision) => decision.phase === 'PLUME ACQUISITION SWEEP' &&
          !decision.phase.includes('UPWIND') &&
          !decision.phase.includes('CAST'),
      ),
      comparison: 'exact-state',
    })
    recorder.numeric({
      id: 'S1-02',
      actual: result.directionAlignmentResiduals,
      expected: result.directionAlignmentResiduals.map(() => 0),
      tolerance: 1e-12,
      quantity: 'one-minus-direction-dot-product',
      comparison: 'direction-alignment',
      details: { actionCount: result.directionAlignmentResiduals.length },
    })
    recorder.numeric({
      id: 'S1-03',
      actual: flattenPoints(inferredWaypoints),
      expected: flattenPoints(declaredWaypoints),
      quantity: 'normalized-waypoint-coordinate',
      tolerance: 1e-12,
      comparison: 'ordered-geometry',
      details: {
        waypointCount: inferredWaypoints.length,
        inference: 'controlled-action-ray/edge-band intersection',
        privateStateInspected: false,
      },
    })
    recorder.finish()
  })

  it('[S2] transitions miss-hit-miss and exposes the expanding reversal schedule through actions', () => {
    // Exact castSpan, castProgress, and leg-index values remain diagnostic-only.
    // This black-box fixture infers reversals solely from returned directions and
    // supplied pose increments; it never parses the human-readable debug note.
    const run = (heldOutSource?: Vec2) => {
      const harness = new SourceBlindReplayHarness(createSurgeCastController, {
        controllerSeed: 21,
        observationModelSeed: OBSERVATION_MODEL_SEED,
        robotStart: DEFAULT_START,
        heldOutSource,
      })
      let time = 0
      let position = { ...DEFAULT_START }
      const acquisition = harness.step({
        time,
        dt: 0.05,
        position,
        concentration: 0,
        hit: false,
        wind: ZERO,
      })
      const diagnosticTimeline = [readSurgeCastDiagnostic(
        harness.controller as SurgeCastController,
      )]
      const diagnosticReference: SurgeCastDiagnosticState[] = [{
        castSpan: 0.045,
        castProgress: 0,
        castLeg: 0,
        castSide: 1,
        previousMotion: 'other',
      }]
      time += 0.05
      const surge = harness.step({
        time,
        dt: 0.05,
        position,
        concentration: 0.7,
        hit: true,
        wind: { x: 1, y: 0 },
      })
      diagnosticTimeline.push(readSurgeCastDiagnostic(
        harness.controller as SurgeCastController,
      ))
      diagnosticReference.push({
        castSpan: 0.045,
        castProgress: 0,
        castLeg: 0,
        castSide: 1,
        previousMotion: 'surge',
      })
      time += 0.05
      let cast = harness.step({
        time,
        dt: 0.05,
        position,
        concentration: 0.1,
        hit: false,
        wind: { x: 1, y: 0 },
      })
      const initialDiagnostic = readSurgeCastDiagnostic(
        harness.controller as SurgeCastController,
      )
      diagnosticTimeline.push(initialDiagnostic)
      diagnosticReference.push({
        castSpan: 0.045,
        castProgress: 0,
        castLeg: 0,
        castSide: -1,
        previousMotion: 'cast',
      })
      const detachedDiagnostic = readSurgeCastDiagnostic(
        harness.controller as SurgeCastController,
      )
      detachedDiagnostic.state.castSpan = 999
      expect(readSurgeCastDiagnostic(harness.controller as SurgeCastController).state.castSpan)
        .toBe(initialDiagnostic.state.castSpan)

      const movementIncrement = 0.003
      const reversalTravel: number[] = []
      const sideAfterReversal: number[] = []
      const reversalDiagnostics: ReturnType<typeof readSurgeCastDiagnostic>[] = []
      let travelOnLeg = 0
      let referenceProgress = 0
      let referenceSpan = 0.045
      let referenceLeg = 0
      let referenceSide = -1
      for (let index = 0; index < 500 && reversalTravel.length < 6; index += 1) {
        const previousDirection = cast.direction
        position = add(position, scale(previousDirection, movementIncrement))
        travelOnLeg += movementIncrement
        time += 0.05
        const next = harness.step({
          time,
          dt: 0.05,
          position,
          concentration: 0.1,
          hit: false,
          wind: { x: 1, y: 0 },
        })
        referenceProgress += movementIncrement
        if (referenceProgress >= referenceSpan) {
          referenceProgress = 0
          referenceSide *= -1
          referenceLeg += 1
          referenceSpan = Math.min(0.22, 0.045 + referenceLeg * 0.018)
        }
        diagnosticTimeline.push(readSurgeCastDiagnostic(
          harness.controller as SurgeCastController,
        ))
        diagnosticReference.push({
          castSpan: referenceSpan,
          castProgress: referenceProgress,
          castLeg: referenceLeg,
          castSide: referenceSide,
          previousMotion: 'cast',
        })
        expect(next.phase).toBe('EXPANDING CROSSWIND CAST')
        expect(Math.abs(dot(next.direction, { x: 1, y: 0 }))).toBeLessThanOrEqual(1e-6)
        if (dot(previousDirection, next.direction) < -0.99) {
          reversalTravel.push(travelOnLeg)
          sideAfterReversal.push(Math.sign(next.direction.y))
          reversalDiagnostics.push(readSurgeCastDiagnostic(
            harness.controller as SurgeCastController,
          ))
          travelOnLeg = 0
        }
        cast = next
      }
      return {
        trace: harness.trace,
        harness,
        acquisition,
        surge,
        firstCast: harness.trace.frames[2]!.decision,
        reversalTravel,
        sideAfterReversal,
        initialDiagnostic,
        reversalDiagnostics,
        diagnosticTimeline,
        diagnosticReference,
        movementIncrement,
      }
    }

    const result = expectDeterministicAndSourceBlind(run)
    expect(result.acquisition.phase).toBe('PLUME ACQUISITION SWEEP')
    expect(result.surge.phase).toBe('UPWIND SURGE')
    expect(result.surge.direction.x).toBeCloseTo(-1, 6)
    expect(result.surge.direction.y).toBeCloseTo(0, 6)
    expect(result.firstCast.phase).toBe('EXPANDING CROSSWIND CAST')
    expect(Math.abs(dot(result.firstCast.direction, { x: 1, y: 0 })))
      .toBeLessThanOrEqual(1e-6)
    expect(result.initialDiagnostic).toMatchObject({
      schemaVersion: BASELINE_REPLAY_DIAGNOSTIC_SCHEMA_VERSION,
      access: 'diagnostic-read-only',
      evidenceLabel: 'development-behavior-only',
      algorithmId: 'surge-cast',
      state: {
        castSpan: 0.045,
        castProgress: 0,
        castLeg: 0,
        previousMotion: 'cast',
      },
    })
    expect(result.reversalTravel).toHaveLength(6)
    result.reversalTravel.forEach((travel, leg) => {
      const declaredSchedule = Math.min(0.22, 0.045 + leg * 0.018)
      expect(Math.abs(travel - declaredSchedule))
        .toBeLessThanOrEqual(result.movementIncrement + 1e-12)
    })
    expect(result.reversalDiagnostics).toHaveLength(6)
    result.reversalDiagnostics.forEach((diagnostic, index) => {
      const completedLegs = index + 1
      expect(diagnostic.state.castLeg).toBe(completedLegs)
      expect(diagnostic.state.castProgress).toBe(0)
      expect(diagnostic.state.castSpan)
        .toBeCloseTo(Math.min(0.22, 0.045 + completedLegs * 0.018), 12)
      expect(diagnostic.state.previousMotion).toBe('cast')
      if (index > 0) {
        expect(diagnostic.state.castSide)
          .toBe(-result.reversalDiagnostics[index - 1]!.state.castSide)
      }
    })
    result.sideAfterReversal.forEach((side, index) => {
      if (index > 0) expect(side).toBe(-result.sideAfterReversal[index - 1]!)
    })

    const diagnosticVector = (states: readonly SurgeCastDiagnosticState[]) => states.flatMap(
      (state) => [
        state.castSpan,
        state.castProgress,
        state.castLeg,
        state.castSide,
        state.previousMotion === 'other' ? 0 : state.previousMotion === 'surge' ? 1 : 2,
      ],
    )
    const observedDiagnosticStates = result.diagnosticTimeline.map((entry) => entry.state)
    const expectedReversalTravel = result.reversalTravel.map(
      (_travel, leg) => Math.min(0.22, 0.045 + leg * 0.018),
    )
    const expectedSides = result.sideAfterReversal.map((_side, index) =>
      index % 2 === 0 ? -1 : 1,
    )
    const recorder = createFixtureRecorder('S2', 'surge-cast', result, 'black-box+diagnostic')
    recordPrimaryExecution(recorder, result)
    recordDeterminismAndTruthPeers(recorder, result, 'S2')
    recorder.diagnostic('versioned-cast-state-timeline', result.diagnosticTimeline)
    recorder.reference('independent-transition-cast-schedule-and-state-reference', {
      phases: ['PLUME ACQUISITION SWEEP', 'UPWIND SURGE', 'EXPANDING CROSSWIND CAST'],
      upwindDirection: { x: -1, y: 0 },
      wind: { x: 1, y: 0 },
      movementIncrement: result.movementIncrement,
      reversalTravel: expectedReversalTravel,
      sidesAfterReversal: expectedSides,
      diagnosticStateTimeline: result.diagnosticReference,
    })
    recorder.nonNumeric({
      id: 'S2-01',
      passed: result.surge.phase === 'UPWIND SURGE' &&
        result.firstCast.phase === 'EXPANDING CROSSWIND CAST',
      accessLevel: 'black-box',
      comparison: 'exact-transition-sequence',
    })
    recorder.numeric({
      id: 'S2-02',
      actual: [
        result.surge.direction.x,
        result.surge.direction.y,
        dot(result.firstCast.direction, { x: 1, y: 0 }),
      ],
      expected: [-1, 0, 0],
      tolerance: 1e-6,
      quantity: 'direction-component',
      accessLevel: 'black-box',
      comparison: 'direction-vector',
    })
    recorder.numeric({
      id: 'S2-03',
      actual: [...result.reversalTravel, ...result.sideAfterReversal],
      expected: [...expectedReversalTravel, ...expectedSides],
      tolerance: 0.003000000001,
      quantity: 'reversal-travel',
      accessLevel: 'black-box',
      comparison: 'travel-schedule',
      details: { sideCodeMismatchMagnitude: 2 },
    })
    recorder.numeric({
      id: 'S2-04',
      actual: diagnosticVector(observedDiagnosticStates),
      expected: diagnosticVector(result.diagnosticReference),
      tolerance: 1e-12,
      quantity: 'cast-state-residual',
      accessLevel: 'diagnostic',
      comparison: 'diagnostic-state-vector',
    })
    recorder.finish()
  })

  it('[S3] declares only after sustained passive core/ring evidence and rejects hit-only support', () => {
    const runStable = (
      expectedRate: number,
      heldOutSource?: Vec2,
      sampleMode: Measurement['sampleMode'] = 'passive',
      valid = true,
    ) => {
      const harness = new SourceBlindReplayHarness(createSurgeCastController, {
        controllerSeed: 31,
        observationModelSeed: OBSERVATION_MODEL_SEED,
        robotStart: { x: 0.5, y: 0.5 },
        heldOutSource,
        expectedHitRate: () => expectedRate,
        expectedHitRateContract: {
          id: 'reactive-replay-constant-rate-v1',
          equation: 'rate(candidateSource, samplePoint, time) = configuredRate',
          parameters: { configuredRate: expectedRate },
        },
      })
      let terminal: AlgorithmDecision | undefined
      let terminalTime: number | undefined
      for (let time = 0; time <= 30; time += 1) {
        const isCore = time % 2 === 0
        const decision = harness.step({
          time,
          dt: 1,
          position: isCore ? { x: 0.5, y: 0.5 } : { x: 0.58, y: 0.5 },
          concentration: isCore ? 0.9 : 0.3,
          hit: true,
          wind: { x: 1, y: 0 },
          sampleMode,
          valid,
        })
        expect(decision.activeSniff).toBeUndefined()
        expect(decision.quadSniff).toBeUndefined()
        if (decision.nativeTerminated) {
          terminal = decision
          terminalTime = time
          break
        }
      }
      return { trace: harness.trace, harness, terminal, terminalTime }
    }
    const runHitOnly = () => {
      const harness = new SourceBlindReplayHarness(createSurgeCastController, {
        controllerSeed: 31,
        observationModelSeed: OBSERVATION_MODEL_SEED,
        robotStart: { x: 0.5, y: 0.5 },
        expectedHitRate: () => {
          throw new Error('Surge-cast must not query a model field')
        },
        expectedHitRateContract: {
          id: 'reactive-replay-throw-if-queried-rate-guard-v1',
          parameters: { expectedCalls: 0 },
        },
      })
      let declared = false
      for (let time = 0; time <= 30; time += 1) {
        const decision = harness.step({
          time,
          dt: 1,
          position: { x: 0.5, y: 0.5 },
          concentration: 0.9,
          hit: true,
          wind: { x: 1, y: 0 },
        })
        declared ||= decision.nativeTerminated === true
      }
      return { trace: harness.trace, harness, declared }
    }

    const stableTruth = { x: 0.5, y: 0.5 }
    const stable = expectDeterministicAndSourceBlind(
      (source) => runStable(0, source),
      stableTruth,
    )
    const changedModel = runStable(999)
    const activeReturnCounterexample = runStable(0, undefined, 'active-return')
    const invalidCounterexample = runStable(0, undefined, 'passive', false)
    const blankedCounterexample = runStable(0, undefined, 'blanked')
    const quadReturnCounterexample = runStable(0, undefined, 'quad-return')
    const hitOnly = runHitOnly()
    expect(canonicalJson(decisionTrace(changedModel.trace)))
      .toBe(canonicalJson(decisionTrace(stable.trace)))
    expect(stable.terminal?.phase).toBe('STABLE PEAK DECLARED')
    expect(stable.terminal?.nativeTerminated).toBe(true)
    expect(stable.terminalTime).toBeGreaterThanOrEqual(16)
    expect(hitOnly.declared).toBe(false)

    // Tracked peak/core-ring evidence must remain isolated from intervention
    // returns and invalid frames. Each counterfactual repeats the supported
    // concentration geometry while changing only mode or validity.
    const passiveOnlyStatus = {
      requiredAssertion: 'S3.passive-only',
      status: 'pass',
      knownNonconformance: false,
      activeReturnDeclared: activeReturnCounterexample.terminal?.nativeTerminated === true,
      invalidMeasurementDeclared: invalidCounterexample.terminal?.nativeTerminated === true,
      blankedMeasurementDeclared: blankedCounterexample.terminal?.nativeTerminated === true,
      quadReturnDeclared: quadReturnCounterexample.terminal?.nativeTerminated === true,
    } as const
    expect(passiveOnlyStatus.knownNonconformance).toBe(false)
    expect(passiveOnlyStatus.status).toBe('pass')
    expect(passiveOnlyStatus.activeReturnDeclared).toBe(false)
    expect(passiveOnlyStatus.invalidMeasurementDeclared).toBe(false)
    expect(passiveOnlyStatus.blankedMeasurementDeclared).toBe(false)
    expect(passiveOnlyStatus.quadReturnDeclared).toBe(false)

    const recorder = createFixtureRecorder('S3', 'surge-cast', stable)
    recordPrimaryExecution(recorder, stable)
    recordDeterminismAndTruthPeers(recorder, stable, 'S3', stableTruth)
    recordSubtrace(recorder, 'changed-rate-oracle', changedModel)
    recordSubtrace(recorder, 'active-return-counterexample', activeReturnCounterexample)
    recordSubtrace(recorder, 'invalid-measurement-counterexample', invalidCounterexample)
    recordSubtrace(recorder, 'blanked-measurement-counterexample', blankedCounterexample)
    recordSubtrace(recorder, 'quad-return-counterexample', quadReturnCounterexample)
    recordSubtrace(recorder, 'unsupported-hit-stream', hitOnly)
    recorder.evaluatorCase({
      caseId: 'COM05-S3-expected-hit-rate-01',
      assertionId: 'COM-05',
      role: 'ignored-field-metamorphic',
      primaryEndpoint: 'primary',
      peerEndpoint: 'changed-rate-oracle',
      primaryResetOrdinal: 1,
      peerResetOrdinal: 4,
      ignoredField: 'expectedHitRate',
    })
    recorder.evaluatorCase({
      caseId: 'COM06-S3-terminal-01',
      assertionId: 'COM-06',
      role: 'held-out-terminal-evaluation',
      terminalEndpoint: 'primary',
      truthId: 'S3-truth-primary-present',
      localizationThreshold: 0.05,
    })
    recorder.reference('independent-declaration-and-validity-expectation', {
      requiredEvidenceInput: { valid: true, sampleMode: 'passive' },
      forbiddenSubstitutes: [
        { valid: true, sampleMode: 'active-return' },
        { valid: false, sampleMode: 'passive' },
        { valid: true, sampleMode: 'blanked' },
        { valid: true, sampleMode: 'quad-return' },
      ],
      supportedTraceExpectedDeclarationTime: 16,
      unsupportedHitStreamMayTerminate: false,
      terminalDirection: ZERO,
    })
    recorder.nonNumeric({
      id: 'S3-01',
      passed: !passiveOnlyStatus.activeReturnDeclared &&
        !passiveOnlyStatus.invalidMeasurementDeclared &&
        !passiveOnlyStatus.blankedMeasurementDeclared &&
        !passiveOnlyStatus.quadReturnDeclared,
      comparison: 'mode-validity-counterfactual',
      failureReasonCode: 'non-passive-or-invalid-evidence-accumulated',
      details: passiveOnlyStatus,
    })
    recorder.nonNumeric({
      id: 'S3-02',
      passed: !hitOnly.declared,
      comparison: 'negative-terminal',
    })
    recorder.nonNumeric({
      id: 'S3-03',
      passed: stable.terminal?.phase === 'STABLE PEAK DECLARED' &&
        stable.terminalTime === 16,
      comparison: 'gate-conjunction',
      details: { expectedDeclarationTime: 16, observedDeclarationTime: stable.terminalTime },
    })
    recorder.numeric({
      id: 'S3-04',
      actual: [stable.terminal!.direction.x, stable.terminal!.direction.y],
      expected: [0, 0],
      tolerance: 1e-12,
      quantity: 'direction-norm',
      comparison: 'terminal-direction',
    })
    const captureResult = recorder.finish()
    expect(captureResult.fixture.summary.fixtureVerdict).toBe('pass')
    expect(captureResult.fixture.summary.requiredFail).toBe(0)
  })

  it('[Z1] replays eight alternating coarse waypoints at unit speed with no wind dependence', () => {
    const run = (wind: Vec2, heldOutSource?: Vec2, expectedRate = 0) => {
      const harness = new SourceBlindReplayHarness(createZigzagSpiralController, {
        controllerSeed: 41,
        observationModelSeed: OBSERVATION_MODEL_SEED,
        robotStart: DEFAULT_START,
        heldOutSource,
        expectedHitRate: () => expectedRate,
        expectedHitRateContract: {
          id: 'z1-prespecified-constant-rate-v1',
          equation: 'rate(candidateSource, samplePoint, time) = configuredRate',
          parameters: { configuredRate: expectedRate },
        },
      })
      const targets: Vec2[] = []
      let position = { ...DEFAULT_START }
      for (let index = 0; index < 8; index += 1) {
        const decision = harness.step({
          time: index * 0.25,
          dt: 0.25,
          position,
          concentration: 0.1,
          hit: false,
          wind,
        })
        expect(decision.phase).toBe('BROAD ZIGZAG ACQUISITION')
        expect(decision.speedScale).toBe(1)
        const target = decision.debug?.target
        expect(target).toBeDefined()
        targets.push({ ...target! })
        position = { ...target! }
      }
      return { trace: harness.trace, harness, targets }
    }

    const calm = expectDeterministicAndSourceBlind((source) => run(ZERO, source))
    const windy = run({ x: -0.8, y: 0.6 })
    const changedRate = run(ZERO, { x: 0.17, y: 0.73 }, 999)
    expect(canonicalJson(decisionTrace(windy.trace)))
      .toBe(canonicalJson(decisionTrace(calm.trace)))
    expect(canonicalJson(decisionTrace(changedRate.trace)))
      .toBe(canonicalJson(decisionTrace(calm.trace)))
    expect(calm.targets).toHaveLength(8)
    for (let index = 0; index < calm.targets.length; index += 1) {
      const target = calm.targets[index]!
      expect(target.x).toBeCloseTo(0.06 + index * ((0.94 - 0.06) / 7), 12)
      expect([0.13, 0.87]).toContain(target.y)
      if (index > 0) expect(target.y).not.toBe(calm.targets[index - 1]!.y)
    }

    const expectedWaypoints = Array.from({ length: 8 }, (_, index) => ({
      x: 0.06 + index * ((0.94 - 0.06) / 7),
      y: index % 2 === 0 ? 0.13 : 0.87,
    }))
    const phaseAllPassed = calm.trace.frames.every(
      (frame) => frame.decision.phase === 'BROAD ZIGZAG ACQUISITION',
    )
    const recorder = createFixtureRecorder('Z1', 'zigzag-spiral', calm)
    recordPrimaryExecution(recorder, calm)
    recordDeterminismAndTruthPeers(recorder, calm, 'Z1')
    recordSubtrace(recorder, 'changed-measured-wind', windy)
    recordSubtrace(recorder, 'changed-rate-oracle', changedRate)
    recorder.evaluatorCase({
      caseId: 'COM05-Z1-measured-wind-01',
      assertionId: 'COM-05',
      role: 'ignored-field-metamorphic',
      primaryEndpoint: 'primary',
      peerEndpoint: 'changed-measured-wind',
      primaryResetOrdinal: 1,
      peerResetOrdinal: 4,
      ignoredField: 'measured-wind',
    })
    recorder.evaluatorCase({
      caseId: 'COM05-Z1-expected-hit-rate-01',
      assertionId: 'COM-05',
      role: 'ignored-field-metamorphic',
      primaryEndpoint: 'primary',
      peerEndpoint: 'changed-rate-oracle',
      primaryResetOrdinal: 1,
      peerResetOrdinal: 5,
      ignoredField: 'expectedHitRate',
    })
    recorder.reference('independent-coarse-waypoint-and-wind-reference', {
      controllerSeed: 41,
      waypoints: expectedWaypoints,
      phase: 'BROAD ZIGZAG ACQUISITION',
      speedScale: 1,
      measuredWindDependencyAllowed: false,
    })
    recorder.numeric({
      id: 'Z1-01',
      actual: [...flattenPoints(calm.targets), phaseAllPassed ? 1 : 0],
      expected: [...flattenPoints(expectedWaypoints), 1],
      tolerance: 1e-12,
      quantity: 'normalized-target-coordinate',
      comparison: 'ordered-geometry',
    })
    recorder.nonNumeric({
      id: 'Z1-02',
      passed: calm.trace.frames.every((frame) => frame.decision.speedScale === 1) &&
        canonicalJson(scientificDecisionTrace(calm.trace)) === canonicalJson(
          scientificDecisionTrace(windy.trace),
        ),
      comparison: 'paired-wind-invariance',
    })
    recorder.finish()
  })

  it('[Z2] gates refinement at 0.58 and infers monotone contraction from public target/estimate', () => {
    // Exact private spiralRadius and centre-reset state remain diagnostic-only.
    // Only the radius geometrically inferable from public target/estimate is used.
    const run = (heldOutSource?: Vec2) => {
      const harness = new SourceBlindReplayHarness(createZigzagSpiralController, {
        controllerSeed: 51,
        observationModelSeed: OBSERVATION_MODEL_SEED,
        robotStart: { x: 0.5, y: 0.5 },
        heldOutSource,
      })
      const below = harness.step({
        time: 0,
        dt: 0.25,
        position: { x: 0.2, y: 0.2 },
        concentration: 0.579999,
        hit: true,
        wind: ZERO,
      })
      const threshold = harness.step({
        time: 0.25,
        dt: 0.25,
        position: { x: 0.5, y: 0.5 },
        concentration: 0.58,
        hit: true,
        wind: ZERO,
      })
      const radii: number[] = []
      const diagnosticRadii: number[] = []
      const diagnosticCenters: Array<Vec2 | null> = []
      const diagnosticTimeline: ReturnType<typeof readZigzagSpiralDiagnostic>[] = []
      const recordRadius = (decision: AlgorithmDecision) => {
        expect(decision.debug?.target).toBeDefined()
        expect(decision.estimate).not.toBeNull()
        const inferred = distance(decision.debug!.target!, decision.estimate!)
        const diagnostic = readZigzagSpiralDiagnostic(
          harness.controller as ZigzagSpiralController,
        )
        radii.push(inferred)
        diagnosticRadii.push(diagnostic.state.spiralRadius)
        diagnosticCenters.push(diagnostic.state.spiralCenter)
        diagnosticTimeline.push(diagnostic)
        expect(inferred).toBeCloseTo(diagnostic.state.spiralRadius, 6)
      }
      recordRadius(threshold)
      for (let index = 1; index <= 130; index += 1) {
        const decision = harness.step({
          time: 0.25 + index * 0.25,
          dt: 0.25,
          position: { x: 0.5, y: 0.5 },
          concentration: 0.4,
          hit: true,
          wind: ZERO,
        })
        expect(decision.phase).toBe('CONTRACTING SPIRAL')
        recordRadius(decision)
      }
      const diagnostic = readZigzagSpiralDiagnostic(
        harness.controller as ZigzagSpiralController,
      )
      return {
        trace: harness.trace,
        harness,
        below,
        threshold,
        radii,
        diagnosticRadii,
        diagnosticCenters,
        diagnosticTimeline,
        diagnostic,
      }
    }

    const result = expectDeterministicAndSourceBlind(run)
    expect(result.below.phase).toBe('BROAD ZIGZAG ACQUISITION')
    expect(result.threshold.phase).toBe('CONTRACTING SPIRAL')
    expect(result.diagnostic).toMatchObject({
      schemaVersion: BASELINE_REPLAY_DIAGNOSTIC_SCHEMA_VERSION,
      access: 'diagnostic-read-only',
      evidenceLabel: 'development-behavior-only',
      algorithmId: 'zigzag-spiral',
      state: { refining: true },
    })
    expect(result.radii[0]).toBeCloseTo(0.13 - 0.25 * 0.0038, 6)
    expect(result.diagnosticRadii).toHaveLength(result.radii.length)
    for (let index = 1; index < result.radii.length; index += 1) {
      expect(result.radii[index]!).toBeLessThanOrEqual(result.radii[index - 1]! + 1e-12)
      expect(result.radii[index]!).toBeGreaterThanOrEqual(0.018 - 1e-6)
    }
    expect(result.radii.at(-1)).toBeCloseTo(0.018, 6)
    expect(result.diagnosticRadii.at(-1)).toBeCloseTo(0.018, 12)
    expect(result.diagnosticCenters.every(
      (center) => center?.x === 0.5 && center.y === 0.5,
    )).toBe(true)

    const resetHarness = new SourceBlindReplayHarness(createZigzagSpiralController, {
      controllerSeed: 51,
      observationModelSeed: OBSERVATION_MODEL_SEED,
      robotStart: { x: 0.4, y: 0.4 },
    })
    resetHarness.step({
      time: 0,
      dt: 0.25,
      position: { x: 0.4, y: 0.4 },
      concentration: 0.58,
      hit: true,
      wind: ZERO,
    })
    const beforeReset = readZigzagSpiralDiagnostic(
      resetHarness.controller as ZigzagSpiralController,
    )
    const detachedBeforeReset = readZigzagSpiralDiagnostic(
      resetHarness.controller as ZigzagSpiralController,
    )
    if (detachedBeforeReset.state.spiralCenter) {
      detachedBeforeReset.state.spiralCenter.x = 999
    }
    expect(readZigzagSpiralDiagnostic(
      resetHarness.controller as ZigzagSpiralController,
    ).state.spiralCenter).toEqual(beforeReset.state.spiralCenter)
    resetHarness.step({
      time: 0.75,
      dt: 0.25,
      position: { x: 0.46, y: 0.4 },
      concentration: 0.8,
      hit: true,
      wind: ZERO,
    })
    const afterReset = readZigzagSpiralDiagnostic(
      resetHarness.controller as ZigzagSpiralController,
    )
    expect(beforeReset.state.spiralCenter).toEqual({ x: 0.4, y: 0.4 })
    expect(afterReset.state.spiralCenter?.x).toBeCloseTo(0.46, 12)
    expect(afterReset.state.spiralCenter?.y).toBeCloseTo(0.4, 12)
    expect(afterReset.state.spiralRadius).toBeCloseTo(0.11 - 0.25 * 0.0038, 12)

    // Reset consumes one draw for the coarse-path starting side, then one for angle.
    const initialAngle = -Math.PI + 2 * Math.PI * seededUniformAt(51 ^ 0x2192_5a91, 1)
    let referenceRadius = 0.13
    let referenceAngle = initialAngle
    const expectedDiagnosticTimeline = result.diagnosticTimeline.map((_entry, index) => {
      referenceRadius = Math.max(0.018, referenceRadius - 0.25 * 0.0038)
      referenceAngle += 0.25 * 1.75
      return {
        refining: true,
        spiralRadius: referenceRadius,
        spiralCenter: { x: 0.5, y: 0.5 },
        spiralAngle: referenceAngle,
        refinementStartedAt: 0.25,
        sequence: index,
      }
    })
    const diagnosticStateVector = (states: ReadonlyArray<{
      refining: boolean
      spiralRadius: number
      spiralCenter: Vec2 | null
      spiralAngle: number
      refinementStartedAt: number
    }>) => states.flatMap((state) => [
      state.refining ? 1 : 0,
      state.spiralRadius,
      state.spiralCenter?.x ?? -1,
      state.spiralCenter?.y ?? -1,
      state.spiralAngle,
      state.refinementStartedAt,
    ])
    const observedDiagnosticStates = result.diagnosticTimeline.map((entry) => entry.state)
    const observedResetStates = [beforeReset.state, afterReset.state]
    const expectedResetStates = [
      {
        refining: true,
        spiralRadius: 0.13 - 0.25 * 0.0038,
        spiralCenter: { x: 0.4, y: 0.4 },
        spiralAngle: initialAngle + 0.25 * 1.75,
        refinementStartedAt: 0,
      },
      {
        refining: true,
        spiralRadius: 0.11 - 0.25 * 0.0038,
        spiralCenter: { x: 0.46, y: 0.4 },
        spiralAngle: initialAngle + 2 * 0.25 * 1.75,
        refinementStartedAt: 0,
      },
    ]
    const recorder = createFixtureRecorder('Z2', 'zigzag-spiral', result, 'black-box+diagnostic')
    recordPrimaryExecution(recorder, result)
    recordDeterminismAndTruthPeers(recorder, result, 'Z2')
    recordSubtrace(recorder, 'meaningful-improvement-centre-reset', {
      trace: resetHarness.trace,
      harness: resetHarness,
    })
    recorder.diagnostic('versioned-fixed-centre-spiral-timeline', result.diagnosticTimeline)
    recorder.diagnostic('versioned-centre-reset-snapshots', [beforeReset, afterReset])
    recorder.reference('independent-refinement-contraction-and-reset-reference', {
      threshold: 0.58,
      belowThreshold: 0.579999,
      initialAngle,
      fixedCentreTimeline: expectedDiagnosticTimeline,
      centreResetStates: expectedResetStates,
    })
    recorder.nonNumeric({
      id: 'Z2-01',
      passed: result.below.phase === 'BROAD ZIGZAG ACQUISITION' &&
        result.threshold.phase === 'CONTRACTING SPIRAL',
      accessLevel: 'black-box',
      comparison: 'threshold-boundary',
    })
    recorder.numeric({
      id: 'Z2-02',
      actual: result.radii,
      expected: expectedDiagnosticTimeline.map((state) => state.spiralRadius),
      tolerance: 1e-6,
      quantity: 'target-to-estimate-distance',
      accessLevel: 'black-box',
      comparison: 'radius-trajectory',
    })
    recorder.numeric({
      id: 'Z2-03',
      actual: diagnosticStateVector([...observedDiagnosticStates, ...observedResetStates]),
      expected: diagnosticStateVector([...expectedDiagnosticTimeline, ...expectedResetStates]),
      tolerance: 1e-12,
      quantity: 'spiral-state-residual',
      accessLevel: 'diagnostic',
      comparison: 'diagnostic-state-vector',
    })
    recorder.finish()
  })

  it('[Z3] reacquires after 18 seconds and needs sustained supported refinement before declaration', () => {
    // Current development behaviour uses a strict `elapsed > 18` comparison:
    // at exactly 18 s it remains refining and the next one-second sample reacquires.
    const runReacquisition = (heldOutSource?: Vec2) => {
      const harness = new SourceBlindReplayHarness(createZigzagSpiralController, {
        controllerSeed: 61,
        observationModelSeed: OBSERVATION_MODEL_SEED,
        robotStart: DEFAULT_START,
        heldOutSource,
      })
      const first = harness.step({
        time: 0,
        dt: 1,
        position: DEFAULT_START,
        concentration: 0.8,
        hit: true,
        wind: ZERO,
      })
      let atEighteen: AlgorithmDecision | undefined
      let afterEighteen: AlgorithmDecision | undefined
      for (let time = 1; time <= 19; time += 1) {
        const decision = harness.step({
          time,
          dt: 1,
          position: DEFAULT_START,
          concentration: 0.1,
          hit: false,
          wind: ZERO,
        })
        if (time === 18) atEighteen = decision
        if (time === 19) afterEighteen = decision
      }
      return { trace: harness.trace, harness, first, atEighteen, afterEighteen }
    }
    const runStable = (heldOutSource?: Vec2) => {
      const harness = new SourceBlindReplayHarness(createZigzagSpiralController, {
        controllerSeed: 61,
        observationModelSeed: OBSERVATION_MODEL_SEED,
        robotStart: DEFAULT_START,
        heldOutSource,
      })
      let terminalTime: number | undefined
      let firstRadiusAtOrBelowGate: number | undefined
      let firstDecision: AlgorithmDecision | undefined
      for (let time = 0; time <= 35; time += 1) {
        const isCore = time % 2 === 0
        const decision = harness.step({
          time,
          dt: 1,
          position: isCore ? { x: 0.5, y: 0.5 } : { x: 0.58, y: 0.5 },
          concentration: isCore ? 0.9 : 0.3,
          hit: true,
          wind: { x: 0.7, y: 0.4 },
        })
        firstDecision ??= decision
        if (!decision.nativeTerminated && decision.debug?.target && decision.estimate) {
          const inferredRadius = distance(decision.debug.target, decision.estimate)
          if (inferredRadius <= 0.045 + 1e-6 && firstRadiusAtOrBelowGate === undefined) {
            firstRadiusAtOrBelowGate = time
          }
        }
        if (decision.nativeTerminated) {
          terminalTime = time
          break
        }
      }
      return {
        trace: harness.trace,
        harness,
        firstDecision,
        firstRadiusAtOrBelowGate,
        terminalTime,
      }
    }
    const runUnsupported = () => {
      const harness = new SourceBlindReplayHarness(createZigzagSpiralController, {
        controllerSeed: 61,
        observationModelSeed: OBSERVATION_MODEL_SEED,
        robotStart: DEFAULT_START,
      })
      let declared = false
      for (let time = 0; time <= 35; time += 1) {
        const decision = harness.step({
          time,
          dt: 1,
          position: DEFAULT_START,
          concentration: 0.9,
          hit: true,
          wind: ZERO,
        })
        declared ||= decision.nativeTerminated === true
      }
      return { trace: harness.trace, harness, declared }
    }

    const reacquisition = expectDeterministicAndSourceBlind(runReacquisition)
    const stableTruth = { x: 0.5, y: 0.5 }
    const stable = runStable(stableTruth)
    const unsupported = runUnsupported()
    expect(reacquisition.first.phase).toBe('CONTRACTING SPIRAL')
    expect(reacquisition.first.nativeTerminated).not.toBe(true)
    expect(reacquisition.atEighteen?.phase).toBe('CONTRACTING SPIRAL')
    expect(reacquisition.afterEighteen?.phase).toBe('BROAD ZIGZAG REACQUISITION')
    expect(stable.firstDecision?.nativeTerminated).not.toBe(true)
    expect(stable.firstRadiusAtOrBelowGate).toBeDefined()
    expect(stable.terminalTime).toBeDefined()
    expect(stable.terminalTime!).toBeGreaterThanOrEqual(stable.firstRadiusAtOrBelowGate! + 2)
    expect(stable.trace.frames.at(-1)?.decision.phase).toBe('STABLE PEAK DECLARED')
    expect(unsupported.declared).toBe(false)

    const stableTerminal = stable.trace.frames.at(-1)!.decision
    const recorder = createFixtureRecorder('Z3', 'zigzag-spiral', reacquisition)
    recordPrimaryExecution(recorder, reacquisition)
    recordDeterminismAndTruthPeers(recorder, reacquisition, 'Z3')
    recordSubtrace(recorder, 'supported-declaration-trace', stable)
    recordSubtrace(recorder, 'unsupported-core-only-trace', unsupported)
    recorder.heldOutTruthRecord({
      truthId: 'Z3-truth-supported-present',
      truthClass: 'source-present',
      source: stableTruth,
      prespecifiedBasis: 'Supported core/ring trace is centred on the prespecified point (0.5,0.5).',
    })
    recorder.evaluatorCase({
      caseId: 'COM06-Z3-terminal-01',
      assertionId: 'COM-06',
      role: 'held-out-terminal-evaluation',
      terminalEndpoint: 'supported-declaration-trace',
      truthId: 'Z3-truth-supported-present',
      localizationThreshold: 0.05,
    })
    recorder.reference('independent-strict-reacquisition-and-declaration-gate-reference', {
      strictNoHitBoundarySeconds: 18,
      phaseAtExactly18Seconds: 'CONTRACTING SPIRAL',
      phaseAtFirstStepAfter18Seconds: 'BROAD ZIGZAG REACQUISITION',
      oneHighSampleMayTerminate: false,
      supportedFirstRadiusGateTime: stable.firstRadiusAtOrBelowGate,
      minimumEvidenceStepsAtDt1: 3,
      expectedTerminalDirection: ZERO,
    })
    recorder.nonNumeric({
      id: 'Z3-01',
      passed: reacquisition.atEighteen?.phase === 'CONTRACTING SPIRAL' &&
        reacquisition.afterEighteen?.phase === 'BROAD ZIGZAG REACQUISITION',
      comparison: 'strict-time-boundary',
    })
    recorder.nonNumeric({
      id: 'Z3-02',
      passed: stable.firstDecision?.nativeTerminated !== true &&
        stable.firstRadiusAtOrBelowGate !== undefined &&
        stable.terminalTime !== undefined &&
        stable.terminalTime >= stable.firstRadiusAtOrBelowGate + 2 &&
        stableTerminal.phase === 'STABLE PEAK DECLARED' &&
        !unsupported.declared,
      comparison: 'gate-conjunction',
      details: {
        firstRadiusAtOrBelowGate: stable.firstRadiusAtOrBelowGate,
        terminalTime: stable.terminalTime,
      },
    })
    recorder.numeric({
      id: 'Z3-03',
      actual: [stableTerminal.direction.x, stableTerminal.direction.y],
      expected: [0, 0],
      tolerance: 1e-12,
      quantity: 'direction-norm',
      comparison: 'terminal-direction',
    })
    recorder.finish()
  })
})
