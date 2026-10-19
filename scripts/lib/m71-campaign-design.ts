import { createHash } from 'node:crypto'
import type { AlgorithmId, ScenarioKind, TargetStatus } from '../../src/sim/types'

export const M71_SCHEMA_VERSION = 'm71-locked-publication-campaign-v1'
export const M71_SEED_BASE = 71_000_000
export const M71_REPLICATES = 30

export const M71_ALGORITHMS: AlgorithmId[] = [
  'coverage',
  'surge-cast',
  'infotaxis',
  'smc-kl',
  'pmfs',
  'quad-passive',
  'quad-sniff-wind',
  'quad-sniff-refine',
]

export type M71SoilCase = {
  case_id: string
  texture: 'sand' | 'clay'
  water_saturation: number
  emission_scale_relative_to_sand_sw_0p2: number
}

type SensorStratum = {
  id: 'low-burden' | 'reference' | 'high-burden'
  sensorNoise: number
  sensorLagSeconds: number
}

export type M71Cell = {
  index: number
  id: string
  family: 'core' | 'obstacle-transfer' | 'slope-transfer' | 'safety'
  soilCaseId: string | null
  scenario: ScenarioKind
  windDirectionDegrees: number
  sensor: SensorStratum
  obstacleComplexityLevel: number
  terrainSlopeDegrees: number
  terrainUphillDirectionDegrees: number
  targetStatus: TargetStatus
  emissionRateScale: number
}

const sensors: SensorStratum[] = [
  { id: 'low-burden', sensorNoise: 0.01, sensorLagSeconds: 0.05 },
  { id: 'reference', sensorNoise: 0.025, sensorLagSeconds: 0.5 },
  { id: 'high-burden', sensorNoise: 0.05, sensorLagSeconds: 5 },
]
const winds = [0, 90, 180, 270]
const scenarios: ScenarioKind[] = ['open', 'obstructed']

const canonical = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
    : value

export const m71StableJson = (value: unknown) => `${JSON.stringify(canonical(value), null, 2)}\n`
export const m71Sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex')

export const buildM71Cells = (soilCases: M71SoilCase[]): M71Cell[] => {
  const rows: Omit<M71Cell, 'index' | 'id'>[] = []
  const add = (row: Omit<M71Cell, 'index' | 'id'>) => rows.push(row)

  for (const soil of soilCases) for (const scenario of scenarios) for (const wind of winds) for (const sensor of sensors) {
    add({
      family: 'core', soilCaseId: soil.case_id, scenario, windDirectionDegrees: wind,
      sensor, obstacleComplexityLevel: scenario === 'obstructed' ? 3 : 0,
      terrainSlopeDegrees: 0, terrainUphillDirectionDegrees: 0,
      targetStatus: 'emitting', emissionRateScale: soil.emission_scale_relative_to_sand_sw_0p2,
    })
  }

  const midpointSoils = soilCases.filter((soil) => soil.water_saturation === 0.5)
  const reference = sensors.find((sensor) => sensor.id === 'reference')!
  for (const soil of midpointSoils) for (const complexity of [1, 3, 5]) for (const wind of winds) {
    add({
      family: 'obstacle-transfer', soilCaseId: soil.case_id, scenario: 'obstructed',
      windDirectionDegrees: wind, sensor: reference, obstacleComplexityLevel: complexity,
      terrainSlopeDegrees: 0, terrainUphillDirectionDegrees: 0,
      targetStatus: 'emitting', emissionRateScale: soil.emission_scale_relative_to_sand_sw_0p2,
    })
  }

  for (const soil of midpointSoils) for (const scenario of scenarios) for (const wind of winds) {
    for (const slope of [10, 20]) for (const relativeUphill of [0, 180]) {
      add({
        family: 'slope-transfer', soilCaseId: soil.case_id, scenario,
        windDirectionDegrees: wind, sensor: reference,
        obstacleComplexityLevel: scenario === 'obstructed' ? 3 : 0,
        terrainSlopeDegrees: slope,
        terrainUphillDirectionDegrees: (wind + relativeUphill) % 360,
        targetStatus: 'emitting', emissionRateScale: soil.emission_scale_relative_to_sand_sw_0p2,
      })
    }
  }

  for (const targetStatus of ['zero-emission', 'absent'] as const) {
    for (const scenario of scenarios) for (const wind of winds) for (const sensor of sensors) {
      add({
        family: 'safety', soilCaseId: null, scenario, windDirectionDegrees: wind,
        sensor, obstacleComplexityLevel: scenario === 'obstructed' ? 3 : 0,
        terrainSlopeDegrees: 0, terrainUphillDirectionDegrees: 0,
        // The engine suppresses emission from targetStatus. Keep the otherwise
        // inactive normalization parameter inside its declared positive range.
        targetStatus, emissionRateScale: 1,
      })
    }
  }

  return rows.map((row, index) => {
    const soil = row.soilCaseId ?? 'none'
    const id = [row.family, soil, row.scenario, `w${row.windDirectionDegrees}`,
      row.sensor.id, `o${row.obstacleComplexityLevel}`, `s${row.terrainSlopeDegrees}`,
      `u${row.terrainUphillDirectionDegrees}`, row.targetStatus].join('__')
    return { index, id, ...row }
  })
}

export const buildM71Manifest = (soilCases: M71SoilCase[], simulatorVersion: string) => {
  const cells = buildM71Cells(soilCases)
  const familyCounts = Object.fromEntries(['core', 'obstacle-transfer', 'slope-transfer', 'safety']
    .map((family) => [family, cells.filter((cell) => cell.family === family).length]))
  const body = {
    schemaVersion: M71_SCHEMA_VERSION,
    simulatorVersion,
    scientificStatus: 'locked computational benchmark; not field validation or product ranking',
    candidate: 'quad-sniff-refine',
    comparatorRoles: {
      classical: ['coverage', 'surge-cast'],
      probabilistic: ['infotaxis', 'smc-kl', 'pmfs'],
      mechanismControls: ['quad-passive', 'quad-sniff-wind'],
    },
    algorithms: M71_ALGORITHMS,
    replicatesPerCell: M71_REPLICATES,
    seedBase: M71_SEED_BASE,
    mission: { domainMeters: 100, durationSeconds: 180, normalizedSuccessRadius: 0.01 },
    design: {
      cells: cells.length,
      familyCounts,
      plannedRuns: cells.length * M71_ALGORITHMS.length * M71_REPLICATES,
      pairedSeedsWithinCell: true,
      core: '6 soil flux regimes x 2 geometries x 4 wind directions x 3 abstract sensor burdens',
      obstacleTransfer: 'mid-saturation sand/clay x complexity 1/3/5 x 4 winds; reference sensor',
      slopeTransfer: 'mid-saturation sand/clay x 2 geometries x 10/20 degrees x aligned/opposed uphill x 4 winds; reference sensor',
      safety: 'zero-emission and absent x 2 geometries x 4 winds x 3 sensor burdens',
    },
    sensorInterpretation: 'dimensionless low/reference/high burden strata; commercial presets remain illustrative supplementary mappings',
    soilInterpretation: 'M60 homogeneous fixed-moisture flux coupling; no lateral subsurface migration or field calibration',
    primaryOutcomes: [
      'correct declaration or correct rejection', 'normalized localization error',
      'time', 'path length', 'plume contacts', 'compute time',
    ],
    cells,
  }
  return { ...body, manifestSha256: m71Sha256(m71StableJson(body)) }
}
