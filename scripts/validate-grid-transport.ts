/**
 * Bounded normalized 2-D scalar-transport verification (no policy benchmark).
 * Run: node node_modules/vite-node/vite-node.mjs scripts/validate-grid-transport.ts
 * Optional: --output path/to/report.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDefaultConfig } from '../src/sim/config'
import { GridPlume } from '../src/sim/gridPlume'
import { createScenario } from '../src/sim/scenarios'
import type { GridTransportVersion, Scenario } from '../src/sim/types'

const referenceMass = 2 * Math.PI * 0.015 ** 2 * (1 - Math.exp(-4.5))
const conservative: GridTransportVersion = 'conservative-upwind-v1'
const legacy: GridTransportVersion = 'legacy-semi-lagrangian-v1'
const sourceRate = 0.01
const common = (overrides: Partial<Scenario> = {}): Scenario => ({
  ...createScenario('open', 71, createDefaultConfig()),
  source: { x: 0.25, y: 0.5 },
  baseWind: { x: 0.065, y: 0 },
  turbulence: 0, gustStrength: 0, diffusivity: 0, referenceDiffusivity: 0,
  intermittency: 0, obstacles: [],
  ...overrides,
})

const runWall = (resolution: number, requestedStepSeconds: number, transportVersion: GridTransportVersion) => {
  const plume = new GridPlume(common({ obstacles: [
    { id: 'wall', x: 0.45, y: 0, width: 0.1, height: 1 },
  ] }), 4, {
    resolution, stepSeconds: requestedStepSeconds, transportVersion,
    decaySeconds: 1e9, sourceRate,
  })
  const time = 6
  const snapshot = plume.gridAt(time)
  const currentMass = snapshot.values.reduce((a, b) => a + b, 0) / resolution ** 2
  const independentInitialMass = referenceMass * 0.35 * sourceRate / 1.8
  const independentInjectedMass = referenceMass * sourceRate * time
  const expectedWithoutDecay = independentInitialMass + independentInjectedMass
  const budget = snapshot.massBudget
  return {
    resolution, requestedStepSeconds, actualStepSeconds: plume.stepSeconds,
    transportVersion, time, independentInitialMass, independentInjectedMass,
    currentMass, relativeDifferenceIgnoringNegligibleDecay:
      (currentMass - expectedWithoutDecay) / expectedWithoutDecay,
    maximumConcentration: Math.max(...snapshot.values),
    budget,
    relativeBudgetResidual: budget ? budget.balanceResidual / expectedWithoutDecay : null,
  }
}

const moments = (values: number[], n: number) => {
  let total = 0
  let first = 0
  let second = 0
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!
    const x = ((index % n) + 0.5) / n
    total += value
    first += x * value
    second += x * x * value
  }
  const mean = first / total
  return { mass: total / n ** 2, meanX: mean, varianceX: second / total - mean * mean }
}

const runSmooth = (resolution: number, requestedStepSeconds: number) => {
  const time = 2
  const wind = 0.065
  const plume = new GridPlume(common(), 4, {
    resolution, stepSeconds: requestedStepSeconds, transportVersion: conservative,
    decaySeconds: 1e12, sourceRate,
  })
  const snapshot = plume.gridAt(time)
  const measured = moments(snapshot.values, resolution)
  // Exact continuum moments for the same 3-sigma radial source and constant
  // emission in a uniform, divergence-free velocity field on an unbounded plane.
  // Outer-boundary truncation is measured separately in the budget below.
  const initialMass = referenceMass * 0.35 * sourceRate / 1.8
  const emission = referenceMass * sourceRate
  const exactMass = initialMass + emission * time
  const meanAge = (initialMass * time + emission * time ** 2 / 2) / exactMass
  const secondAge = (initialMass * time ** 2 + emission * time ** 3 / 3) / exactMass
  const sigma = 0.012 // Identical physical source width at n >= 64.
  const sourceVariance = sigma ** 2 * (1 - 5.5 * Math.exp(-4.5)) / (1 - Math.exp(-4.5))
  const exactMean = 0.25 + wind * meanAge
  const exactVariance = sourceVariance + wind ** 2 * (secondAge - meanAge ** 2)
  return {
    resolution, requestedStepSeconds, actualStepSeconds: plume.stepSeconds, time,
    measured, exact: { mass: exactMass, meanX: exactMean, varianceX: exactVariance },
    absoluteMeanError: Math.abs(measured.meanX - exactMean),
    absoluteVarianceError: Math.abs(measured.varianceX - exactVariance),
    budget: snapshot.massBudget,
  }
}

const wall = [32, 64, 128].flatMap((resolution) =>
  [0.025, 0.05, 0.1].flatMap((step) => [legacy, conservative].map((version) => runWall(resolution, step, version))),
)
const spatialRefinement = [64, 128, 256].map((n) => runSmooth(n, 0.2 / (n * 0.065)))
const temporalRefinement = [0.1, 0.05, 0.025].map((dt) => runSmooth(128, dt))

const boundary = new GridPlume(common({ source: { x: 0.99, y: 0.99 }, baseWind: { x: 0.1, y: 0.07 } }), 4, {
  resolution: 32, stepSeconds: 0.01, decaySeconds: 1e9, sourceRate, transportVersion: conservative,
})
const initialBoundary = boundary.gridAt(0).values
let independentOutflow = 0
for (let i = 0; i < 32; i += 1) {
  independentOutflow += 0.01 / 32 * (0.1 * initialBoundary[i * 32 + 31]! + 0.07 * initialBoundary[31 * 32 + i]!)
}
const exteriorOutflow = { independentOutflow, budget: boundary.massBudgetAt(0.01)! }

const decayStep = 0.05
const decayTime = 2
const decaySeconds = 0.8
const decay = new GridPlume(common({ baseWind: { x: 0, y: 0 } }), 4, {
  resolution: 32, stepSeconds: decayStep, decaySeconds, sourceRate, transportVersion: conservative,
})
const initialMass = referenceMass * 0.35 * sourceRate / 1.8
const exactSplitMass = initialMass * Math.exp(-decayTime / decaySeconds) + referenceMass * sourceRate * decayStep *
  (1 - Math.exp(-decayTime / decaySeconds)) / (1 - Math.exp(-decayStep / decaySeconds))
const decayBudget = { exactSplitMass, budget: decay.massBudgetAt(decayTime)! }

const clipping = new GridPlume(common({ baseWind: { x: 0, y: 0 } }), 4, {
  resolution: 32, stepSeconds: 0.05, decaySeconds: 1e9, sourceRate: 80, transportVersion: conservative,
}).massBudgetAt(0.2)!

const monotoneHalving = (values: number[]) => values.slice(1).every((value, i) => value < values[i]! * 0.6)
const conservativeWalls = wall.filter((row) => row.transportVersion === conservative)
const checks = {
  legacyWallLossReproduced: wall.filter((row) => row.transportVersion === legacy)
    .every((row) => row.relativeDifferenceIgnoringNegligibleDecay < -0.4),
  conservativeWallRelativeResidualBelow1eMinus12: conservativeWalls
    .every((row) => Math.abs(row.relativeBudgetResidual!) < 1e-12),
  wallSourceMatchesIndependentIntegral: conservativeWalls
    .every((row) => Math.abs(row.budget!.injectedMass - row.independentInjectedMass) < 1e-14),
  wallHasNoOutflowOrClipping: conservativeWalls.every((row) => row.budget!.boundaryOutflowMass === 0 &&
    row.budget!.upperClippingLossMass === 0 && row.budget!.lowerClippingGainMass === 0),
  spatialVarianceErrorDecreases: monotoneHalving(spatialRefinement.map((row) => row.absoluteVarianceError)),
  temporalMeanErrorDecreases: monotoneHalving(temporalRefinement.map((row) => row.absoluteMeanError)),
  smoothBoundaryOutflowNegligible: [...spatialRefinement, ...temporalRefinement]
    .every((row) => row.budget!.boundaryOutflowMass < 1e-12),
  boundaryFluxMatchesIndependentIntegral: Math.abs(exteriorOutflow.budget.boundaryOutflowMass - independentOutflow) < 1e-15,
  decayMatchesIntegratedClosedForm: Math.abs(decayBudget.budget.currentMass - exactSplitMass) < 1e-14,
  clippingMeasuredAndBalanceCloses: clipping.initialClippingLossMass > 0 && clipping.upperClippingLossMass > 0 &&
    clipping.lowerClippingGainMass === 0 && Math.abs(clipping.balanceResidual) < 1e-13,
}
const report = {
  schemaVersion: 1,
  runtime: { node: process.version },
  scope: 'Normalized 2D prescribed-flow scalar transport. No SI calibration, airflow solve, or navigation benchmark.',
  wallQualification: 'Constant imposed wind into a full-height wall is not a self-consistent incompressible wall flow. This fixture tests zero scalar face flux and source/sink accounting for an accepted prescribed-flow scenario.',
  smoothReference: 'Uniform divergence-free flow; continuum first/second moments of a radially truncated Gaussian initial field plus constant emission. The source sigma is fixed at 0.012 for all smooth-grid resolutions.',
  schemeOrder: 'First-order upwind advection, midpoint-frozen velocity, explicit diffusion, then exact exponential decay and source injection. Space/time errors are expected and reported.',
  passed: Object.values(checks).every(Boolean), checks,
  wall, spatialRefinement, temporalRefinement, exteriorOutflow, decayBudget, clipping,
}
const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--output')) {
  throw new Error('Usage: validate-grid-transport.ts [--output path.json]')
}
const json = JSON.stringify(report, null, 2) + '\n'
if (args[1]) {
  mkdirSync(dirname(args[1]), { recursive: true })
  writeFileSync(args[1], json)
}
console.log(json.trimEnd())
if (!report.passed) process.exitCode = 1
