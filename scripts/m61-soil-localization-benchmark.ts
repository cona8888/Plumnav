/** Locked sand/clay × saturation localization benchmark.
 *
 * Soil surface delivery is generated separately by M60, then coupled to the
 * dimensionless atmospheric simulator only through a relative emission scale.
 * This intentionally does not imply a resolved 3-D soil/air interface.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { batchResultsToCsv, runBatch } from '../src/sim/batch'
import { createDefaultConfig, SIMULATOR_VERSION } from '../src/sim/config'
import type { AlgorithmId, BatchResult, ScenarioKind } from '../src/sim/types'

const SCHEMA_VERSION = 'm61-soil-localization-benchmark-v1'
const ALGORITHMS: AlgorithmId[] = [
  'coverage', 'surge-cast', 'infotaxis', 'quad-passive', 'quad-sniff-staged', 'quad-sniff',
]
const SCENARIOS: ScenarioKind[] = ['open', 'obstructed']

type SoilCase = {
  case_id: string
  texture: 'sand' | 'clay'
  water_saturation: number
  porosity: number
  intrinsic_permeability_m2: number
  gas_relative_permeability: number
  bulk_diffusivity_m2_s: number
  gas_pore_peclet: number
  gas_pore_fourier: number
  advective_pore_volumes: number
  emission_scale_relative_to_sand_sw_0p2: number
}
type SoilContract = { schema_version: string; cases: SoilCase[] }

const canonical = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
    : value
const stableJson = (value: unknown) => `${JSON.stringify(canonical(value), null, 2)}\n`
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

const quantile = (values: number[], q: number) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * q
  const lo = Math.floor(position); const hi = Math.ceil(position)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (position - lo)
}
const median = (values: number[]) => quantile(values, 0.5)!

const summarize = (records: Array<BatchResult & { soilCase: SoilCase }>) => {
  const groups = new Map<string, typeof records>()
  for (const row of records) {
    const key = [row.soilCase.case_id, row.scenarioKind, row.algorithmId].join('|')
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.entries()].map(([key, rows]) => {
    const errors = rows.map(row => row.metrics.normalizedError).filter((v): v is number => v !== null)
    const declarationTimes = rows.map(row => row.metrics.declarationTimeSeconds).filter((v): v is number => v !== null)
    return {
      key,
      soil_case_id: rows[0]!.soilCase.case_id,
      texture: rows[0]!.soilCase.texture,
      water_saturation: rows[0]!.soilCase.water_saturation,
      emission_scale: rows[0]!.soilCase.emission_scale_relative_to_sand_sw_0p2,
      scenario: rows[0]!.scenarioKind,
      algorithm: rows[0]!.algorithmId,
      runs: rows.length,
      proximity_success_rate: rows.filter(row => row.metrics.success).length / rows.length,
      correct_declaration_rate: rows.filter(row => row.metrics.terminalOutcome === 'correct-declaration').length / rows.length,
      declaration_rate: rows.filter(row => row.metrics.nativeDeclaration).length / rows.length,
      wrong_declaration_rate: rows.filter(row => row.metrics.terminalOutcome === 'wrong-declaration').length / rows.length,
      median_normalized_error: errors.length ? median(errors) : null,
      p90_normalized_error: quantile(errors, 0.9),
      median_declaration_time_s: declarationTimes.length ? median(declarationTimes) : null,
      median_path_m: median(rows.map(row => row.metrics.pathLengthMeters)),
      median_plume_contacts: median(rows.map(row => row.metrics.contactEpisodes)),
    }
  })
}

const main = async () => {
  const args = process.argv.slice(2)
  const mode = args.includes('--pilot') ? 'pilot' : 'locked-benchmark'
  const outputIndex = args.indexOf('--output')
  const output = resolve(outputIndex >= 0 ? args[outputIndex + 1]! :
    `research/evidence/m61_soil_localization_${mode.replace('-', '_')}`)
  const replicatesIndex = args.indexOf('--replicates')
  const replicates = replicatesIndex >= 0 ? Number(args[replicatesIndex + 1]) : mode === 'pilot' ? 1 : 12
  if (!Number.isInteger(replicates) || replicates < 1) throw new RangeError('replicates must be a positive integer')

  const contractPath = resolve('research/protocols/m60_soil_regimes/soil-regime-contract.json')
  const contractText = await readFile(contractPath, 'utf8')
  const contract = JSON.parse(contractText) as SoilContract
  if (contract.schema_version !== 'm60-homogeneous-soil-regimes-v1' || contract.cases.length !== 6) {
    throw new Error('M60 soil contract identity is invalid')
  }
  const selectedCases = mode === 'pilot'
    ? contract.cases.filter(row => row.case_id === 'sand-sw-0p2' || row.case_id === 'clay-sw-0p8')
    : contract.cases
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    mode,
    simulatorVersion: SIMULATOR_VERSION,
    soilContractSha256: sha256(contractText),
    candidate: 'quad-sniff',
    baselines: ['coverage', 'surge-cast', 'infotaxis'],
    controls: {
      passiveFourHead: 'quad-passive',
      frozenPreGeometryPolicy: 'quad-sniff-staged',
    },
    algorithms: ALGORITHMS,
    scenarios: SCENARIOS,
    soilCaseIds: selectedCases.map(row => row.case_id),
    replicates,
    plannedRuns: selectedCases.length * SCENARIOS.length * ALGORITHMS.length * replicates,
    target: 'known surface-emergence coordinate; homogeneous column assumes no lateral displacement',
    coupling: 'M60 seven-day surface flux divided by the sand-Sw0.2 flux; relative scale only',
    measurementContract: {
      sensorProfileId: 'normalized-reference', sensorNoise: 0.025, sensorLagSeconds: 0.05,
      detectionThreshold: 'scenario default', simultaneousHeads: 'engine-specific; candidate uses four active returns',
    },
    mission: { domainMeters: 100, durationSeconds: 180, successThresholdNormalized: 0.01 },
    partition: mode === 'pilot' ? 'development endpoint smoke' : 'locked seeds not used in pilot',
    seedBase: mode === 'pilot' ? 61_000 : 610_000,
    interpretation: 'computational sensitivity benchmark, not field validation or product ranking',
  }
  await mkdir(output, { recursive: true })
  await writeFile(resolve(output, 'manifest.json'), stableJson({ ...manifest, manifestSha256: sha256(stableJson(manifest)) }))

  const records: Array<BatchResult & { soilCase: SoilCase }> = []
  let block = 0
  for (const soilCase of selectedCases) for (const scenario of SCENARIOS) {
    const base = createDefaultConfig('coverage', scenario)
    base.seed = manifest.seedBase + block * 1_000_003
    base.sourceSeed = manifest.seedBase + 17 + block * 1_000_033
    base.controllerSeed = manifest.seedBase + 29 + block * 1_000_037
    base.observationModelSeed = manifest.seedBase + 43 + block * 1_000_081
    base.emissionRateScale = soilCase.emission_scale_relative_to_sand_sw_0p2
    base.checkpointSeconds = [180]
    base.stopOnNativeDeclaration = false
    const batch = await runBatch(base, ALGORITHMS, [scenario], replicates)
    records.push(...batch.results.map(row => ({ ...row, soilCase })))
    block += 1
    process.stdout.write(`completed ${block}/${selectedCases.length * SCENARIOS.length}: ${soilCase.case_id}/${scenario}\n`)
  }

  const raw = records.map(({ soilCase, ...row }) => ({ soil_case: soilCase, result: row }))
  await writeFile(resolve(output, 'raw-results.json'), stableJson(raw))
  const csvHeader = [
    'soil_case_id', 'soil_texture', 'water_saturation', 'soil_porosity',
    'intrinsic_permeability_m2', 'gas_relative_permeability', 'bulk_diffusivity_m2_s',
    'gas_pore_peclet', 'gas_pore_fourier', 'advective_pore_volumes', 'soil_emission_scale',
  ]
  const engineCsv = batchResultsToCsv(records)
  const [engineHeader, ...engineRows] = engineCsv.split('\n')
  const csvRows = records.map((row, index) => [
    row.soilCase.case_id, row.soilCase.texture, row.soilCase.water_saturation,
    row.soilCase.porosity, row.soilCase.intrinsic_permeability_m2,
    row.soilCase.gas_relative_permeability, row.soilCase.bulk_diffusivity_m2_s,
    row.soilCase.gas_pore_peclet, row.soilCase.gas_pore_fourier,
    row.soilCase.advective_pore_volumes, row.soilCase.emission_scale_relative_to_sand_sw_0p2,
    engineRows[index],
  ].join(','))
  await writeFile(resolve(output, 'results.csv'), `${csvHeader.join(',')},${engineHeader}\n${csvRows.join('\n')}\n`)
  const summary = {
    schemaVersion: `${SCHEMA_VERSION}-summary`,
    manifestSha256: sha256(stableJson(manifest)),
    completedRuns: records.length,
    allRowsRetained: records.length === manifest.plannedRuns,
    cells: summarize(records),
  }
  await writeFile(resolve(output, 'summary.json'), stableJson(summary))
  process.stdout.write(`${stableJson({ output, completedRuns: records.length, allRowsRetained: summary.allRowsRetained })}`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
