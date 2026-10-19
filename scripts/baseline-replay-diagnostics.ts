import type { InfotaxisController } from '../src/sim/algorithms/infotaxis'
import type { PmfsController } from '../src/sim/algorithms/pmfs'
import type {
  SurgeCastController,
  ZigzagSpiralController,
} from '../src/sim/algorithms/reactive'
import type { SmcKlController } from '../src/sim/algorithms/smc'
import type { AlgorithmId, Vec2 } from '../src/sim/types'

/**
 * Versioned, read-only access to implementation state needed by development
 * replay fixtures. This is deliberately outside the production controller
 * interface and is not evidence of fidelity to a cited algorithm.
 *
 * The readers below only copy already-materialised fields. They never call a
 * controller method, inspect its RNG, retain an internal array/object, or
 * expose the private world source/target-presence truth.
 */
export const BASELINE_REPLAY_DIAGNOSTIC_SCHEMA_VERSION =
  'baseline-replay-diagnostic-v2' as const

type DiagnosticEnvelope<
  TAlgorithmId extends Extract<
    AlgorithmId,
    'surge-cast' | 'zigzag-spiral' | 'infotaxis' | 'smc-kl' | 'pmfs'
  >,
  TState,
> = {
  schemaVersion: typeof BASELINE_REPLAY_DIAGNOSTIC_SCHEMA_VERSION
  access: 'diagnostic-read-only'
  evidenceLabel: 'development-behavior-only'
  algorithmId: TAlgorithmId
  state: TState
}

export type DiagnosticGridCell = {
  index: number
  point: Vec2
}

export type DiagnosticParticle = Vec2 & {
  weight: number
  strength: number
}

export type DiagnosticWeightedCell = Vec2 & {
  weight: number
  index: number
}

export type InfotaxisDiagnosticState = {
  cells: DiagnosticGridCell[]
  rawPosterior: number[]
  visitSeconds: number[]
  assimilatedMeasurements: number
  hitMeasurements: number
  convergenceConfirmations: number
  terminated: boolean
  terminationReason?: string
  plannedTarget: Vec2 | null
  candidates: Vec2[]
  nextPlanTime: number
  lastInformationGain: number
}

export type SmcKlDiagnosticState = {
  particles: DiagnosticParticle[]
  assimilatedObservationCount: number
  hitCount: number
  contractionConfirmations: number
  terminated: boolean
  terminationReason?: string
  plannedTarget: Vec2 | null
  candidates: Vec2[]
  nextPlanTime: number
  lastInformationGain: number
  refinedEstimate: Vec2 | null
  effectiveSampleSize: number
  lastUpdate: {
    preResampleEss: number
    resampleThreshold: number
    resampleTriggered: boolean
  } | null
}

export type DiagnosticPmfsActionScore = {
  point: Vec2
  variance: number
  mapUncertainty: number
  travelPenalty: number
  score: number
}

export type PmfsDiagnosticState = {
  posteriorCells: DiagnosticWeightedCell[]
  hitMap: number[]
  plannedTarget: Vec2 | null
  lastPlanTime: number
  stepCount: number
  lastObservationIndex: number
  refinedEstimate: Vec2 | null
  lastActionScores: DiagnosticPmfsActionScore[]
  selectedActionIndex: number | null
  selectedActionScore: number | null
}

export type SurgeCastDiagnosticState = {
  castSpan: number
  castProgress: number
  castLeg: number
  castSide: number
  previousMotion: 'surge' | 'cast' | 'other'
}

export type ZigzagSpiralDiagnosticState = {
  refining: boolean
  spiralRadius: number
  spiralCenter: Vec2 | null
  spiralAngle: number
  refinementStartedAt: number
}

type InfotaxisRuntime = {
  cells: Array<{ index: number; point: Vec2 }>
  posterior: number[]
  visitSeconds: number[]
  assimilatedMeasurements: number
  hitMeasurements: number
  convergenceConfirmations: number
  terminated: boolean
  terminationReason?: string
  target: Vec2 | null
  candidates: Vec2[]
  nextPlanTime: number
  lastInformationGain: number
}

