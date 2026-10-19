import { describe, expect, it } from 'vitest'
import { InfotaxisController } from '../src/sim/algorithms/infotaxis'
import { PmfsController } from '../src/sim/algorithms/pmfs'
import { SmcKlController } from '../src/sim/algorithms/smc'
import { createDefaultConfig } from '../src/sim/config'
import { createScenario } from '../src/sim/scenarios'
import type {
  AlgorithmDecision,
  AlgorithmEnvironment,
  AlgorithmStepInput,
  Measurement,
  Observation,
  Vec2,
} from '../src/sim/types'
import {
  BASELINE_REPLAY_DIAGNOSTIC_SCHEMA_VERSION,
  readInfotaxisDiagnostic,
  readPmfsDiagnostic,
  readSmcKlDiagnostic,
  type DiagnosticParticle,
  type DiagnosticWeightedCell,
} from './baseline-replay-diagnostics'
import {
  ReplayFixtureRecorder,
  type ReplayAccessLevel,
  type ReplayEnvironmentFunctionContracts,
} from './baseline-replay-capture'
import {
  independentlyReplaySmcHitAndResample,
  independentlyScorePmfsActions,
} from './baseline-replay-reference-kernels'

type RateOracle = (candidateSource: Vec2, samplePoint: Vec2, time: number) => number
type BlockOracle = (point: Vec2, clearance: number) => boolean

const distance = (first: Vec2, second: Vec2) =>
  Math.hypot(first.x - second.x, first.y - second.y)

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value))

const makeEnvironment = (options: {
  controllerSeed?: number
  rate?: RateOracle
  blocked?: BlockOracle
  maxSpeed?: number
} = {}): AlgorithmEnvironment => {
  const config = createDefaultConfig('infotaxis', 'open')
  const scenario = createScenario('open', 17, config)
  const { source: _privateSource, targetStatus: _privateStatus, ...publicScenario } = scenario
  const blocked: BlockOracle = (point, clearance) =>
    point.x < clearance ||
    point.x > 1 - clearance ||
    point.y < clearance ||
    point.y > 1 - clearance ||
    Boolean(options.blocked?.(point, clearance))
  return {
    scenario: publicScenario,
    controllerSeed: options.controllerSeed ?? 91,
    observationModelVersion: 'baseline-replay-test-oracle-v1',
    observationModelSeed: 701,
    maxSpeed: options.maxSpeed ?? 0.05,
    activeSniffEnabled: false,
    activeSniffCycleSeconds: 0.75,
    activeSniffReach: 0.065,
    sensorNoise: 0,
    isBlocked: (point, clearance = 0) => blocked(point, clearance),
    windAt: () => ({ x: 1, y: 0 }),
    expectedHitRate: options.rate ?? (() => 0.2),
    safeDirection: (_from, desired) => ({ ...desired }),
    terrainMobilityScale: () => 1,
    horizontalReachForSurfaceDistance: (_direction, surfaceDistance) => surfaceDistance,
  }
}

const observation = (
  time: number,
  position: Vec2,
  hit: boolean,
  concentration = hit ? 0.35 : 0.01,
  wind: Vec2 = { x: 1, y: 0 },
): Observation => ({
  time,
  position: { ...position },
  concentration,
  hit,
  wind: { ...wind },
  valid: true,
  sampleMode: 'passive',
})

const fallbackMeasurement = (time: number, position: Vec2): Observation =>
  observation(time, position, false, 0)

const stepInput = (options: {
  time: number
  position?: Vec2
  observations?: readonly Observation[]
  measurement?: Measurement
  heading?: number
  dt?: number
}): AlgorithmStepInput => {
  const position = options.position ?? { x: 0.5, y: 0.5 }
  const observations = options.observations ?? []
  const latest = observations.at(-1)
  return {
    time: options.time,
    dt: options.dt ?? 0.25,
    position: { ...position },
    heading: options.heading ?? 0,
    measurement: options.measurement ?? latest ?? fallbackMeasurement(options.time, position),
    observations,
    distance: 0,
  }
}

