/**
 * Frozen design generator for numerical-convergence and nuisance robustness
 * studies. This module only writes a manifest: it intentionally has no runner
 * so sensitivity work cannot be mistaken for the primary held-out benchmark.
 */
import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createBalancedResearchScenarios,
  validateResearchScenario,
  type OrientationBin,
} from '../src/sim/research/scenarioAblations'
import { validateSimulationConfig } from '../src/sim/config'
import type { AlgorithmId, ScenarioKind, SimulationConfig } from '../src/sim/types'

export const CONVERGENCE_ROBUSTNESS_SCHEMA_VERSION = 'convergence-robustness-manifest-v2'

type ExecutableSweep = {
  id: string
  title: string
  parameter: keyof SimulationConfig
  values: readonly number[]
  baseline: number
  rationale: string
}

type PlaceholderSweep = {
  id: string
  title: string
  status: 'placeholder'
  rationale: string
  requiredCoreCapability: string
}

const EXECUTABLE_NUISANCE_SWEEPS: readonly ExecutableSweep[] = [
  { id: 'sensor-noise', title: 'Independent sensor noise', parameter: 'sensorNoise', values: [0, 0.025, 0.05], baseline: 0.025, rationale: 'Current independent per-sample noise control.' },
  { id: 'sensor-lag', title: 'Sensor lag', parameter: 'sensorLag', values: [0.025, 0.05, 0.1], baseline: 0.05, rationale: 'Current scalar sensor-dynamics lag control.' },
  { id: 'wind-noise', title: 'Wind-direction noise', parameter: 'windNoise', values: [0, 0.07, 0.14], baseline: 0.07, rationale: 'Current random wind-observation perturbation.' },
  { id: 'detection-threshold', title: 'Detection threshold scale', parameter: 'sensorThresholdScale', values: [0.8, 1, 1.2], baseline: 1, rationale: 'Current detection-threshold calibration control.' },
  { id: 'false-positive-rate', title: 'Sensor false-positive rate', parameter: 'sensorFalsePositiveRate', values: [0, 0.02, 0.05], baseline: 0, rationale: 'Current independent false-positive mechanism.' },
  { id: 'false-negative-rate', title: 'Sensor false-negative rate', parameter: 'sensorFalseNegativeRate', values: [0, 0.05, 0.1], baseline: 0, rationale: 'Current independent false-negative mechanism.' },
  { id: 'channel-correlation', title: 'Cross-channel correlated noise', parameter: 'quadChannelNoiseCorrelation', values: [0, 0.3, 0.6], baseline: 0, rationale: 'Quad-only shared/independent white-noise sensitivity proxy.' },
  { id: 'channel-gain-mismatch', title: 'Channel gain mismatch', parameter: 'quadChannelGainMismatch', values: [0, 0.1, 0.2], baseline: 0, rationale: 'Deterministic Quad channel gain-pattern sensitivity proxy.' },
  { id: 'channel-crosstalk', title: 'Channel cross-talk', parameter: 'quadChannelCrossTalk', values: [0, 0.15, 0.3], baseline: 0, rationale: 'Quad signal mixing with the four-channel mean.' },
  { id: 'channel-lag-mismatch', title: 'Channel lag mismatch', parameter: 'quadChannelLagMismatch', values: [0, 0.2, 0.4], baseline: 0, rationale: 'Deterministic Quad channel response-time sensitivity proxy.' },
]

const PLACEHOLDER_NUISANCE_SWEEPS: readonly PlaceholderSweep[] = [
  { id: 'wind-bias', title: 'Systematic wind-heading bias', status: 'placeholder', rationale: 'windNoise is zero-mean random perturbation, not a calibrated directional bias.', requiredCoreCapability: 'wind-observation bias control independent of the physical plume wind' },
  { id: 'source-motion', title: 'Moving or drifting source', status: 'placeholder', rationale: 'The source is static for an engine run.', requiredCoreCapability: 'time-varying source trajectory model' },
]

const METHOD_ARMS = [
  { id: 'surge-cast', algorithmId: 'surge-cast' as AlgorithmId },
  { id: 'quad-active', algorithmId: 'quad-sniff' as AlgorithmId, configOverrides: { activeSniffEnabled: true, activeSniffStrength: 0.78 } },
] as const

export type ConvergenceRobustnessCell = {
  id: string
  partition: 'development'
  study: 'grid-resolution' | 'time-step' | 'nuisance'
  sweepId: string
  value: number
  baselineValue: number
  pairingKey: string
  scenarioKind: ScenarioKind
  orientationBin: OrientationBin
  replicate: number
  config: SimulationConfig
}

