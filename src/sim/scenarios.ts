import { deterministicNoise } from './rng'
import { generateFractalObstacles } from './fractalObstacles'
import type { Scenario, ScenarioKind, SimulationConfig, Vec2 } from './types'

const OPEN_TEMPLATE: Omit<Scenario, 'source' | 'robotStart' | 'targetStatus'> = {
  kind: 'open',
  name: 'Open flow laboratory',
  shortName: 'Laminar / open',
  description:
    'An obstacle-free domain with a stable prevailing wind and mild plume meander. Appropriate for methods that assume a dominant mean flow.',
  baseWind: { x: -0.052, y: 0.004 },
  turbulence: 0.18,
  gustStrength: 0.12,
  diffusivity: 0.000035,
  emissionRateScale: 1,
  obstacleComplexityLevel: 0,
  terrainSlopeDegrees: 0,
  terrainUphillDirectionDegrees: 0,
  gasBuoyancy: 'neutral',
  terrainGasDriftScale: 1,
  robotSlopeLimitDegrees: 25,
  referenceDiffusivity: 0.000035,
  intermittency: 0.28,
  obstacles: [],
}

const OBSTRUCTED_TEMPLATE: Omit<Scenario, 'source' | 'robotStart' | 'targetStatus'> = {
  kind: 'obstructed',
  name: 'Obstructed process floor',
  shortName: 'Turbulent / obstructed',
  description:
    'A cluttered indoor floor with wakes, intermittent detections and spatially varying local wind around solid obstacles.',
  baseWind: { x: -0.045, y: 0.006 },
  turbulence: 0.62,
  gustStrength: 0.12,
  diffusivity: 0.000095,
  emissionRateScale: 1,
  obstacleComplexityLevel: 3,
  terrainSlopeDegrees: 0,
  terrainUphillDirectionDegrees: 0,
  gasBuoyancy: 'neutral',
  terrainGasDriftScale: 1,
  robotSlopeLimitDegrees: 25,
  referenceDiffusivity: 0.000095,
  intermittency: 0.58,
  obstacles: [],
}

type FlowControls = Pick<
  SimulationConfig,
  | 'windDirectionDegrees'
  | 'windSpeedScale'
  | 'turbulenceScale'
  | 'gustStrength'
  | 'diffusivityScale'
  | 'emissionRateScale'
  | 'obstacleComplexityLevel'
  | 'sourceSeed'
  | 'targetStatus'
  | 'terrainSlopeDegrees'
  | 'terrainUphillDirectionDegrees'
  | 'gasBuoyancy'
  | 'terrainGasDriftScale'
  | 'robotSlopeLimitDegrees'
  | 'sourcePositionOverride'
  | 'robotStartPositionOverride'
  | 'localInletSampling'
> & { domainMeters?: number }

const templateFor = (kind: ScenarioKind) =>
  kind === 'open' ? OPEN_TEMPLATE : OBSTRUCTED_TEMPLATE

export const getScenarioFlowBaseline = (kind: ScenarioKind) => {
  const template = templateFor(kind)
  return {
    windSpeed: Math.hypot(template.baseWind.x, template.baseWind.y),
    turbulence: template.turbulence,
    diffusivity: template.diffusivity,
  }
}

export const createScenario = (
  kind: ScenarioKind,
  seed: number,
  flow: FlowControls,
): Scenario => {
  const source: Vec2 | null = flow.targetStatus === 'absent'
    ? null
    : flow.sourcePositionOverride
      ? { ...flow.sourcePositionOverride }
      : {
          x: 0.82 + deterministicNoise(flow.sourceSeed, 11) * 0.035,
          y: 0.5 + deterministicNoise(flow.sourceSeed, 12) * 0.19,
        }
  const robotStart: Vec2 = flow.robotStartPositionOverride
    ? { ...flow.robotStartPositionOverride }
    : {
        x: 0.105 + deterministicNoise(seed, 21) * 0.025,
        y: 0.5 + deterministicNoise(seed, 22) * 0.3,
      }
  const template = templateFor(kind)
  const baseline = getScenarioFlowBaseline(kind)
  if (flow.localInletSampling && (!Number.isFinite(flow.domainMeters) || flow.domainMeters! <= 0)) {
    throw new RangeError('Physical wind requires a positive SI domain size')
  }
  const heading = (flow.windDirectionDegrees * Math.PI) / 180
  const windSpeed = flow.localInletSampling
    ? flow.localInletSampling.referenceWindMetresPerSecond / flow.domainMeters!
    : baseline.windSpeed * flow.windSpeedScale
  const physicalDiffusivity = flow.localInletSampling?.effectiveDiffusivityMetresSquaredPerSecond
  if (physicalDiffusivity !== undefined && (!Number.isFinite(physicalDiffusivity) || physicalDiffusivity <= 0 || flow.diffusivityScale !== 1)) {
    throw new RangeError('Invalid SI diffusivity or conflicting multiplier')
  }
  const diffusivity = physicalDiffusivity === undefined ? baseline.diffusivity * flow.diffusivityScale
    : physicalDiffusivity / flow.domainMeters! ** 2
  const obstacles =
    kind === 'obstructed'
      ? generateFractalObstacles(seed, flow.obstacleComplexityLevel)
      : []
  const overriddenPointInsideObstacle = (
    point: Vec2 | null,
    wasOverridden: boolean,
  ) => point !== null && wasOverridden && obstacles.some((obstacle) =>
    point.x >= obstacle.x &&
    point.x <= obstacle.x + obstacle.width &&
    point.y >= obstacle.y &&
    point.y <= obstacle.y + obstacle.height)
  if (overriddenPointInsideObstacle(source, Boolean(flow.sourcePositionOverride))) {
    throw new RangeError('sourcePositionOverride intersects an obstacle')
  }
  if (overriddenPointInsideObstacle(robotStart, Boolean(flow.robotStartPositionOverride))) {
    throw new RangeError('robotStartPositionOverride intersects an obstacle')
  }
  return {
    ...template,
    source,
    targetStatus: flow.targetStatus,
    robotStart,
    baseWind: {
      x: Math.sin(heading) * windSpeed,
      y: -Math.cos(heading) * windSpeed,
    },
    turbulence: Math.min(1.5, baseline.turbulence * flow.turbulenceScale),
    gustStrength: flow.gustStrength,
    diffusivity,
    ...(physicalDiffusivity !== undefined ? { referenceDiffusivity: diffusivity } : {}),
    emissionRateScale: flow.emissionRateScale,
    obstacleComplexityLevel: kind === 'obstructed' ? flow.obstacleComplexityLevel : 0,
    terrainSlopeDegrees: flow.terrainSlopeDegrees,
    terrainUphillDirectionDegrees: flow.terrainUphillDirectionDegrees,
    gasBuoyancy: flow.gasBuoyancy,
    terrainGasDriftScale: flow.terrainGasDriftScale,
    robotSlopeLimitDegrees: flow.robotSlopeLimitDegrees,
    obstacles,
  }
}