const expectPointClose = (actual: Vec2 | null | undefined, expected: Vec2, digits = 10) => {
  expect(actual).toBeTruthy()
  expect(actual?.x).toBeCloseTo(expected.x, digits)
  expect(actual?.y).toBeCloseTo(expected.y, digits)
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

const effectiveSampleSize = (weights: readonly number[]) =>
  1 / weights.reduce((total, weight) => total + weight * weight, 0)

const binaryEntropy = (probability: number) => {
  const value = clamp(probability, 1e-6, 1 - 1e-6)
  return -value * Math.log(value) - (1 - value) * Math.log(1 - value)
}

const percentile = (values: readonly number[], quantile: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const index = clamp(quantile, 0, 1) * (sorted.length - 1)
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  const lowerValue = sorted[lower] ?? 0
  const upperValue = sorted[upper] ?? lowerValue
  return lowerValue + (upperValue - lowerValue) * (index - lower)
}

const maximumAbsoluteError = (actual: readonly number[], expected: readonly number[]) =>
  actual.reduce(
    (maximum, value, index) => Math.max(maximum, Math.abs(value - (expected[index] ?? NaN))),
    0,
  )

const poissonHitProbability = (rate: number) =>
  clamp(1 - Math.exp(-Math.max(0, Number.isFinite(rate) ? rate : 0)), 0.01, 0.99)

const smcHitProbability = (particle: DiagnosticParticle, rate: number) =>
  clamp(1 - Math.exp(-Math.max(0, rate) * particle.strength), 1e-6, 1 - 1e-6)

const weightedMean = (particles: readonly DiagnosticParticle[]): Vec2 => ({
  x: particles.reduce((value, particle) => value + particle.x * particle.weight, 0),
  y: particles.reduce((value, particle) => value + particle.y * particle.weight, 0),
})

const finiteDecision = (decision: AlgorithmDecision) =>
  [decision.direction.x, decision.direction.y, decision.confidence].every(Number.isFinite)

type RecorderContractOptions = {
  rateId: string
  rateEquation: string
  rateParameters?: unknown
  blockedId?: string
  blockedParameters?: unknown
}

const functionContracts = (
  options: RecorderContractOptions,
): ReplayEnvironmentFunctionContracts => ({
  isBlocked: {
    id: options.blockedId ?? 'unit-domain-boundary-v1',
    equation: 'Boundary predicate, optionally OR-composed with the named deterministic mask.',
    ...(options.blockedParameters === undefined
      ? {}
      : { parameters: options.blockedParameters }),
  },
  windAt: {
    id: 'constant-positive-x-wind-v1',
    equation: 'windAt(point,time) = (1,0)',
    parameters: { x: 1, y: 0 },
  },
  expectedHitRate: {
    id: options.rateId,
    equation: options.rateEquation,
    ...(options.rateParameters === undefined ? {} : { parameters: options.rateParameters }),
  },
  safeDirection: {
    id: 'identity-safe-direction-v1',
    equation: 'safeDirection(from,desired) = copy(desired)',
  },
  terrainMobilityScale: {
    id: 'flat-unit-mobility-v1',
    equation: 'terrainMobilityScale(direction) = 1',
  },
  horizontalReachForSurfaceDistance: {
    id: 'flat-identity-reach-v1',
    equation: 'horizontalReachForSurfaceDistance(direction,distance) = distance',
  },
})

const fixtureRecorder = (options: {
  fixtureId: 'I1' | 'I2' | 'I3' | 'M1' | 'M2' | 'M3' | 'P1' | 'P2' | 'P3'
  algorithmId: 'infotaxis' | 'smc-kl' | 'pmfs'
  environment: AlgorithmEnvironment
  contracts: ReplayEnvironmentFunctionContracts
  accessLevel: ReplayAccessLevel
  notes?: string[]
}) => new ReplayFixtureRecorder({
  fixtureId: options.fixtureId,
  algorithmId: options.algorithmId,
  accessLevel: options.accessLevel,
  controllerSeed: options.environment.controllerSeed,
  environment: options.environment,
  functionContracts: options.contracts,
  observationModel: {
    id: options.environment.observationModelVersion,
    usesRng: false,
    seed: null,
    controllerExposedSeed: options.environment.observationModelSeed,
    seedUsed: false,
    equation: 'Deterministic seedless fixture oracle identified by expectedHitRate function contract.',
    parameters: {
      expectedHitRateContractId: options.contracts.expectedHitRate.id,
      controllerInterfaceSeedRole: 'declared-but-unused-by-seedless-fixture-oracle',
    },
  },
  evidenceTier: 'development-behavior',
  notes: [
    'Local implementation contract only; no canonical-algorithm fidelity claim.',
    ...(options.notes ?? []),
  ],
})

const declareBayesianDeterminismAndTruthCases = (options: {
  capture: ReplayFixtureRecorder
  fixtureId: 'I1' | 'I2' | 'I3' | 'M1' | 'M2' | 'M3' | 'P1' | 'P2' | 'P3'
  duplicateEndpoint: string
  primaryTruth?: Vec2
  peerTruth?: Vec2
}) => {
  const primaryTruth = options.primaryTruth ?? { x: 0.17, y: 0.73 }
  const peerTruth = options.peerTruth ?? { x: 0.83, y: 0.19 }
  const primaryTruthId = `${options.fixtureId}-truth-primary-present`
  const peerTruthId = `${options.fixtureId}-truth-peer-present`
  options.capture.heldOutTruthRecord({
    truthId: primaryTruthId,
    truthClass: 'source-present',
    source: primaryTruth,
    prespecifiedBasis: 'Evaluator-only truth excluded from the source-blind controller environment.',
  })
  options.capture.heldOutTruthRecord({
    truthId: peerTruthId,
    truthClass: 'source-present',
    source: peerTruth,
    prespecifiedBasis: 'Distinct evaluator-only truth under an identical visible replay.',
  })
  options.capture.evaluatorCase({
    caseId: `COM03-${options.fixtureId}-01`,
    assertionId: 'COM-03',
    role: 'held-out-truth-pair',
    primaryEndpoint: 'primary',
    peerEndpoint: options.duplicateEndpoint,
    primaryResetOrdinal: 1,
    peerResetOrdinal: 2,
    primaryTruthId,
    peerTruthId,
  })
  options.capture.evaluatorCase({
    caseId: `COM04-${options.fixtureId}-01`,
    assertionId: 'COM-04',
    role: 'fresh-reset-duplicate',
    primaryEndpoint: 'primary',
    peerEndpoint: options.duplicateEndpoint,
    primaryResetOrdinal: 1,
    peerResetOrdinal: 2,
    freshControllerInstances: true,
  })
}

const referencePmfsHitMapUpdate = (options: {
  previous: readonly number[]
  environment: AlgorithmEnvironment
  position: Vec2
  wind: Vec2
  hit: boolean
}) => {
  const windLength = Math.hypot(options.wind.x, options.wind.y)
  const wind = windLength > 1e-9
    ? { x: options.wind.x / windLength, y: options.wind.y / windLength }
    : { x: -1, y: 0 }
  const cross = { x: -wind.y, y: wind.x }
  const output = new Array<number>(18 * 18).fill(0)
  for (let gy = 0; gy < 18; gy += 1) {
    for (let gx = 0; gx < 18; gx += 1) {
      const index = gy * 18 + gx
      const point = { x: (gx + 0.5) / 18, y: (gy + 0.5) / 18 }
      if (options.environment.isBlocked(point, 0.002)) {
        output[index] = 0
        continue
      }
      const dx = point.x - options.position.x
      const dy = point.y - options.position.y
      const along = dx * wind.x + dy * wind.y
      const lateral = Math.abs(dx * cross.x + dy * cross.y)
      const influence =
        Math.exp(-(lateral * lateral) / (2 * 0.075 ** 2)) *
        Math.exp(-Math.abs(along) / 0.19) *
        (along > -0.04 ? 1 : 0.45)
      const prior = options.previous[index] ?? 0.08
      const evidence = options.hit ? 0.83 : 0.025
      output[index] = clamp(
        prior * (1 - influence * 0.24) + evidence * influence * 0.24,
        0.002,
        0.998,
      )
    }
  }
  return output
}

const weightedCellRadius = (cells: readonly DiagnosticWeightedCell[]) => {
  const total = sum(cells.map((cell) => cell.weight))
  const center = {
    x: sum(cells.map((cell) => cell.x * cell.weight)) / total,
    y: sum(cells.map((cell) => cell.y * cell.weight)) / total,
  }
  return Math.sqrt(
    sum(cells.map((cell) => cell.weight * distance(cell, center) ** 2)) / total,
  )
}

describe('Bayesian baseline development-behaviour replay fixtures', () => {
  it('[I1] separates the black-box uniform grid from a non-intervening raw-prior diagnostic', () => {
    const environment = makeEnvironment({ rate: () => 0.37 })
    const contracts = functionContracts({
      rateId: 'constant-rate-0.37-v1',
      rateEquation: 'expectedHitRate(candidate,sample,time) = 0.37',
      rateParameters: { rate: 0.37 },
    })
    const capture = fixtureRecorder({
      fixtureId: 'I1',
      algorithmId: 'infotaxis',
      environment,
      contracts,
      accessLevel: 'black-box+diagnostic',
    })
    const controller = new InfotaxisController()
    const untouchedPeer = new InfotaxisController()
    controller.reset(environment)
    untouchedPeer.reset(environment)

    const prior = readInfotaxisDiagnostic(controller)
    expect(prior).toMatchObject({
      schemaVersion: BASELINE_REPLAY_DIAGNOSTIC_SCHEMA_VERSION,
      access: 'diagnostic-read-only',
      evidenceLabel: 'development-behavior-only',
      algorithmId: 'infotaxis',
    })
    expect(prior.state.cells).toHaveLength(23 * 15)
    expect(sum(prior.state.rawPosterior)).toBeCloseTo(1, 12)
    const feasibleWeights = prior.state.cells.map(
      (cell) => prior.state.rawPosterior[cell.index] ?? NaN,
    )
    expect(new Set(feasibleWeights)).toHaveLength(1)

    // A caller may mutate its deep copy without changing controller state.
    const originalFirstWeight = prior.state.rawPosterior[0]
    const originalFirstX = prior.state.cells[0]?.point.x
    prior.state.rawPosterior[0] = 999
    if (prior.state.cells[0]) prior.state.cells[0].point.x = 999
    const reread = readInfotaxisDiagnostic(controller)
    const deepCopyPreserved =
      reread.state.rawPosterior[0] === originalFirstWeight &&
      reread.state.cells[0]?.point.x === originalFirstX
    const truthExcluded = !/"source"|"targetStatus"/.test(JSON.stringify(reread))
    expect(deepCopyPreserved).toBe(true)
    expect(truthExcluded).toBe(true)

    const input = stepInput({ time: 0, position: { x: 0.5, y: 0.5 } })
    const decision = capture.step(controller, input, 'constant-rate-unmasked-first-valid-sample')
    const peerDecision = JSON.parse(
      JSON.stringify(untouchedPeer.step(input)),
    ) as AlgorithmDecision
    capture.recordCompletedTrace({
      label: 'same-seed-unmasked-peer',
      environment,
      functionContracts: contracts,
      frames: [{ input, decision: peerDecision }],
    })
    declareBayesianDeterminismAndTruthCases({
      capture,
      fixtureId: 'I1',
      duplicateEndpoint: 'same-seed-unmasked-peer',
    })
    // Reading the diagnostic cannot alter controller control flow.
    expect(decision).toEqual(peerDecision)
    const publicDecisionUnchanged = JSON.stringify(decision) === JSON.stringify(peerDecision)

    // Black-box evidence: the public grid is only maximum-normalized.
    expect(decision.debug?.grid?.values).toHaveLength(23 * 15)
    expect(decision.debug?.grid?.values.every((value) => value === 1)).toBe(true)

    const maskedEnvironment = makeEnvironment({
      rate: () => 0.37,
      blocked: (point) => point.x < 0.12 && point.y < 0.12,
    })
    const maskedContracts = functionContracts({
      rateId: 'constant-rate-0.37-v1',
      rateEquation: 'expectedHitRate(candidate,sample,time) = 0.37',
      rateParameters: { rate: 0.37 },
      blockedId: 'unit-boundary-plus-lower-left-mask-v1',
      blockedParameters: { maskedWhen: 'x < 0.12 and y < 0.12' },
    })
    const maskedController = new InfotaxisController()
    maskedController.reset(maskedEnvironment)
    const maskedDecision = maskedController.step(input)
    capture.recordCompletedTrace({
      label: 'explicit-blocked-cell-mask',
      environment: maskedEnvironment,
      functionContracts: maskedContracts,
      frames: [{ input, decision: maskedDecision }],
    })
    const maskedDiagnostic = readInfotaxisDiagnostic(maskedController)
    const feasibleIndices = new Set(maskedDiagnostic.state.cells.map((cell) => cell.index))
    const expectedMaskedPublic = Array.from(
      { length: 23 * 15 },
      (_, index) => feasibleIndices.has(index) ? 1 : 0,
    )
    const expectedMaskedRaw = expectedMaskedPublic.map(
      (value) => value === 0 ? 0 : 1 / feasibleIndices.size,
    )
    expect(expectedMaskedPublic.some((value) => value === 0)).toBe(true)
    expect(maskedDecision.debug?.grid?.values).toEqual(expectedMaskedPublic)

    const primaryDiagnostic = readInfotaxisDiagnostic(controller)
    capture.diagnostic('unmasked-prior-and-first-update', primaryDiagnostic)
    capture.diagnostic('masked-prior-and-first-update', maskedDiagnostic)
    capture.reference('independent-grid-prior-reference', {
      dimensions: { width: 23, height: 15, count: 345 },
      unmaskedPublic: new Array<number>(23 * 15).fill(1),
      maskedPublic: expectedMaskedPublic,
      maskedRaw: expectedMaskedRaw,
      maskedFeasibleCount: feasibleIndices.size,
    })
    const publicGrid = decision.debug?.grid
    capture.nonNumeric({
      id: 'I1-01',
      passed:
        publicGrid?.width === 23 &&
        publicGrid.height === 15 &&
        publicGrid.values.length === 345 &&
        publicGrid.values.every((value) => Number.isFinite(value) && value >= 0 && value === 1),
      accessLevel: 'black-box',
      comparison: 'public-grid-shape-and-scale',
      details: { width: publicGrid?.width, height: publicGrid?.height, valueCount: publicGrid?.values.length },
    })
    capture.nonNumeric({
      id: 'I1-02',
      passed: deepCopyPreserved && truthExcluded && publicDecisionUnchanged,
      accessLevel: 'black-box+diagnostic',
      comparison: 'adapter-nonintervention',
      details: { deepCopyPreserved, truthExcluded, publicDecisionUnchanged },
    })
    capture.numeric({
      id: 'I1-03',
      actual: [...primaryDiagnostic.state.rawPosterior, sum(primaryDiagnostic.state.rawPosterior)],
      expected: [...new Array<number>(345).fill(1 / 345), 1],
      tolerance: 1e-10,
      quantity: 'raw-prior-residual',
      accessLevel: 'diagnostic',
      comparison: 'raw-prior-vector',
    })
    capture.finish()
  })

  it('[I2] replays the app likelihood and one-step information score against independent arithmetic', () => {
    const rate: RateOracle = (candidate, sample) => {
      const separationSquared =
        (candidate.x - sample.x) ** 2 + (candidate.y - sample.y) ** 2
      return 0.025 + 2.8 * Math.exp(-separationSquared / 0.075)
    }
    const environment = makeEnvironment({ rate })
    const contracts = functionContracts({
      rateId: 'i2-radial-exponential-rate-v1',
      rateEquation: '0.025 + 2.8 * exp(-||candidate-sample||^2 / 0.075)',
      rateParameters: { offset: 0.025, amplitude: 2.8, squaredLengthScale: 0.075 },
    })
    const capture = fixtureRecorder({
      fixtureId: 'I2',
      algorithmId: 'infotaxis',
      environment,
      contracts,
      accessLevel: 'black-box+diagnostic',
    })
    const controller = new InfotaxisController()
    controller.reset(environment)
    const before = readInfotaxisDiagnostic(controller).state
    const position = { x: 0.46, y: 0.53 }
    const hit = observation(1, position, true, 0.4)
    const hitInput = stepInput({
      time: 1,
      position,
      observations: [hit],
      measurement: hit,
    })
    const decision = capture.step(controller, hitInput, 'one-hit-full-grid-update')
    const afterEnvelope = readInfotaxisDiagnostic(controller)
    const after = afterEnvelope.state

    const unnormalized = new Array<number>(23 * 15).fill(0)
    let evidence = 0
    for (const cell of before.cells) {
      const likelihood = poissonHitProbability(rate(cell.point, position, 1)) ** 0.28
      const value = (before.rawPosterior[cell.index] ?? 0) * likelihood
      unnormalized[cell.index] = value
      evidence += value
    }
    const uniform = 1 / before.cells.length
    const expectedPosterior = new Array<number>(23 * 15).fill(0)
    for (const cell of before.cells) {
      expectedPosterior[cell.index] =
        ((unnormalized[cell.index] ?? 0) / evidence) * (1 - 1e-6) + uniform * 1e-6
    }
    expect(maximumAbsoluteError(after.rawPosterior, expectedPosterior)).toBeLessThan(1e-12)
    expect(sum(after.rawPosterior)).toBeCloseTo(1, 12)

    // Black-box evidence: independently maximum-normalize the public grid.
    const maximum = Math.max(...expectedPosterior)
    const expectedPublicGrid = expectedPosterior.map((weight) => weight / maximum)
    expect(maximumAbsoluteError(
      decision.debug?.grid?.values ?? [],
      expectedPublicGrid,
    )).toBeLessThan(1e-12)

    // Diagnostic evidence: independently reproduce the app's one-step score.
    const entropy = -sum(after.rawPosterior.map(
      (weight) => weight > 0 ? weight * Math.log(weight) : 0,
    ))
    const expectedEntropy = -sum(expectedPosterior.map(
      (weight) => weight > 0 ? weight * Math.log(weight) : 0,
    ))
    const compassDirections: readonly Vec2[] = [
      { x: 1, y: 0 },
      { x: Math.SQRT1_2, y: Math.SQRT1_2 },
      { x: 0, y: 1 },
      { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
      { x: -1, y: 0 },
      { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
      { x: 0, y: -1 },
      { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
    ]
    const independentTravelDistance = clamp(environment.maxSpeed * 1.6, 0.045, 0.085)
    const expectedCandidates = compassDirections.map((direction) => {
      const length = Math.hypot(direction.x, direction.y)
      return {
        x: position.x + (direction.x / length) * independentTravelDistance,
        y: position.y + (direction.y / length) * independentTravelDistance,
      }
    })
    expect(after.candidates).toEqual(expectedCandidates)
    let expectedBest: { point: Vec2; score: number; gain: number } | null = null
    const candidateScoreReference: Array<{
      point: Vec2
      score: number
      informationGain: number
      predictiveHit: number
    }> = []
    for (const candidate of after.candidates) {
      let predictiveHit = 0
      const hitProbabilities = new Array<number>(after.cells.length)
      after.cells.forEach((cell, index) => {
        const futureTime = 1 + distance(position, candidate) / environment.maxSpeed
        const probability = poissonHitProbability(rate(cell.point, candidate, futureTime))
        hitProbabilities[index] = probability
        predictiveHit += (after.rawPosterior[cell.index] ?? 0) * probability
      })
      predictiveHit = clamp(predictiveHit, 1e-9, 1 - 1e-9)
      let entropyAfterHit = 0
      let entropyAfterMiss = 0
      after.cells.forEach((cell, index) => {
        const prior = after.rawPosterior[cell.index] ?? 0
        const probability = hitProbabilities[index] ?? 0
        const onHit = (prior * probability) / predictiveHit
        const onMiss = (prior * (1 - probability)) / (1 - predictiveHit)
        if (onHit > 0) entropyAfterHit -= onHit * Math.log(onHit)
        if (onMiss > 0) entropyAfterMiss -= onMiss * Math.log(onMiss)
      })
      const gain = Math.max(
        0,
        entropy - (predictiveHit * entropyAfterHit + (1 - predictiveHit) * entropyAfterMiss),
      )
      const closest = after.cells.reduce((incumbent, cell) =>
        distance(cell.point, candidate) < distance(incumbent.point, candidate)
          ? cell
          : incumbent,
      )
      const visited = after.visitSeconds[closest.index] ?? 0
      const travel = distance(position, candidate)
      const score = gain - 0.0005 * (travel / 0.085) - 0.002 * (1 - Math.exp(-visited / 3))
      candidateScoreReference.push({
        point: { ...candidate },
        score,
        informationGain: gain,
        predictiveHit,
      })
      if (expectedBest === null || score > expectedBest.score + 1e-12) {
        expectedBest = { point: candidate, score, gain }
      }
    }
    expect(expectedBest).not.toBeNull()
    expectPointClose(after.plannedTarget, expectedBest?.point ?? position, 12)
    expect(after.lastInformationGain).toBeCloseTo(expectedBest?.gain ?? NaN, 12)

    const missPosition = { x: 0.58, y: 0.41 }
    const miss = observation(2, missPosition, false, 0.02)
    const missInput = stepInput({
      time: 2,
      position: missPosition,
      observations: [hit, miss],
      measurement: miss,
    })
    const missDecision = capture.step(controller, missInput, 'one-miss-following-hit')
    const afterMiss = readInfotaxisDiagnostic(controller).state
    const missUnnormalized = new Array<number>(23 * 15).fill(0)
    let missEvidence = 0
    for (const cell of after.cells) {
      const missProbability = 1 - poissonHitProbability(rate(cell.point, missPosition, 2))
      const value = (after.rawPosterior[cell.index] ?? 0) * missProbability ** 0.28
      missUnnormalized[cell.index] = value
      missEvidence += value
    }
    const expectedAfterMiss = new Array<number>(23 * 15).fill(0)
    for (const cell of after.cells) {
      expectedAfterMiss[cell.index] =
        ((missUnnormalized[cell.index] ?? 0) / missEvidence) * (1 - 1e-6) + uniform * 1e-6
    }
    const missMaximum = Math.max(...expectedAfterMiss)
    const expectedMissPublic = expectedAfterMiss.map((weight) => weight / missMaximum)
    expect(maximumAbsoluteError(afterMiss.rawPosterior, expectedAfterMiss)).toBeLessThan(1e-12)
    expect(maximumAbsoluteError(
      missDecision.debug?.grid?.values ?? [],
      expectedMissPublic,
    )).toBeLessThan(1e-12)

    const duplicate = new InfotaxisController()
    duplicate.reset(environment)
    const duplicateHitDecision = duplicate.step(hitInput)
    const duplicateMissDecision = duplicate.step(missInput)
    capture.recordCompletedTrace({
      label: 'fresh-reset-duplicate',
      environment,
      functionContracts: contracts,
      frames: [
        { input: hitInput, decision: duplicateHitDecision },
        { input: missInput, decision: duplicateMissDecision },
      ],
    })
    expect([duplicateHitDecision, duplicateMissDecision]).toEqual([decision, missDecision])

    const windMutant = new InfotaxisController()
    windMutant.reset(environment)
    const windHit = { ...hit, wind: { x: 0, y: 1 } }
    const windMiss = { ...miss, wind: { x: -1, y: 0 } }
    const windHitInput = stepInput({
      time: 1,
      position,
      observations: [windHit],
      measurement: windHit,
    })
    const windMissInput = stepInput({
      time: 2,
      position: missPosition,
      observations: [windHit, windMiss],
      measurement: windMiss,
    })
    const windHitDecision = windMutant.step(windHitInput)
    const windMissDecision = windMutant.step(windMissInput)
    capture.recordCompletedTrace({
      label: 'changed-measured-wind',
      environment,
      functionContracts: contracts,
      frames: [
        { input: windHitInput, decision: windHitDecision },
        { input: windMissInput, decision: windMissDecision },
      ],
    })
    expect([windHitDecision, windMissDecision]).toEqual([decision, missDecision])
    declareBayesianDeterminismAndTruthCases({
      capture,
      fixtureId: 'I2',
      duplicateEndpoint: 'fresh-reset-duplicate',
    })
    capture.evaluatorCase({
      caseId: 'COM05-I2-measured-wind-01',
      assertionId: 'COM-05',
      role: 'ignored-field-metamorphic',
      primaryEndpoint: 'primary',
      peerEndpoint: 'changed-measured-wind',
      primaryResetOrdinal: 1,
      peerResetOrdinal: 3,
      ignoredField: 'measured-wind',
    })

    capture.diagnostic('after-hit-raw-state', afterEnvelope)
    capture.diagnostic('after-miss-state', readInfotaxisDiagnostic(controller))
    capture.reference('independent-hit-miss-posterior-reference', {
      afterHitRaw: expectedPosterior,
      afterHitPublic: expectedPublicGrid,
      afterMissRaw: expectedAfterMiss,
      afterMissPublic: expectedMissPublic,
      afterHitEntropy: entropy,
      independentlyExpectedEntropy: expectedEntropy,
      independentlyConstructedCandidates: expectedCandidates,
      afterHitCandidateScores: candidateScoreReference,
      afterHitSelected: expectedBest,
    })
    capture.numeric({
      id: 'I2-01',
      actual: decision.debug?.grid?.values ?? [],
      expected: expectedPublicGrid,
      tolerance: 1e-8,
      quantity: 'maximum-normalized-grid-value',
      accessLevel: 'black-box',
      comparison: 'posterior-vector',
    })
    capture.numeric({
      id: 'I2-02',
      actual: [
        decision.debug?.target?.x ?? NaN,
        decision.debug?.target?.y ?? NaN,
        after.lastInformationGain,
      ],
      expected: [
        expectedBest?.point.x ?? NaN,
        expectedBest?.point.y ?? NaN,
        expectedBest?.gain ?? NaN,
      ],
      tolerance: 1e-7,
      quantity: 'score-and-target-residual',
      accessLevel: 'black-box+diagnostic',
      comparison: 'complete-action-reference',
    })
    capture.numeric({
      id: 'I2-03',
      actual: [
        ...after.rawPosterior,
        sum(after.rawPosterior),
        entropy,
        ...after.candidates.flatMap((candidate) => [candidate.x, candidate.y]),
        after.lastInformationGain,
      ],
      expected: [
        ...expectedPosterior,
        1,
        expectedEntropy,
        ...expectedCandidates.flatMap((candidate) => [candidate.x, candidate.y]),
        expectedBest?.gain ?? NaN,
      ],
      tolerance: 1e-7,
      quantity: 'raw-posterior-entropy-score-residual',
      comparison: 'diagnostic-score-vector',
      accessLevel: 'diagnostic',
    })
    capture.finish()
  })

  it('[I3] enforces the app minimum-history gate and reaches one zero-motion terminal transition', () => {
    const center = { x: (17 + 0.5) / 23, y: (7 + 0.5) / 15 }
    const rate: RateOracle = (candidate) => distance(candidate, center) <= 0.022 ? 9 : 1e-8
    const environment = makeEnvironment({ rate })
    const contracts = functionContracts({
      rateId: 'i3-single-cell-convergence-rate-v1',
      rateEquation: 'distance(candidate,center) <= 0.022 ? 9 : 1e-8',
      rateParameters: { center, radius: 0.022, insideRate: 9, outsideRate: 1e-8 },
    })
    const capture = fixtureRecorder({
      fixtureId: 'I3',
      algorithmId: 'infotaxis',
      environment,
      contracts,
      accessLevel: 'black-box',
      notes: ['Fully materialized positive trace; the first 79 frames form the negative history-gate prefix.'],
    })
    const controller = new InfotaxisController()
    controller.reset(environment)
    const observations: Observation[] = []
    const prefixDecisions: AlgorithmDecision[] = []
    let decision: AlgorithmDecision | undefined

    for (let count = 1; count <= 79; count += 1) {
      const item = observation(count * 0.3, center, true, 1.2)
      observations.push(item)
      const input = stepInput({
        time: item.time,
        position: center,
        observations,
        measurement: item,
      })
      decision = capture.step(controller, input, `history-gate-prefix-${count}`)
      prefixDecisions.push(decision)
      expect(decision.nativeTerminated).not.toBe(true)
    }
    expect(prefixDecisions).toHaveLength(79)
    expect(prefixDecisions.every((item) => item.nativeTerminated !== true)).toBe(true)

    let terminalTransitions = 0
    for (let count = 80; count <= 95; count += 1) {
      const item = observation(count * 0.3, center, true, 1.2)
      observations.push(item)
      const input = stepInput({
        time: item.time,
        position: center,
        observations,
        measurement: item,
      })
      const next = capture.step(controller, input, `positive-terminal-trace-${count}`)
      if (next.nativeTerminated && !decision?.nativeTerminated) terminalTransitions += 1
      decision = next
      if (next.nativeTerminated) break
    }

    // Black-box terminal contract.
    expect(terminalTransitions).toBe(1)
    expect(decision).toMatchObject({
      nativeTerminated: true,
      phase: 'POSTERIOR CONVERGED',
      direction: { x: 0, y: 0 },
    })
    const duplicateController = new InfotaxisController()
    duplicateController.reset(environment)
    const duplicateHistory: Observation[] = []
    const duplicateFrames = observations.map((item) => {
      duplicateHistory.push(item)
      const input = stepInput({
        time: item.time,
        position: center,
        observations: [...duplicateHistory],
        measurement: item,
      })
      return { input, decision: duplicateController.step(input) }
    })
    capture.recordCompletedTrace({
      label: 'fresh-reset-duplicate',
      environment,
      functionContracts: contracts,
      frames: duplicateFrames,
    })
    expect(duplicateFrames.at(-1)?.decision).toEqual(decision)
    declareBayesianDeterminismAndTruthCases({
      capture,
      fixtureId: 'I3',
      duplicateEndpoint: 'fresh-reset-duplicate',
      primaryTruth: center,
    })
    capture.evaluatorCase({
      caseId: 'COM06-I3-terminal-01',
      assertionId: 'COM-06',
      role: 'held-out-terminal-evaluation',
      terminalEndpoint: 'primary',
      truthId: 'I3-truth-primary-present',
      localizationThreshold: 0.05,
    })
    capture.reference('independent-stopping-gate-reference', {
      minimumAssimilatedMeasurements: 80,
      minimumHits: 5,
      requiredConvergenceConfirmations: 6,
      expectedTerminalPhase: 'POSTERIOR CONVERGED',
      nonterminalPrefixFrameCount: prefixDecisions.length,
      positiveTraceFrameCount: observations.length,
    })
    capture.nonNumeric({
      id: 'I3-01',
      passed:
        prefixDecisions.length === 79 &&
        prefixDecisions.every((item) => item.nativeTerminated !== true),
      accessLevel: 'black-box',
      comparison: 'negative-terminal',
      details: {
        materializedPrefixFrames: prefixDecisions.length,
        nativeTerminalFrames: prefixDecisions.filter((item) => item.nativeTerminated).length,
      },
    })
    capture.nonNumeric({
      id: 'I3-02',
      passed:
        terminalTransitions === 1 &&
        decision?.nativeTerminated === true &&
        decision.phase === 'POSTERIOR CONVERGED',
      accessLevel: 'black-box',
      comparison: 'terminal-transition-count',
      details: { terminalTransitions, terminalPhase: decision?.phase },
    })
    capture.numeric({
      id: 'I3-03',
      actual: Math.hypot(decision?.direction.x ?? NaN, decision?.direction.y ?? NaN),
      expected: 0,
      tolerance: 1e-12,
      quantity: 'direction-norm',
      accessLevel: 'black-box',
      comparison: 'terminal-direction',
    })
    capture.finish()
  })

  it('[M1] exposes the deterministic public particle prior and seed metamorphic', () => {
    const environment = makeEnvironment({ controllerSeed: 404 })
    const contracts = functionContracts({
      rateId: 'constant-rate-0.2-v1',
      rateEquation: 'expectedHitRate(candidate,sample,time) = 0.2',
      rateParameters: { rate: 0.2 },
    })
    const capture = fixtureRecorder({
      fixtureId: 'M1',
      algorithmId: 'smc-kl',
      environment,
      contracts,
      accessLevel: 'black-box',
      notes: ['Empty observation history is an explicit unit-level production-cadence deviation.'],
    })
    const controller = new SmcKlController()
    const untouchedPeer = new SmcKlController()
    controller.reset(environment)
    untouchedPeer.reset(environment)

    const input = stepInput({ time: 0 })
    const decision = capture.step(controller, input, 'empty-history-first-decision')
    const peerDecision = untouchedPeer.step(input)
    capture.recordCompletedTrace({
      label: 'same-seed-map-peer',
      environment,
      functionContracts: contracts,
      frames: [{ input, decision: peerDecision }],
    })
    declareBayesianDeterminismAndTruthCases({
      capture,
      fixtureId: 'M1',
      duplicateEndpoint: 'same-seed-map-peer',
    })
    expect(decision).toEqual(peerDecision)
    const publicParticles = decision.debug?.particles ?? []
    const peerParticles = peerDecision.debug?.particles ?? []
    expect(publicParticles).toHaveLength(320)
    expect(publicParticles.every((particle) =>
      [particle.x, particle.y, particle.weight, particle.strength].every(Number.isFinite))).toBe(true)
    expect(publicParticles.every((particle) =>
      particle.weight === 1 / 320 &&
      particle.strength !== undefined &&
      particle.strength >= 0.4 &&
      particle.strength < 2.4)).toBe(true)
    expect(sum(publicParticles.map((particle) => particle.weight))).toBeCloseTo(1, 12)
    expect(publicParticles).toEqual(peerParticles)

    const changedSeed = new SmcKlController()
    const changedSeedEnvironment = makeEnvironment({ controllerSeed: 405 })
    changedSeed.reset(changedSeedEnvironment)
    const changedSeedDecision = changedSeed.step(input)
    capture.recordCompletedTrace({
      label: 'controller-seed-405-counterfactual',
      environment: changedSeedEnvironment,
      functionContracts: contracts,
      frames: [{ input, decision: changedSeedDecision }],
    })
    const changedParticles = changedSeedDecision.debug?.particles ?? []
    const seedChanged = changedParticles.some((particle, index) =>
      particle.x !== publicParticles[index]?.x ||
      particle.y !== publicParticles[index]?.y ||
      particle.strength !== publicParticles[index]?.strength)
    expect(seedChanged).toBe(true)

    capture.reference('seeded-prior-contract-reference', {
      particleCount: 320,
      equalWeight: 1 / 320,
      normalizedWeightSum: 1,
      initialStrengthInterval: { minimumInclusive: 0.4, maximumExclusive: 2.4 },
      primaryControllerSeed: 404,
      counterfactualControllerSeed: 405,
    })
    capture.numeric({
      id: 'M1-01',
      actual: [...publicParticles.map((particle) => particle.weight), sum(publicParticles.map((particle) => particle.weight))],
      expected: [...new Array<number>(320).fill(1 / 320), 1],
      tolerance: 1e-10,
      quantity: 'prior-residual',
      accessLevel: 'black-box',
      comparison: 'prior-invariants',
      details: { particleCount: publicParticles.length, initialStrengthInterval: '[0.4,2.4)' },
    })
    const flattenParticles = (particles: typeof publicParticles) => particles.flatMap(
      (particle) => [particle.x, particle.y, particle.weight, particle.strength ?? NaN],
    )
    capture.nonNumeric({
      id: 'M1-02',
      passed: JSON.stringify(flattenParticles(publicParticles)) === JSON.stringify(flattenParticles(peerParticles)),
      accessLevel: 'black-box',
      comparison: 'ordered-particle-exact',
      details: { particleCount: publicParticles.length, scalarCount: flattenParticles(publicParticles).length },
    })
    capture.nonNumeric({
      id: 'M1-03',
      passed: seedChanged,
      comparison: 'seed-metamorphic-inequality',
      accessLevel: 'black-box',
      details: { primaryControllerSeed: 404, counterfactualControllerSeed: 405 },
    })
    capture.finish()
  })

  it('[M2] checks an exact no-resample update and a deterministic, independently detected resample', () => {
    const mildRate: RateOracle = (candidate) => 0.18 + candidate.x * 0.2 + candidate.y * 0.03
    const mildEnvironment = makeEnvironment({ controllerSeed: 512, rate: mildRate })
    const mildContracts = functionContracts({
      rateId: 'm2-mild-affine-rate-v1',
      rateEquation: '0.18 + 0.2*candidate.x + 0.03*candidate.y',
      rateParameters: { intercept: 0.18, xCoefficient: 0.2, yCoefficient: 0.03 },
    })
    const capture = fixtureRecorder({
      fixtureId: 'M2',
      algorithmId: 'smc-kl',
      environment: mildEnvironment,
      contracts: mildContracts,
      accessLevel: 'black-box+diagnostic',
      notes: ['Mild no-resample trace is primary; strong resampling and peer traces are separate reset subtraces.'],
    })
    const mild = new SmcKlController()
    mild.reset(mildEnvironment)
    const mildBefore = readSmcKlDiagnostic(mild).state.particles
    const miss = observation(1, { x: 0.37, y: 0.62 }, false, 0.02)
    const unnormalized = mildBefore.map((particle) => {
      const probability = smcHitProbability(particle, mildRate(particle, miss.position, miss.time))
      return particle.weight * (1 - probability) ** 0.28
    })
    const normalizer = sum(unnormalized)
    const expectedWeights = unnormalized.map((weight) => weight / normalizer)
    expect(effectiveSampleSize(expectedWeights)).toBeGreaterThan(320 * 0.52)
    const mildInput = stepInput({
      time: 1,
      position: miss.position,
      observations: [miss],
      measurement: miss,
    })
    const mildDecision = capture.step(mild, mildInput, 'mild-no-resample-miss-update')
    const mildAfter = readSmcKlDiagnostic(mild).state
    expect(maximumAbsoluteError(
      mildAfter.particles.map((particle) => particle.weight),
      expectedWeights,
    )).toBeLessThan(1e-12)
    mildAfter.particles.forEach((particle, index) => {
      expect(particle.x).toBe(mildBefore[index]?.x)
      expect(particle.y).toBe(mildBefore[index]?.y)
      expect(particle.strength).toBe(mildBefore[index]?.strength)
    })

    const strongRate: RateOracle = (candidate) => candidate.x > 0.82 ? 9 : 1e-9
    const strongEnvironment = makeEnvironment({ controllerSeed: 901, rate: strongRate })
    const strongContracts = functionContracts({
      rateId: 'm2-strong-x-threshold-rate-v1',
      rateEquation: 'candidate.x > 0.82 ? 9 : 1e-9',
      rateParameters: { xThreshold: 0.82, aboveRate: 9, belowRate: 1e-9 },
    })
    const strong = new SmcKlController()
    const peer = new SmcKlController()
    strong.reset(strongEnvironment)
    peer.reset(strongEnvironment)
    const strongBefore = readSmcKlDiagnostic(strong).state.particles
    const hit = observation(1, { x: 0.5, y: 0.5 }, true, 0.4)
    const predictedWeights = strongBefore.map((particle) => {
      const probability = smcHitProbability(particle, strongRate(particle, hit.position, hit.time))
      return particle.weight * probability ** 0.28
    })
    const predictedTotal = sum(predictedWeights)
    const normalizedPreResample = predictedWeights.map((weight) => weight / predictedTotal)
    expect(effectiveSampleSize(normalizedPreResample)).toBeLessThan(320 * 0.52)

    const independentStrongReference = independentlyReplaySmcHitAndResample({
      controllerSeed: strongEnvironment.controllerSeed,
      robotStart: strongEnvironment.scenario.robotStart,
      isBlocked: (point, clearance) => strongEnvironment.isBlocked(point, clearance),
      expectedHitRate: strongRate,
      observation: hit,
    })
    const flattenDiagnosticParticles = (particles: readonly DiagnosticParticle[]) =>
      particles.flatMap((particle) => [
        particle.x,
        particle.y,
        particle.strength,
        particle.weight,
      ])
    expect(maximumAbsoluteError(
      flattenDiagnosticParticles(strongBefore),
      flattenDiagnosticParticles(independentStrongReference.priorParticles),
    )).toBeLessThan(1e-12)
    expect(independentStrongReference.resampleTriggered).toBe(true)

    const input = stepInput({ time: 1, position: hit.position, observations: [hit], measurement: hit })
    const strongDecision = strong.step(input)
    const peerDecision = peer.step(input)
    capture.recordCompletedTrace({
      label: 'strong-resampling-trace',
      environment: strongEnvironment,
      functionContracts: strongContracts,
      frames: [{ input, decision: strongDecision }],
    })
    capture.recordCompletedTrace({
      label: 'strong-resampling-deterministic-peer',
      environment: strongEnvironment,
      functionContracts: strongContracts,
      frames: [{ input, decision: peerDecision }],
    })
    const mildDuplicate = new SmcKlController()
    mildDuplicate.reset(mildEnvironment)
    const mildDuplicateDecision = mildDuplicate.step(mildInput)
    capture.recordCompletedTrace({
      label: 'mild-fresh-reset-duplicate',
      environment: mildEnvironment,
      functionContracts: mildContracts,
      frames: [{ input: mildInput, decision: mildDuplicateDecision }],
    })
    expect(mildDuplicateDecision).toEqual(mildDecision)

    const mildWindMutant = new SmcKlController()
    mildWindMutant.reset(mildEnvironment)
    const windMiss = { ...miss, wind: { x: 0, y: 1 } }
    const windMissInput = stepInput({
      time: 1,
      position: windMiss.position,
      observations: [windMiss],
      measurement: windMiss,
    })
    const mildWindDecision = mildWindMutant.step(windMissInput)
    capture.recordCompletedTrace({
      label: 'mild-changed-measured-wind',
      environment: mildEnvironment,
      functionContracts: mildContracts,
      frames: [{ input: windMissInput, decision: mildWindDecision }],
    })
    expect(mildWindDecision).toEqual(mildDecision)
    declareBayesianDeterminismAndTruthCases({
      capture,
      fixtureId: 'M2',
      duplicateEndpoint: 'mild-fresh-reset-duplicate',
    })
    capture.evaluatorCase({
      caseId: 'COM05-M2-measured-wind-01',
      assertionId: 'COM-05',
      role: 'ignored-field-metamorphic',
      primaryEndpoint: 'primary',
      peerEndpoint: 'mild-changed-measured-wind',
      primaryResetOrdinal: 1,
      peerResetOrdinal: 5,
      ignoredField: 'measured-wind',
    })
    const strongAfter = readSmcKlDiagnostic(strong).state
    const peerAfter = readSmcKlDiagnostic(peer).state
    expect(strongAfter.particles.every((particle) => particle.weight === 1 / 320)).toBe(true)
    expect(strongAfter.effectiveSampleSize).toBeCloseTo(320, 10)
    expect(strongAfter.particles).toEqual(peerAfter.particles)
    expect(strongAfter.particles.some((particle, index) =>
      particle.x !== strongBefore[index]?.x || particle.y !== strongBefore[index]?.y)).toBe(true)
    expect(strongAfter.lastUpdate).not.toBeNull()
    expect(peerAfter.lastUpdate).toEqual(strongAfter.lastUpdate)
    capture.diagnostic('mild-before-particle-state', { particles: mildBefore })
    capture.diagnostic('mild-after-particle-state', mildAfter)
    capture.diagnostic('strong-before-particle-state', { particles: strongBefore })
    capture.diagnostic('strong-after-particle-state', strongAfter)
    capture.diagnostic('strong-peer-after-particle-state', peerAfter)
    capture.reference('independent-mild-update-and-trigger-calculation', {
      mildExpectedWeights: expectedWeights,
      mildExpectedEss: effectiveSampleSize(expectedWeights),
      resamplingEssThreshold: 320 * 0.52,
      strongCalculatedPreResampleWeights: normalizedPreResample,
      strongCalculatedPreResampleEss: effectiveSampleSize(normalizedPreResample),
      independentSeedAlignedReference: independentStrongReference,
      referenceImplementation: 'scripts/baseline-replay-reference-kernels.ts',
      strongPeerEqualityIsOnlyASecondaryDeterminismCheck: true,
    })
    capture.numeric({
      id: 'M2-01',
      actual: [
        ...mildAfter.particles.map((particle) => particle.weight),
        sum(mildAfter.particles.map((particle) => particle.weight)),
      ],
      expected: [...expectedWeights, 1],
      tolerance: 1e-8,
      quantity: 'particle-weight',
      accessLevel: 'diagnostic',
      comparison: 'no-resample-reference',
    })
    capture.numeric({
      id: 'M2-02',
      actual: [
        ...flattenDiagnosticParticles(strongAfter.particles),
        ...flattenDiagnosticParticles(peerAfter.particles),
      ],
      expected: [
        ...flattenDiagnosticParticles(independentStrongReference.postUpdateParticles),
        ...flattenDiagnosticParticles(independentStrongReference.postUpdateParticles),
      ],
      tolerance: 1e-6,
      quantity: 'particle-state-residual',
      comparison: 'seeded-resample-reference',
      accessLevel: 'diagnostic',
      details: {
        referenceImplementation: 'separately-authored-reference-kernel',
        systematicStart: independentStrongReference.systematicStart,
        jitterStandardDeviation: independentStrongReference.jitterStandardDeviation,
        ancestorIndices: independentStrongReference.ancestorIndices,
        uniformDraws: independentStrongReference.uniformDraws,
        normalCalls: independentStrongReference.normalCalls,
        deterministicPeerArchived: true,
      },
    })
    capture.numeric({
      id: 'M2-03',
      actual: [
        strongAfter.lastUpdate?.preResampleEss ?? NaN,
        strongAfter.lastUpdate?.resampleThreshold ?? NaN,
        strongAfter.lastUpdate?.resampleTriggered === true ? 1 : 0,
      ],
      expected: [
        independentStrongReference.preResampleEffectiveSampleSize,
        independentStrongReference.resampleThreshold,
        independentStrongReference.resampleTriggered ? 1 : 0,
      ],
      tolerance: 1e-7,
      quantity: 'effective-sample-size',
      comparison: 'ess-trigger-reference',
      accessLevel: 'diagnostic',
      details: {
        strictComparison: '<',
        independentlyCalculatedPreResampleEss:
          independentStrongReference.preResampleEffectiveSampleSize,
        triggerDecisionComparedExactlyAsBinary: true,
      },
    })
    capture.finish()
  })

  it('[M3] reproduces the two-candidate app KL ranking and verifies the early stop gate', () => {
    const position = { x: 0.5, y: 0.5 }
    const east = { x: 0.58, y: 0.5 }
    const west = { x: 0.42, y: 0.5 }
    const rate: RateOracle = (candidate, sample) => {
      const separationSquared =
        (candidate.x - sample.x) ** 2 + (candidate.y - sample.y) ** 2
      return 0.015 + 3.2 * Math.exp(-separationSquared / 0.055)
    }
    const environment = makeEnvironment({
      controllerSeed: 612,
      rate,
      blocked: (point, clearance) =>
        clearance >= 0.01 && distance(point, east) > 1e-8 && distance(point, west) > 1e-8,
    })
    const contracts = functionContracts({
      rateId: 'm3-radial-exponential-rate-v1',
      rateEquation: '0.015 + 3.2 * exp(-||candidate-sample||^2 / 0.055)',
      rateParameters: { offset: 0.015, amplitude: 3.2, squaredLengthScale: 0.055 },
      blockedId: 'm3-two-real-feasible-candidates-v1',
      blockedParameters: { allowedAtPlanningClearance: [east, west], planningClearanceMinimum: 0.01 },
    })
    const capture = fixtureRecorder({
      fixtureId: 'M3',
      algorithmId: 'smc-kl',
      environment,
      contracts,
      accessLevel: 'black-box+diagnostic',
      notes: ['The two candidates are produced through the public obstacle predicate; particles are not injected.'],
    })
    const controller = new SmcKlController()
    controller.reset(environment)
    const particles = readSmcKlDiagnostic(controller).state.particles
    const estimate = weightedMean(particles)
    const actionInput = stepInput({ time: 0, position, heading: 0 })
    const decision = capture.step(controller, actionInput, 'real-public-two-candidate-action')
    const diagnostic = readSmcKlDiagnostic(controller).state
    expect(diagnostic.candidates).toHaveLength(2)

    const scores = diagnostic.candidates.map((candidate) => {
      let predictiveHit = 0
      let expectedConditionalEntropy = 0
      for (const particle of particles) {
        const probability = smcHitProbability(particle, rate(particle, candidate, 1.6))
        predictiveHit += particle.weight * probability
        expectedConditionalEntropy += particle.weight * binaryEntropy(probability)
      }
      return {
        point: candidate,
        gain: Math.max(0, binaryEntropy(predictiveHit) - expectedConditionalEntropy),
        predictiveHit,
      }
    })
    const expectedBest = scores.reduce((incumbent, candidate) => {
      const gainDifference = candidate.gain - incumbent.gain
      if (Math.abs(gainDifference) > 1e-9) return gainDifference > 0 ? candidate : incumbent
      const detectionDifference = candidate.predictiveHit - incumbent.predictiveHit
      if (Math.abs(detectionDifference) > 1e-9) {
        return detectionDifference > 0 ? candidate : incumbent
      }
      return distance(candidate.point, estimate) < distance(incumbent.point, estimate)
        ? candidate
        : incumbent
    })
    // Black-box selected target plus diagnostic exact score.
    expectPointClose(decision.debug?.target, expectedBest.point, 12)
    expect(diagnostic.lastInformationGain).toBeCloseTo(expectedBest.gain, 12)

    const duplicate = new SmcKlController()
    duplicate.reset(environment)
    const duplicateDecision = duplicate.step(actionInput)
    capture.recordCompletedTrace({
      label: 'fresh-reset-duplicate',
      environment,
      functionContracts: contracts,
      frames: [{ input: actionInput, decision: duplicateDecision }],
    })
    expect(duplicateDecision).toEqual(decision)
    declareBayesianDeterminismAndTruthCases({
      capture,
      fixtureId: 'M3',
      duplicateEndpoint: 'fresh-reset-duplicate',
    })

    const early = new SmcKlController()
    const earlyEnvironment = makeEnvironment({ controllerSeed: 613, rate })
    const earlyContracts = functionContracts({
      rateId: 'm3-radial-exponential-rate-v1',
      rateEquation: '0.015 + 3.2 * exp(-||candidate-sample||^2 / 0.055)',
      rateParameters: { offset: 0.015, amplitude: 3.2, squaredLengthScale: 0.055 },
    })
    early.reset(earlyEnvironment)
    const earlyEstimate = weightedMean(readSmcKlDiagnostic(early).state.particles)
    const shortHistory = Array.from({ length: 47 }, (_, index) =>
      observation(index + 1, earlyEstimate, true, 1.1))
    const earlyInput = stepInput({
      time: 47,
      position: earlyEstimate,
      observations: shortHistory,
      measurement: shortHistory.at(-1),
    })
    const earlyDecision = early.step(earlyInput)
    capture.recordCompletedTrace({
      label: 'forty-seven-observation-stopping-counterexample',
      environment: earlyEnvironment,
      functionContracts: earlyContracts,
      frames: [{ input: earlyInput, decision: earlyDecision }],
    })
    expect(earlyDecision.nativeTerminated).not.toBe(true)
    const earlyState = readSmcKlDiagnostic(early).state
    expect(earlyState.assimilatedObservationCount).toBe(47)
    expect(earlyState.hitCount).toBe(47)
    expect(earlyState.contractionConfirmations).toBe(0)
    capture.diagnostic('action-state', readSmcKlDiagnostic(controller))
    capture.diagnostic('early-stopping-counterexample-state', readSmcKlDiagnostic(early))
    capture.reference('independent-mutual-information-ranking', {
      particles,
      candidates: diagnostic.candidates,
      scores,
      weightedEstimate: estimate,
      selected: expectedBest,
      arrivalTime: 1.6,
    })
    capture.nonNumeric({
      id: 'M3-01',
      passed:
        diagnostic.candidates.length === 2 &&
        distance(diagnostic.candidates[0] ?? position, east) <= 1e-12 &&
        distance(diagnostic.candidates[1] ?? position, west) <= 1e-12,
      accessLevel: 'black-box+diagnostic',
      comparison: 'public-candidate-construction',
      details: { actualCandidates: diagnostic.candidates, expectedCandidates: [east, west] },
    })
    capture.numeric({
      id: 'M3-02',
      actual: [
        decision.debug?.target?.x ?? NaN,
        decision.debug?.target?.y ?? NaN,
        diagnostic.lastInformationGain,
      ],
      expected: [expectedBest.point.x, expectedBest.point.y, expectedBest.gain],
      tolerance: 1e-7,
      quantity: 'kl-score-and-target-residual',
      accessLevel: 'black-box+diagnostic',
      comparison: 'complete-action-reference',
    })
    capture.nonNumeric({
      id: 'M3-03',
      passed:
        earlyDecision.nativeTerminated !== true &&
        earlyState.assimilatedObservationCount === 47 &&
        earlyState.hitCount === 47 &&
        earlyState.contractionConfirmations === 0,
      comparison: 'negative-terminal',
      accessLevel: 'black-box+diagnostic',
      details: {
        assimilatedObservationCount: earlyState.assimilatedObservationCount,
        hitCount: earlyState.hitCount,
        contractionConfirmations: earlyState.contractionConfirmations,
        nativeTerminated: Boolean(earlyDecision.nativeTerminated),
      },
    })
    capture.finish()
  })

  it('[P1] replays the private hit-map equation while retaining black-box action checks', () => {
    const customBlocked: BlockOracle = (point) => point.x < 0.12 && point.y < 0.12
    const environment = makeEnvironment({ blocked: customBlocked })
    const contracts = functionContracts({
      rateId: 'constant-rate-0.2-v1',
      rateEquation: 'expectedHitRate(candidate,sample,time) = 0.2',
      rateParameters: { rate: 0.2 },
      blockedId: 'unit-boundary-plus-lower-left-mask-v1',
      blockedParameters: { maskedWhen: 'x < 0.12 and y < 0.12' },
    })
    const capture = fixtureRecorder({
      fixtureId: 'P1',
      algorithmId: 'pmfs',
      environment,
      contracts,
      accessLevel: 'black-box+diagnostic',
    })
    const controller = new PmfsController()
    const untouchedPeer = new PmfsController()
    controller.reset(environment)
    untouchedPeer.reset(environment)
    const initial = readPmfsDiagnostic(controller)
    expect(initial).toMatchObject({
      schemaVersion: BASELINE_REPLAY_DIAGNOSTIC_SCHEMA_VERSION,
      access: 'diagnostic-read-only',
      evidenceLabel: 'development-behavior-only',
      algorithmId: 'pmfs',
    })
    expect(initial.state.hitMap).toHaveLength(18 * 18)
    expect(initial.state.hitMap.every((value) => value === 0.08)).toBe(true)

    const originalFirst = initial.state.hitMap[0]
    initial.state.hitMap[0] = 999
    if (initial.state.posteriorCells[0]) initial.state.posteriorCells[0].x = 999
    const reread = readPmfsDiagnostic(controller)
    expect(reread.state.hitMap[0]).toBe(originalFirst)
    expect(reread.state.posteriorCells[0]?.x).not.toBe(999)

    const position = { x: 0.5, y: 0.5 }
    const hit = observation(1, position, true, 0.5, { x: 1, y: 0 })
    const input = stepInput({ time: 1, position, observations: [hit], measurement: hit })
    const decision = capture.step(controller, input, 'fixed-pose-hit')
    const peerDecision = JSON.parse(
      JSON.stringify(untouchedPeer.step(input)),
    ) as AlgorithmDecision
    expect(decision).toEqual(peerDecision)
    expect(finiteDecision(decision)).toBe(true)
    expect(decision.phase).toBe('BUILDING HIT MAP')
    expect(decision.debug?.target).toBeTruthy()
    expect(environment.isBlocked(decision.debug?.target ?? position, 0.018)).toBe(false)
    const oneStepEndpoint = {
      x: position.x + decision.direction.x * 0.034,
      y: position.y + decision.direction.y * 0.034,
    }
    expect(environment.isBlocked(oneStepEndpoint, 0.014)).toBe(false)

    const expectedHitMap = referencePmfsHitMapUpdate({
      previous: reread.state.hitMap,
      environment,
      position,
      wind: hit.wind,
      hit: true,
    })
    const afterHit = readPmfsDiagnostic(controller)
    expect(maximumAbsoluteError(
      afterHit.state.hitMap,
      expectedHitMap,
    )).toBeLessThan(1e-12)

    const miss = observation(2, position, false, 0.02, { x: 1, y: 0 })
    const missInput = stepInput({
      time: 2,
      position,
      observations: [hit, miss],
      measurement: miss,
    })
    const missDecision = capture.step(controller, missInput, 'fixed-pose-miss')
    expect(missDecision.phase).toBe('BUILDING HIT MAP')
    const expectedMissMap = referencePmfsHitMapUpdate({
      previous: expectedHitMap,
      environment,
      position,
      wind: miss.wind,
      hit: false,
    })
    const afterMiss = readPmfsDiagnostic(controller)
    expect(maximumAbsoluteError(afterMiss.state.hitMap, expectedMissMap)).toBeLessThan(1e-12)

    const phaseHistory = [
      hit,
      miss,
      ...Array.from({ length: 16 }, (_, index) =>
        observation(index + 3, position, index % 3 === 0, index % 3 === 0 ? 0.5 : 0.02)),
    ]
    const transitionInput = stepInput({
      time: 18,
      position,
      observations: phaseHistory,
      measurement: phaseHistory.at(-1),
    })
    const transitioned = capture.step(controller, transitionInput, 'history-length-eighteen')
    expect(transitioned.phase).toBe('FILAMENT HYPOTHESIS TEST')
    const peerMissDecision = JSON.parse(
      JSON.stringify(untouchedPeer.step(missInput)),
    ) as AlgorithmDecision
    const peerTransitioned = untouchedPeer.step(transitionInput)
    capture.recordCompletedTrace({
      label: 'same-seed-hit-peer',
      environment,
      functionContracts: contracts,
      frames: [
        { input, decision: peerDecision },
        { input: missInput, decision: peerMissDecision },
        { input: transitionInput, decision: peerTransitioned },
      ],
    })
    expect([peerDecision, peerMissDecision, peerTransitioned])
      .toEqual([decision, missDecision, transitioned])
    declareBayesianDeterminismAndTruthCases({
      capture,
      fixtureId: 'P1',
      duplicateEndpoint: 'same-seed-hit-peer',
    })
    capture.diagnostic('after-hit-state', afterHit)
    capture.diagnostic('after-miss-state', afterMiss)
    capture.reference('independent-hit-map-and-phase-reference', {
      grid: { width: 18, height: 18, prior: 0.08 },
      afterHit: expectedHitMap,
      afterMiss: expectedMissMap,
      expectedPhases: ['BUILDING HIT MAP', 'BUILDING HIT MAP', 'FILAMENT HYPOTHESIS TEST'],
    })
    capture.numeric({
      id: 'P1-01',
      actual: [
        Math.abs(decision.direction.x - peerDecision.direction.x),
        Math.abs(decision.direction.y - peerDecision.direction.y),
        Math.abs((decision.debug?.target?.x ?? NaN) - (peerDecision.debug?.target?.x ?? NaN)),
        Math.abs((decision.debug?.target?.y ?? NaN) - (peerDecision.debug?.target?.y ?? NaN)),
        finiteDecision(decision) ? 0 : 1,
        environment.isBlocked(decision.debug?.target ?? position, 0.018) ? 1 : 0,
        environment.isBlocked(oneStepEndpoint, 0.014) ? 1 : 0,
      ],
      expected: [0, 0, 0, 0, 0, 0, 0],
      tolerance: 1e-12,
      quantity: 'domain-and-clearance-residual',
      accessLevel: 'black-box',
      comparison: 'black-box-action-contract',
      details: { oneStepEndpoint, oneStepEndpointBlocked: false },
    })
    capture.nonNumeric({
      id: 'P1-02',
      passed:
        decision.phase === 'BUILDING HIT MAP' &&
        missDecision.phase === 'BUILDING HIT MAP' &&
        transitioned.phase === 'FILAMENT HYPOTHESIS TEST',
      accessLevel: 'black-box',
      comparison: 'threshold-boundary',
      details: { phases: [decision.phase, missDecision.phase, transitioned.phase] },
    })
    capture.numeric({
      id: 'P1-03',
      actual: [...afterHit.state.hitMap, ...afterMiss.state.hitMap],
      expected: [...expectedHitMap, ...expectedMissMap],
      tolerance: 1e-8,
      quantity: 'hit-map-value',
      accessLevel: 'diagnostic',
      comparison: 'hit-map-vector',
    })
    capture.finish()
  })

  it('[P2] matches the raw posterior and public percentile scaling without mutating observations', () => {
    const rate: RateOracle = (candidate, sample) =>
      0.02 + 2.1 * Math.exp(-(distance(candidate, sample) ** 2) / 0.09)
    const environment = makeEnvironment({
      rate,
      blocked: (point) => point.x > 0.82 && point.y < 0.18,
    })
    const contracts = functionContracts({
      rateId: 'p2-radial-exponential-rate-v1',
      rateEquation: '0.02 + 2.1 * exp(-||candidate-sample||^2 / 0.09)',
      rateParameters: { offset: 0.02, amplitude: 2.1, squaredLengthScale: 0.09 },
      blockedId: 'unit-boundary-plus-upper-right-lower-band-mask-v1',
      blockedParameters: { maskedWhen: 'x > 0.82 and y < 0.18' },
    })
    const capture = fixtureRecorder({
      fixtureId: 'P2',
      algorithmId: 'pmfs',
      environment,
      contracts,
      accessLevel: 'black-box+diagnostic',
    })
    const controller = new PmfsController()
    controller.reset(environment)
    const before = readPmfsDiagnostic(controller).state
    const first = observation(1, { x: 0.31, y: 0.42 }, true, 0.5, { x: 1, y: 0 })
    const second = observation(2, { x: 0.57, y: 0.64 }, false, 0.02, { x: 0, y: 1 })
    const history = [first, second]
    const immutableCopy = JSON.stringify(history)
    const firstInput = stepInput({
      time: 1,
      position: first.position,
      observations: [first],
      measurement: first,
    })
    const firstDecision = JSON.parse(JSON.stringify(
      capture.step(controller, firstInput, 'append-only-history-first-hit'),
    )) as AlgorithmDecision
    const secondInput = stepInput({
      time: 2,
      position: second.position,
      observations: history,
      measurement: second,
    })
    const decision = capture.step(controller, secondInput, 'append-only-history-second-miss')
    expect(JSON.stringify(history)).toBe(immutableCopy)
    const after = readPmfsDiagnostic(controller).state

    const expectedUnnormalized = before.posteriorCells.map((cell) => {
      let logLikelihood = Math.log(Math.max(1e-12, cell.weight))
      for (const item of history) {
        const predictedHit = 1 - Math.exp(-rate(cell, item.position, item.time))
        const probability = item.hit ? predictedHit : 1 - predictedHit
        logLikelihood += Math.log(Math.max(0.015, probability)) * 0.28
      }
      return Math.exp(Math.max(-60, logLikelihood))
    })
    const normalization = sum(expectedUnnormalized)
    const expectedWeights = expectedUnnormalized.map((weight) => weight / normalization)
    const actualWeights = after.posteriorCells.map((cell) => cell.weight)
    expect(maximumAbsoluteError(actualWeights, expectedWeights)).toBeLessThan(1e-12)
    expect(sum(actualWeights)).toBeCloseTo(1, 12)

    const rawGrid = new Array<number>(18 * 18).fill(0)
    after.posteriorCells.forEach((cell) => {
      rawGrid[cell.index] = cell.weight
    })
    const scale = percentile(rawGrid, 0.995) || 1
    const expectedPublicGrid = rawGrid.map((weight) => Math.min(1, weight / scale))
    expect(maximumAbsoluteError(
      decision.debug?.grid?.values ?? [],
      expectedPublicGrid,
    )).toBeLessThan(1e-12)
    expect(JSON.stringify(after)).not.toMatch(/"source"|"targetStatus"/)

    const duplicate = new PmfsController()
    duplicate.reset(environment)
    const duplicateFirstDecision = JSON.parse(
      JSON.stringify(duplicate.step(firstInput)),
    ) as AlgorithmDecision
    const duplicateSecondDecision = duplicate.step(secondInput)
    capture.recordCompletedTrace({
      label: 'fresh-reset-duplicate',
      environment,
      functionContracts: contracts,
      frames: [
        { input: firstInput, decision: duplicateFirstDecision },
        { input: secondInput, decision: duplicateSecondDecision },
      ],
    })
    expect([duplicateFirstDecision, duplicateSecondDecision])
      .toEqual([firstDecision, decision])
    declareBayesianDeterminismAndTruthCases({
      capture,
      fixtureId: 'P2',
      duplicateEndpoint: 'fresh-reset-duplicate',
    })

    // Diagnostic-only wind sensitivity of the private hit map.
    const windX = new PmfsController()
    const windY = new PmfsController()
    windX.reset(environment)
    windY.reset(environment)
    const xMeasurement = observation(1, { x: 0.5, y: 0.5 }, true, 0.5, { x: 1, y: 0 })
    const yMeasurement = observation(1, { x: 0.5, y: 0.5 }, true, 0.5, { x: 0, y: 1 })
    const windXInput = stepInput({ time: 1, observations: [xMeasurement], measurement: xMeasurement })
    const windYInput = stepInput({ time: 1, observations: [yMeasurement], measurement: yMeasurement })
    const windXDecision = windX.step(windXInput)
    const windYDecision = windY.step(windYInput)
    capture.recordCompletedTrace({
      label: 'positive-x-wind-counterfactual',
      environment,
      functionContracts: contracts,
      frames: [{ input: windXInput, decision: windXDecision }],
    })
    capture.recordCompletedTrace({
      label: 'positive-y-measured-wind-counterfactual',
      environment,
      functionContracts: contracts,
      frames: [{ input: windYInput, decision: windYDecision }],
    })
    const windXState = readPmfsDiagnostic(windX).state
    const windYState = readPmfsDiagnostic(windY).state
    expect(windXState.hitMap).not.toEqual(windYState.hitMap)

    const resetHitMap = new Array<number>(18 * 18).fill(0.08)
    const expectedWindX = referencePmfsHitMapUpdate({
      previous: resetHitMap,
      environment,
      position: xMeasurement.position,
      wind: xMeasurement.wind,
      hit: true,
    })
    const expectedWindY = referencePmfsHitMapUpdate({
      previous: resetHitMap,
      environment,
      position: yMeasurement.position,
      wind: yMeasurement.wind,
      hit: true,
    })
    const expectedCells = before.posteriorCells.map((cell, index) => ({
      ...cell,
      weight: expectedWeights[index] ?? NaN,
    }))
    const actualRadius = weightedCellRadius(after.posteriorCells)
    const expectedRadius = weightedCellRadius(expectedCells)
    capture.diagnostic('posterior-after-history', after)
    capture.diagnostic('positive-x-wind-hit-map', windXState)
    capture.diagnostic('positive-y-wind-hit-map', windYState)
    capture.reference('independent-posterior-scaling-radius-and-wind-map-reference', {
      expectedRawCellWeights: expectedWeights,
      expectedPublicGrid,
      expectedWeightedRadius: expectedRadius,
      expectedPositiveXWindHitMap: expectedWindX,
      expectedPositiveYWindHitMap: expectedWindY,
      frozenInputHistoryJson: immutableCopy,
    })
    capture.numeric({
      id: 'P2-01',
      actual: decision.debug?.grid?.values ?? [],
      expected: expectedPublicGrid,
      tolerance: 1e-8,
      quantity: 'percentile-scaled-posterior-value',
      accessLevel: 'black-box',
      comparison: 'public-grid-vector',
    })
    capture.nonNumeric({
      id: 'P2-02',
      passed: JSON.stringify(history) === immutableCopy,
      comparison: 'input-digest-exact',
      accessLevel: 'black-box',
      details: { observationCount: history.length },
    })
    capture.numeric({
      id: 'P2-03',
      actual: [
        ...actualWeights,
        actualRadius,
        ...windXState.hitMap,
        ...windYState.hitMap,
      ],
      expected: [
        ...expectedWeights,
        expectedRadius,
        ...expectedWindX,
        ...expectedWindY,
      ],
      tolerance: 1e-8,
      quantity: 'raw-posterior-residual',
      accessLevel: 'diagnostic',
      comparison: 'raw-posterior-and-wind-metamorphic',
    })
    capture.finish()
  })

  it('[P3] reproduces the app candidate score and rejects concentration-only declaration', () => {
    const rate: RateOracle = (candidate, sample) =>
      0.03 + 2.5 * Math.exp(-(distance(candidate, sample) ** 2) / 0.07)
    const environment = makeEnvironment({ rate })
    const contracts = functionContracts({
      rateId: 'p3-radial-exponential-rate-v1',
      rateEquation: '0.03 + 2.5 * exp(-||candidate-sample||^2 / 0.07)',
      rateParameters: { offset: 0.03, amplitude: 2.5, squaredLengthScale: 0.07 },
    })
    const capture = fixtureRecorder({
      fixtureId: 'P3',
      algorithmId: 'pmfs',
      environment,
      contracts,
      accessLevel: 'black-box+diagnostic',
    })
    const controller = new PmfsController()
    const peer = new PmfsController()
    controller.reset(environment)
    peer.reset(environment)
    const position = { x: 0.5, y: 0.5 }
    const input = stepInput({ time: 0, position })
    const decision = capture.step(controller, input, 'planning-decision')
    const peerDecision = peer.step(input)
    capture.recordCompletedTrace({
      label: 'same-seed-planning-peer',
      environment,
      functionContracts: contracts,
      frames: [{ input, decision: peerDecision }],
    })
    declareBayesianDeterminismAndTruthCases({
      capture,
      fixtureId: 'P3',
      duplicateEndpoint: 'same-seed-planning-peer',
    })
    expect(decision).toEqual(peerDecision)
    expect(finiteDecision(decision)).toBe(true)
    expect(decision.debug?.target).toBeTruthy()
    expect(environment.isBlocked(decision.debug?.target ?? position, 0.018)).toBe(false)
    const state = readPmfsDiagnostic(controller).state

    const independentActionReference = independentlyScorePmfsActions({
      posteriorCells: state.posteriorCells,
      hitMap: state.hitMap,
      position,
      time: input.time,
      isBlocked: (point, clearance) => environment.isBlocked(point, clearance),
      expectedHitRate: rate,
    })
    const likely = independentActionReference.likelyCells
    const candidates = independentActionReference.actionScores.map((entry) => entry.point)
    const actionScoreReference = independentActionReference.actionScores
    const expectedTarget = independentActionReference.selectedTarget
    expectPointClose(state.plannedTarget, expectedTarget, 12)
    expectPointClose(decision.debug?.target, expectedTarget, 12)

    const concentrationOnly = new PmfsController()
    concentrationOnly.reset(environment)
    const strongHistory = [
      observation(1, position, true, 1.2),
      observation(2, position, true, 1.1),
      observation(3, position, true, 1.0),
    ]
    const earlyInput = stepInput({
      time: 3,
      position,
      observations: strongHistory,
      measurement: strongHistory.at(-1),
    })
    const earlyDecision = concentrationOnly.step(earlyInput)
    capture.recordCompletedTrace({
      label: 'strong-concentration-only-stopping-counterexample',
      environment,
      functionContracts: contracts,
      frames: [{ input: earlyInput, decision: earlyDecision }],
    })
    expect(earlyDecision.nativeTerminated).toBe(false)
    expect(readPmfsDiagnostic(concentrationOnly).state.stepCount).toBe(1)

    const terminalPosition = { x: 9.5 / 18, y: 9.5 / 18 }
    const terminalRate: RateOracle = (candidate) =>
      1e-9 + 20 * Math.exp(-(distance(candidate, terminalPosition) ** 2) / 0.0003)
    const terminalEnvironment = makeEnvironment({ rate: terminalRate })
    const terminalContracts = functionContracts({
      rateId: 'p3-sharp-grid-cell-rate-v1',
      rateEquation: '1e-9 + 20 * exp(-||candidate-terminalCell||^2 / 0.0003)',
      rateParameters: { terminalCell: terminalPosition, amplitude: 20, squaredLengthScale: 0.0003 },
    })
    const terminalController = new PmfsController()
    terminalController.reset(terminalEnvironment)
    const terminalHistory: Observation[] = []
    const terminalFrames: Array<{ input: AlgorithmStepInput; decision: AlgorithmDecision }> = []
    let terminalTransitionCount = 0
    let previousTerminal = false
    for (let index = 1; index <= 180; index += 1) {
      const sample = observation(index * 0.25, terminalPosition, true, 1.2)
      terminalHistory.push(sample)
      const terminalInput = stepInput({
        time: sample.time,
        position: terminalPosition,
        observations: terminalHistory,
        measurement: sample,
      })
      const terminalDecision = terminalController.step(terminalInput)
      terminalFrames.push({ input: terminalInput, decision: terminalDecision })
      if (!previousTerminal && terminalDecision.nativeTerminated === true) {
        terminalTransitionCount += 1
      }
      previousTerminal = terminalDecision.nativeTerminated === true
      if (terminalDecision.nativeTerminated === true) break
    }
    const nativeTerminalDecision = terminalFrames.at(-1)?.decision
    capture.recordCompletedTrace({
      label: 'positive-native-terminal-trace',
      environment: terminalEnvironment,
      functionContracts: terminalContracts,
      frames: terminalFrames,
    })
    capture.heldOutTruthRecord({
      truthId: 'P3-truth-terminal-present',
      truthClass: 'source-present',
      source: terminalPosition,
      prespecifiedBasis: 'Sharp terminal oracle and passive samples are centred on this frozen grid cell.',
    })
    capture.evaluatorCase({
      caseId: 'COM06-P3-terminal-01',
      assertionId: 'COM-06',
      role: 'held-out-terminal-evaluation',
      terminalEndpoint: 'positive-native-terminal-trace',
      truthId: 'P3-truth-terminal-present',
      localizationThreshold: 0.05,
    })
    expect(nativeTerminalDecision?.nativeTerminated).toBe(true)
    expect(terminalFrames.length).toBeGreaterThanOrEqual(101)
    expect(terminalTransitionCount).toBe(1)
    const terminalDirectionNorm = Math.hypot(
      nativeTerminalDecision?.direction.x ?? NaN,
      nativeTerminalDecision?.direction.y ?? NaN,
    )
    expect(Number.isFinite(terminalDirectionNorm)).toBe(true)
    expect(terminalDirectionNorm).toBeLessThanOrEqual(1 + 1e-12)
    capture.diagnostic('planning-state', readPmfsDiagnostic(controller))
    capture.diagnostic('concentration-only-counterexample-state', readPmfsDiagnostic(concentrationOnly))
    capture.diagnostic('positive-terminal-state', readPmfsDiagnostic(terminalController))
    capture.reference('independent-action-score-and-declaration-gate-reference', {
      radialCandidateCount: 12,
      mapCandidateAppended: Boolean(likely[0]),
      actionCandidates: candidates,
      actionScores: actionScoreReference,
      independentlySelectedTarget: expectedTarget,
      concentrationOnlyObservationCount: strongHistory.length,
      nativeObservationThresholdExclusive: 100,
      positiveTerminalFrameCount: terminalFrames.length,
      positiveTerminalTransitionCount: terminalTransitionCount,
    })
    capture.numeric({
      id: 'P3-01',
      actual: [
        Math.abs(decision.direction.x - peerDecision.direction.x),
        Math.abs(decision.direction.y - peerDecision.direction.y),
        Math.abs((decision.debug?.target?.x ?? NaN) - (peerDecision.debug?.target?.x ?? NaN)),
        Math.abs((decision.debug?.target?.y ?? NaN) - (peerDecision.debug?.target?.y ?? NaN)),
        finiteDecision(decision) ? 0 : 1,
        environment.isBlocked(decision.debug?.target ?? position, 0.018) ? 1 : 0,
      ],
      expected: [0, 0, 0, 0, 0, 0],
      tolerance: 1e-12,
      quantity: 'domain-and-clearance-residual',
      accessLevel: 'black-box',
      comparison: 'black-box-action-contract',
    })
    const flattenActionScores = (scores: typeof actionScoreReference) => scores.flatMap((entry) => [
      entry.point.x,
      entry.point.y,
      entry.variance,
      entry.mapUncertainty,
      entry.travelPenalty,
      entry.score,
    ])
    capture.numeric({
      id: 'P3-02',
      actual: [
        ...flattenActionScores(state.lastActionScores),
        state.selectedActionIndex ?? NaN,
        state.selectedActionScore ?? NaN,
        state.plannedTarget?.x ?? NaN,
        state.plannedTarget?.y ?? NaN,
      ],
      expected: [
        ...flattenActionScores(actionScoreReference),
        independentActionReference.selectedIndex,
        actionScoreReference[independentActionReference.selectedIndex]?.score ?? NaN,
        expectedTarget.x,
        expectedTarget.y,
      ],
      tolerance: 1e-7,
      quantity: 'candidate-score-and-target-residual',
      comparison: 'candidate-construction-and-score',
      accessLevel: 'black-box+diagnostic',
      details: {
        independentScoresArchived: true,
        orderedCandidateCount: actionScoreReference.length,
        selectedIndexComparedExactlyAsInteger: true,
        referenceImplementation: 'separately-authored-reference-kernel',
      },
    })
    capture.nonNumeric({
      id: 'P3-03',
      passed: earlyDecision.nativeTerminated === false && strongHistory.length === 3,
      accessLevel: 'black-box+diagnostic',
      comparison: 'negative-terminal',
      details: { observationCount: strongHistory.length, nativeTerminated: earlyDecision.nativeTerminated },
    })
    capture.numeric({
      id: 'P3-04',
      actual: [
        Math.max(0, terminalDirectionNorm - 1),
        terminalTransitionCount === 1 ? 0 : 1,
        nativeTerminalDecision?.nativeTerminated === true ? 0 : 1,
      ],
      expected: [0, 0, 0],
      tolerance: 1e-12,
      quantity: 'direction-norm',
      comparison: 'terminal-direction-bound',
      accessLevel: 'black-box',
      details: {
        concentrationOnlyCounterexampleIsNonterminal: true,
        terminalFrameCount: terminalFrames.length,
        terminalTransitionCount,
        terminalDirectionNorm,
        zeroDirectionRequired: false,
      },
    })
    capture.finish()
  })
})
