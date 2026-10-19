import { createDefaultConfig } from '../config'
import { generateFractalObstacles } from '../fractalObstacles'
import { pointInObstacle } from '../math'
import { SeededRandom, hashNumbers } from '../rng'
import type { AlgorithmId, Obstacle, ScenarioKind, SimulationConfig, Vec2 } from '../types'

/**
 * A pre-registered, controller-blind world description.  `privateLayout` is
 * for the world builder and reporting only: never pass it to a controller.
 */
export type PlacementOverrides = {
  /** Private normalized source position applied by the engine. */
  sourcePositionOverride: Vec2
  /** Prescribed normalized robot start position applied by the engine. */
  robotStartPositionOverride: Vec2
  /** Initial plan heading: 0° along +x and 90° along +y. */
  robotStartHeadingDegrees: number
}

export type OrientationBin = 'downwind' | 'crosswind-left' | 'upwind' | 'crosswind-right'

export const ORIENTATION_BINS: readonly OrientationBin[] = [
  'downwind',
  'crosswind-left',
  'upwind',
  'crosswind-right',
]

const ORIENTATION_CENTER_DEGREES: Record<OrientationBin, number> = {
  downwind: 0,
  'crosswind-left': 90,
  upwind: 180,
  'crosswind-right': 270,
}

export type PrivateLayout = {
  source: Vec2
  robotStart: Vec2
  robotStartHeadingDegrees: number
  sourceToStartBearingDegrees: number
  sourceWindAngleDegrees: number
  obstacleSeed: number
}

export type ResearchScenario = {
  id: string
  replicate: number
  scenarioKind: ScenarioKind
  orientationBin: OrientationBin
  /** Independent streams; none is derived from another stream's outcome. */
  seedPartition: {
    worldSeed: number
    sourceSeed: number
    controllerSeed: number
    observationModelSeed: number
  }
  /** Safe to give a runner, but not a controller. */
  config: SimulationConfig & PlacementOverrides
  /** Keep private from the controller; use only to construct/audit the world. */
  privateLayout: PrivateLayout
}

export type BalancedScenarioOptions = {
  experimentSeed: number
  replicatesPerOrientation: number
  scenarioKinds?: readonly ScenarioKind[]
  obstacleComplexityLevel?: number
  /** Minimum source--start Euclidean separation in normalized-domain units. */
  minimumSeparation?: number
}

const CLEARANCE = 0.014
const DEFAULT_MINIMUM_SEPARATION = 0.3
const MAX_LAYOUT_ATTEMPTS = 512

const compassVector = (degrees: number): Vec2 => {
  const radians = degrees * Math.PI / 180
  return { x: Math.sin(radians), y: -Math.cos(radians) }
}

const compassBearing = (from: Vec2, to: Vec2) =>
  (90 + Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI + 360) % 360

const signedAngle = (degrees: number) => ((degrees + 540) % 360) - 180

const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y)

const clonePoint = (point: Vec2): Vec2 => ({ x: point.x, y: point.y })

const isNavigable = (point: Vec2, obstacles: readonly Obstacle[]) =>
  point.x >= CLEARANCE && point.x <= 1 - CLEARANCE &&
  point.y >= CLEARANCE && point.y <= 1 - CLEARANCE &&
  !obstacles.some((obstacle) => pointInObstacle(point, obstacle, CLEARANCE))

const seedFor = (experimentSeed: number, row: number, partition: number) =>
  hashNumbers(experimentSeed, row, partition)

/**
 * Generate a balanced, deterministic set of layouts.  Wind direction, source
 * point, start point, and body heading are sampled from the private world
 * stream, while source placement is sampled from its dedicated private source
 * stream. The controller seed is an independently labelled stream and never
 * contains a placement, source, or orientation value.
 */