export type ConvergenceRobustnessManifest = {
  schemaVersion: typeof CONVERGENCE_ROBUSTNESS_SCHEMA_VERSION
  partition: 'development'
  purpose: 'numerical convergence and robustness only; never pool with primary confirmatory analysis'
  methodArms: typeof METHOD_ARMS
  layoutsPerVariant: number
  executableSweeps: Array<Omit<ExecutableSweep, 'parameter'> & { parameter: string }>
  placeholderSweeps: readonly PlaceholderSweep[]
  cells: ConvergenceRobustnessCell[]
}

const stableJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

const gridResolutions = [48, 96, 128, 192] as const
// Keep requested levels below the 96² diffusion/Courant caps so each level is
// an effective solver intervention rather than being silently clipped.
const physicsTimeSteps = [0.05, 0.025, 0.0125] as const

const copyConfig = (config: SimulationConfig): SimulationConfig => ({
  ...config,
  checkpointSeconds: [...config.checkpointSeconds],
  sourcePositionOverride: config.sourcePositionOverride && { ...config.sourcePositionOverride },
  robotStartPositionOverride: config.robotStartPositionOverride && { ...config.robotStartPositionOverride },
})

export const createConvergenceRobustnessManifest = (): ConvergenceRobustnessManifest => {
  // A small development-only layout bank keeps every parameter level paired.
  const layouts = createBalancedResearchScenarios({
    experimentSeed: 1_310_071,
    replicatesPerOrientation: 2,
  })
  const cells: ConvergenceRobustnessCell[] = []
  const append = (
    study: ConvergenceRobustnessCell['study'],
    sweepId: string,
    value: number,
    baselineValue: number,
    change: Partial<SimulationConfig>,
  ) => {
    for (const layout of layouts) {
      const validation = validateResearchScenario(layout)
      if (!validation.valid) throw new Error(`${layout.id}: ${validation.errors.join('; ')}`)
      const config = { ...copyConfig(layout.config), ...change, checkpointSeconds: [30, 60, 120, 180], stopOnNativeDeclaration: false }
      validateSimulationConfig(config)
      const pairingKey = `${layout.scenarioKind}|${layout.orientationBin}|${layout.replicate}`
      cells.push({
        id: `${study}-${sweepId}-${String(value).replace('.', 'p')}-${layout.id}`,
        partition: 'development',
        study,
        sweepId,
        value,
        baselineValue,
        pairingKey,
        scenarioKind: layout.scenarioKind,
        orientationBin: layout.orientationBin,
        replicate: layout.replicate,
        config,
      })
    }
  }

  for (const value of gridResolutions) {
    append('grid-resolution', 'grid-resolution', value, 96, { physicsMode: 'grid', gridResolution: value, fixedDt: 0.25, physicsStepSeconds: 0.0125 })
  }
  for (const value of physicsTimeSteps) {
    append('time-step', 'physics-step-seconds', value, 0.25, { physicsMode: 'grid', gridResolution: 96, fixedDt: 0.25, physicsStepSeconds: value })
  }
  for (const sweep of EXECUTABLE_NUISANCE_SWEEPS) {
    for (const value of sweep.values) append('nuisance', sweep.id, value, sweep.baseline, { [sweep.parameter]: value })
  }

  return {
    schemaVersion: CONVERGENCE_ROBUSTNESS_SCHEMA_VERSION,
    partition: 'development',
    purpose: 'numerical convergence and robustness only; never pool with primary confirmatory analysis',
    methodArms: METHOD_ARMS,
    layoutsPerVariant: layouts.length,
    executableSweeps: EXECUTABLE_NUISANCE_SWEEPS.map(({ parameter, ...sweep }) => ({ ...sweep, parameter })),
    placeholderSweeps: PLACEHOLDER_NUISANCE_SWEEPS,
    cells,
  }
}

export const writeConvergenceRobustnessManifest = async (outputDirectory: string) => {
  const manifest = createConvergenceRobustnessManifest()
  const manifestSha256 = digest(manifest)
  await mkdir(outputDirectory, { recursive: true })
  const outputPath = join(outputDirectory, 'convergence-robustness-manifest.json')
  const temporaryPath = `${outputPath}.tmp`
  await writeFile(temporaryPath, stableJson({ ...manifest, manifestSha256 }), 'utf8')
  await rename(temporaryPath, outputPath)
  return { manifest, manifestSha256, outputPath }
}