type SmcKlRuntime = {
  particles: Array<Vec2 & { weight: number; strength: number }>
  assimilatedObservationCount: number
  hitCount: number
  contractionConfirmations: number
  terminated: boolean
  terminationReason?: string
  target: Vec2 | null
  candidates: Vec2[]
  nextPlanTime: number
  lastInformationGain: number
  refinedEstimate: Vec2 | null
  lastUpdate: {
    preResampleEss: number
    resampleThreshold: number
    resampleTriggered: boolean
  } | null
}

type PmfsRuntime = {
  cells: Array<Vec2 & { weight: number; index: number }>
  hitMap: number[]
  target: Vec2 | null
  lastPlanTime: number
  stepCount: number
  lastObservationIndex: number
  refinedSourceEstimate: Vec2 | null
  diagnostics: {
    lastActionScores: DiagnosticPmfsActionScore[]
    selectedIndex: number | null
    selectedScore: number | null
  }
}

type SurgeCastRuntime = {
  castSpan: number
  castProgress: number
  castLeg: number
  castSide: number
  previousMotion: 'surge' | 'cast' | 'other'
}

type ZigzagSpiralRuntime = {
  refining: boolean
  spiralRadius: number
  spiralCenter: Vec2 | null
  spiralAngle: number
  refinementStartedAt: number
}

const copyPoint = (point: Vec2): Vec2 => ({ x: point.x, y: point.y })
const copyOptionalPoint = (point: Vec2 | null): Vec2 | null =>
  point === null ? null : copyPoint(point)

const requireAlgorithm = (actual: AlgorithmId, expected: AlgorithmId) => {
  if (actual !== expected) {
    throw new TypeError(`Diagnostic reader expected ${expected}, received ${actual}`)
  }
}

const effectiveSampleSize = (weights: readonly number[]) => {
  const sumSquares = weights.reduce((sum, weight) => sum + weight * weight, 0)
  return sumSquares > 0 ? 1 / sumSquares : 0
}

export const readInfotaxisDiagnostic = (
  controller: InfotaxisController,
): DiagnosticEnvelope<'infotaxis', InfotaxisDiagnosticState> => {
  requireAlgorithm(controller.metadata.id, 'infotaxis')
  const runtime = controller as unknown as InfotaxisRuntime
  return {
    schemaVersion: BASELINE_REPLAY_DIAGNOSTIC_SCHEMA_VERSION,
    access: 'diagnostic-read-only',
    evidenceLabel: 'development-behavior-only',
    algorithmId: 'infotaxis',
    state: {
      cells: runtime.cells.map((cell) => ({
        index: cell.index,
        point: copyPoint(cell.point),
      })),
      rawPosterior: [...runtime.posterior],
      visitSeconds: [...runtime.visitSeconds],
      assimilatedMeasurements: runtime.assimilatedMeasurements,
      hitMeasurements: runtime.hitMeasurements,
      convergenceConfirmations: runtime.convergenceConfirmations,
      terminated: runtime.terminated,
      ...(runtime.terminationReason === undefined
        ? {}
        : { terminationReason: runtime.terminationReason }),
      plannedTarget: copyOptionalPoint(runtime.target),
      candidates: runtime.candidates.map(copyPoint),
      nextPlanTime: runtime.nextPlanTime,
      lastInformationGain: runtime.lastInformationGain,
    },
  }
}

export const readSmcKlDiagnostic = (
  controller: SmcKlController,
): DiagnosticEnvelope<'smc-kl', SmcKlDiagnosticState> => {
  requireAlgorithm(controller.metadata.id, 'smc-kl')
  const runtime = controller as unknown as SmcKlRuntime
  const particles = runtime.particles.map((particle) => ({
    x: particle.x,
    y: particle.y,
    weight: particle.weight,
    strength: particle.strength,
  }))
  return {
    schemaVersion: BASELINE_REPLAY_DIAGNOSTIC_SCHEMA_VERSION,
    access: 'diagnostic-read-only',
    evidenceLabel: 'development-behavior-only',
    algorithmId: 'smc-kl',
    state: {
      particles,
      assimilatedObservationCount: runtime.assimilatedObservationCount,
      hitCount: runtime.hitCount,
      contractionConfirmations: runtime.contractionConfirmations,
      terminated: runtime.terminated,
      ...(runtime.terminationReason === undefined
        ? {}
        : { terminationReason: runtime.terminationReason }),
      plannedTarget: copyOptionalPoint(runtime.target),
      candidates: runtime.candidates.map(copyPoint),
      nextPlanTime: runtime.nextPlanTime,
      lastInformationGain: runtime.lastInformationGain,
      refinedEstimate: copyOptionalPoint(runtime.refinedEstimate),
      effectiveSampleSize: effectiveSampleSize(particles.map((particle) => particle.weight)),
      lastUpdate: runtime.lastUpdate === null
        ? null
        : {
            preResampleEss: runtime.lastUpdate.preResampleEss,
            resampleThreshold: runtime.lastUpdate.resampleThreshold,
            resampleTriggered: runtime.lastUpdate.resampleTriggered,
          },
    },
  }
}