export const createBalancedResearchScenarios = (
  options: BalancedScenarioOptions,
): ResearchScenario[] => {
  if (!Number.isInteger(options.experimentSeed)) throw new RangeError('experimentSeed must be an integer')
  if (!Number.isInteger(options.replicatesPerOrientation) || options.replicatesPerOrientation < 1) {
    throw new RangeError('replicatesPerOrientation must be a positive integer')
  }
  const scenarioKinds = options.scenarioKinds ?? ['open', 'obstructed'] as const
  const minimumSeparation = options.minimumSeparation ?? DEFAULT_MINIMUM_SEPARATION
  if (minimumSeparation <= 0 || minimumSeparation >= 0.8) {
    throw new RangeError('minimumSeparation must be in (0, 0.8)')
  }
  const obstacleComplexityLevel = options.obstacleComplexityLevel ?? 3
  const scenarios: ResearchScenario[] = []
  let row = 0

  for (const scenarioKind of scenarioKinds) {
    for (const orientationBin of ORIENTATION_BINS) {
      for (let replicate = 0; replicate < options.replicatesPerOrientation; replicate += 1) {
        const worldSeed = seedFor(options.experimentSeed, row, 10_001)
        const sourceSeed = seedFor(options.experimentSeed, row, 20_003)
        const controllerSeed = seedFor(options.experimentSeed, row, 30_011)
        const observationModelSeed = seedFor(options.experimentSeed, row, 40_009)
        const layoutRng = new SeededRandom(worldSeed)
        const sourceRng = new SeededRandom(sourceSeed)
        const obstacles = scenarioKind === 'obstructed'
          ? generateFractalObstacles(worldSeed, obstacleComplexityLevel)
          : []
        const windDirectionDegrees = layoutRng.range(0, 360)
        const targetAngle = ORIENTATION_CENTER_DEGREES[orientationBin] + layoutRng.range(-34, 34)
        let source: Vec2 | null = null
        let robotStart: Vec2 | null = null

        for (let attempt = 0; attempt < MAX_LAYOUT_ATTEMPTS; attempt += 1) {
          const candidateSource = { x: sourceRng.range(0.08, 0.92), y: sourceRng.range(0.08, 0.92) }
          const separation = layoutRng.range(minimumSeparation, 0.62)
          const direction = compassVector(windDirectionDegrees + targetAngle)
          const candidateStart = {
            x: candidateSource.x + direction.x * separation,
            y: candidateSource.y + direction.y * separation,
          }
          if (!isNavigable(candidateSource, obstacles) || !isNavigable(candidateStart, obstacles)) continue
          source = candidateSource
          robotStart = candidateStart
          break
        }
        if (!source || !robotStart) {
          throw new Error(`Could not sample a navigable ${scenarioKind} layout after ${MAX_LAYOUT_ATTEMPTS} attempts`)
        }
        const robotStartHeadingDegrees = layoutRng.range(0, 360)
        const bearing = compassBearing(source, robotStart)
        const sourceWindAngleDegrees = (bearing - windDirectionDegrees + 360) % 360
        const config = {
          ...createDefaultConfig('quad-sniff', scenarioKind),
          seed: worldSeed,
          sourceSeed,
          controllerSeed,
          observationModelSeed,
          scenarioKind,
          windDirectionDegrees,
          obstacleComplexityLevel: scenarioKind === 'obstructed' ? obstacleComplexityLevel : 0,
          sourcePositionOverride: clonePoint(source),
          robotStartPositionOverride: clonePoint(robotStart),
          robotStartHeadingDegrees,
          stopOnNativeDeclaration: false,
        } satisfies SimulationConfig & PlacementOverrides
        scenarios.push({
          id: `${scenarioKind}-${orientationBin}-${replicate}`,
          replicate,
          scenarioKind,
          orientationBin,
          seedPartition: { worldSeed, sourceSeed, controllerSeed, observationModelSeed },
          config,
          privateLayout: {
            source: clonePoint(source),
            robotStart: clonePoint(robotStart),
            robotStartHeadingDegrees,
            sourceToStartBearingDegrees: bearing,
            sourceWindAngleDegrees,
            obstacleSeed: worldSeed,
          },
        })
        row += 1
      }
    }
  }
  return scenarios
}

export type ScenarioValidation = { valid: boolean; errors: string[] }