export const readPmfsDiagnostic = (
  controller: PmfsController,
): DiagnosticEnvelope<'pmfs', PmfsDiagnosticState> => {
  requireAlgorithm(controller.metadata.id, 'pmfs')
  const runtime = controller as unknown as PmfsRuntime
  return {
    schemaVersion: BASELINE_REPLAY_DIAGNOSTIC_SCHEMA_VERSION,
    access: 'diagnostic-read-only',
    evidenceLabel: 'development-behavior-only',
    algorithmId: 'pmfs',
    state: {
      posteriorCells: runtime.cells.map((cell) => ({
        x: cell.x,
        y: cell.y,
        weight: cell.weight,
        index: cell.index,
      })),
      hitMap: [...runtime.hitMap],
      plannedTarget: copyOptionalPoint(runtime.target),
      lastPlanTime: runtime.lastPlanTime,
      stepCount: runtime.stepCount,
      lastObservationIndex: runtime.lastObservationIndex,
      refinedEstimate: copyOptionalPoint(runtime.refinedSourceEstimate),
      lastActionScores: runtime.diagnostics.lastActionScores.map((entry) => ({
        point: copyPoint(entry.point),
        variance: entry.variance,
        mapUncertainty: entry.mapUncertainty,
        travelPenalty: entry.travelPenalty,
        score: entry.score,
      })),
      selectedActionIndex: runtime.diagnostics.selectedIndex,
      selectedActionScore: runtime.diagnostics.selectedScore,
    },
  }
}

/** Narrow fields required by the S2 development fixture. */
export const readSurgeCastDiagnostic = (
  controller: SurgeCastController,
): DiagnosticEnvelope<'surge-cast', SurgeCastDiagnosticState> => {
  requireAlgorithm(controller.metadata.id, 'surge-cast')
  const runtime = controller as unknown as SurgeCastRuntime
  return {
    schemaVersion: BASELINE_REPLAY_DIAGNOSTIC_SCHEMA_VERSION,
    access: 'diagnostic-read-only',
    evidenceLabel: 'development-behavior-only',
    algorithmId: 'surge-cast',
    state: {
      castSpan: runtime.castSpan,
      castProgress: runtime.castProgress,
      castLeg: runtime.castLeg,
      castSide: runtime.castSide,
      previousMotion: runtime.previousMotion,
    },
  }
}

/** Narrow fields required by the Z2 development fixture. */
export const readZigzagSpiralDiagnostic = (
  controller: ZigzagSpiralController,
): DiagnosticEnvelope<'zigzag-spiral', ZigzagSpiralDiagnosticState> => {
  requireAlgorithm(controller.metadata.id, 'zigzag-spiral')
  const runtime = controller as unknown as ZigzagSpiralRuntime
  return {
    schemaVersion: BASELINE_REPLAY_DIAGNOSTIC_SCHEMA_VERSION,
    access: 'diagnostic-read-only',
    evidenceLabel: 'development-behavior-only',
    algorithmId: 'zigzag-spiral',
    state: {
      refining: runtime.refining,
      spiralRadius: runtime.spiralRadius,
      spiralCenter: copyOptionalPoint(runtime.spiralCenter),
      spiralAngle: runtime.spiralAngle,
      refinementStartedAt: runtime.refinementStartedAt,
    },
  }
}