export const validateResearchScenario = (
  scenario: ResearchScenario,
  minimumSeparation = DEFAULT_MINIMUM_SEPARATION,
): ScenarioValidation => {
  const errors: string[] = []
  const obstacles = scenario.scenarioKind === 'obstructed'
    ? generateFractalObstacles(scenario.seedPartition.worldSeed, scenario.config.obstacleComplexityLevel)
    : []
  const { source, robotStart, sourceWindAngleDegrees } = scenario.privateLayout
  if (!isNavigable(source, obstacles)) errors.push('source is not navigable')
  if (!isNavigable(robotStart, obstacles)) errors.push('robot start is not navigable')
  if (distance(source, robotStart) < minimumSeparation) errors.push('source/start separation is too small')
  const expected = ORIENTATION_CENTER_DEGREES[scenario.orientationBin]
  if (Math.abs(signedAngle(sourceWindAngleDegrees - expected)) > 45) {
    errors.push('source–wind orientation is outside its assigned balance bin')
  }
  if (scenario.config.seed !== scenario.seedPartition.worldSeed) errors.push('world seed mismatch')
  if (scenario.config.sourceSeed !== scenario.seedPartition.sourceSeed) errors.push('source seed mismatch')
  if (scenario.config.controllerSeed !== scenario.seedPartition.controllerSeed) errors.push('controller seed mismatch')
  if (scenario.config.observationModelSeed !== scenario.seedPartition.observationModelSeed) {
    errors.push('observation-model seed mismatch')
  }
  if (new Set(Object.values(scenario.seedPartition)).size !== 4) {
    errors.push('seed roles must use four distinct values')
  }
  return { valid: errors.length === 0, errors }
}

export const validateBalancedScenarioSet = (
  scenarios: readonly ResearchScenario[],
  minimumSeparation = DEFAULT_MINIMUM_SEPARATION,
): ScenarioValidation => {
  const errors = scenarios.flatMap((scenario) =>
    validateResearchScenario(scenario, minimumSeparation).errors.map((error) => `${scenario.id}: ${error}`),
  )
  const counts = new Map<string, number>()
  for (const scenario of scenarios) {
    const key = `${scenario.scenarioKind}|${scenario.orientationBin}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const kind of ['open', 'obstructed'] as const) {
    const values = ORIENTATION_BINS.map((bin) => counts.get(`${kind}|${bin}`) ?? 0)
    if (values.some((value) => value !== values[0])) errors.push(`${kind}: orientation bins are unbalanced`)
  }
  return { valid: errors.length === 0, errors }
}

export type QuadSuctionAblation = {
  id: string
  label: string
  question: string
  configOverrides: Partial<SimulationConfig>
  executableNow: boolean
  status: 'executable' | 'metadata-only'
  rationale: string
}

/**
 * Named contrasts. Metadata-only entries are intentionally not coerced into
 * an unrelated current simulator control.
 */
export const QUAD_SUCTION_ABLATIONS: readonly QuadSuctionAblation[] = [
  {
    id: 'quad-active', label: 'Quad-Suction active', question: 'Does four-channel active sampling improve localisation?',
    configOverrides: { algorithmId: 'quad-sniff', activeSniffEnabled: true, activeSniffStrength: 0.78 },
    executableNow: true, status: 'executable', rationale: 'Current Quad-Sniff controller with calibrated active sampling.',
  },
  {
    id: 'quad-zero-strength-sham', label: 'Timing-matched zero-strength sham', question: 'Is benefit due to remote entrainment rather than cycle timing?',
    configOverrides: { algorithmId: 'quad-sniff', activeSniffEnabled: true, activeSniffStrength: 0 },
    executableNow: true, status: 'executable', rationale: 'Engine retains four-channel geometry and cycle timing but zero strength returns local concentration only.',
  },
  {
    id: 'quad-sampler-disabled', label: 'Quad controller with sampler disabled', question: 'What does the controller do without any four-channel return?',
    configOverrides: { algorithmId: 'quad-sniff', activeSniffEnabled: false },
    executableNow: true, status: 'executable', rationale: 'Runs the same controller with Quad events rejected; interpret as a policy-plus-sensor control, not a matched passive policy.',
  },
  {
    id: 'quad-passive-array', label: 'Four-head passive array', question: 'What incremental benefit comes from active capture beyond four spatially separated passive sensors?',
    configOverrides: { algorithmId: 'quad-passive', activeSniffEnabled: false },
    executableNow: true, status: 'executable', rationale: 'Four physical body-frame sensor locations integrate synchronously with no suction or remote entrainment, while reusing the Quad controller and terminal evidence policy.',
  },
  {
    id: 'quad-single-inlet', label: 'Single-inlet ablation', question: 'Do simultaneous directional channels matter?',
    configOverrides: { algorithmId: 'quad-sniff' },
    executableNow: false, status: 'metadata-only', rationale: 'No current option restricts Quad-Sniff to one channel while preserving its controller and timing.',
  },
  {
    id: 'quad-serial-inlets', label: 'Serial-inlet control', question: 'Does simultaneity avoid plume-time confounding?',
    configOverrides: { algorithmId: 'quad-sniff' },
    executableNow: false, status: 'metadata-only', rationale: 'The engine models only simultaneous four-channel aspiration.',
  },
  {
    id: 'quad-crosstalk-noise', label: 'Correlated-noise stress test', question: 'Are gains robust to pump noise and channel cross-talk?',
    configOverrides: {
      algorithmId: 'quad-sniff',
      quadChannelNoiseCorrelation: 0.6,
      quadChannelCrossTalk: 0.3,
    },
    executableNow: true, status: 'executable', rationale: 'Reduced-order shared-noise and common-mode signal-mixing controls provide a preregistered stress test; values still require hardware calibration.',
  },
]

export const PILOT_MATRIX = {
  name: 'Balanced pilot comparison',
  algorithms: ['coverage', 'surge-cast', 'quad-sniff'] as readonly AlgorithmId[],
  scenarioKinds: ['open', 'obstructed'] as const,
  orientationBins: ORIENTATION_BINS,
  replicatesPerCell: 8,
  fixedBudgetSeconds: 180,
  primaryEndpoint: 'correct terminal declaration by 180 s; report paired per-layout risk differences. Proximity success is secondary; source-absent safety is not yet executable.',
  totalRuns: 3 * 2 * 4 * 8,
  pairing: 'Each algorithm receives the same private layout and all active-sampling controls use the same layout set.',
} as const

export const CONFIRMATORY_MATRIX = {
  name: 'Core held-out balanced comparison',
  algorithms: [
    'coverage',
    'surge-cast',
    'zigzag-spiral',
    'infotaxis',
    'smc-kl',
    'pmfs',
    'pulse-sniff',
    'quad-sniff',
  ] as readonly AlgorithmId[],
  scenarioKinds: ['open', 'obstructed'] as const,
  orientationBins: ORIENTATION_BINS,
  replicatesPerOrientation: 50,
  pairedLayoutsPerScenario: 200,
  fixedBudgetSeconds: 180,
  primaryEndpoint: 'correct terminal declaration by 180 s; paired candidate-minus-reference risk difference with 95% interval. Proximity success is secondary; the matrix is confirmatory-ineligible until source-absent safety trials exist.',
  totalRunsPerPartition: 8 * 2 * 4 * 50,
  pairing: 'Every algorithm receives the same private layout and world/source/controller/observation-model seed quadruplet. Development, validation and test partitions remain disjoint.',
} as const

export const CONVERGENCE_SPECS = {
  gridResolution: {
    physicsMode: 'grid' as const,
    values: [48, 96, 128, 192],
    holdConstant: ['layout seeds', 'controller seeds', 'fixedDt=0.25', 'physicsStepSeconds=0.0125', 'all sensor and active-sampling controls'],
    decision: 'Select the production resolution only after two successive refinements change the paired primary effect by less than the predeclared practical threshold. A 1 m radius on a 100 m domain also requires enough cells to resolve that endpoint.',
  },
  physicsTimeStep: {
    values: [0.05, 0.025, 0.0125],
    holdConstant: ['physics mode=grid', 'grid resolution=96', 'fixedDt=0.25', 'layout seeds', 'controller seeds', 'duration'],
    decision: 'Accept a production physics step only after the 0.025→0.0125 paired change is below the predeclared practical threshold. All requested levels must remain below the solver stability and Courant caps in every paired layout.',
  },
} as const

/** Matched comparison design pending a nonrecursive obstacle generator. */
export const MATCHED_NONRECURSIVE_OBSTACLE_CONTROL = {
  status: 'metadata-only' as const,
  executableNow: false,
  matchOn: ['occupied fraction', 'normalized perimeter', 'source/start placement', 'wind', 'clearance', 'connectivity'],
  recursiveReference: 'bsp-fractal-v1 at the selected obstacle complexity level',
  gap: 'The current simulator has no nonrecursive obstacle generator or topology-matching solver; do not substitute open flow or an unmatched obstacle map.',
} as const

export const ROOT_INTEGRATION_GAPS = [
  'Keep privateLayout out of AlgorithmEnvironment and any controller diagnostics; only the runner/world builder may consume it.',
  'Implement one-channel and serial-channel Quad-Suction modes before treating those ablations as executable.',
  'Implement a topology-matched nonrecursive obstacle generator before running the matched obstacle control.',
  'Add systematic wind-observation bias and time-varying source controls before treating those robustness sweeps as executable.',
] as const
