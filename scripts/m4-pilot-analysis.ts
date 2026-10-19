import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'

export const M4_ARMS = [
  'coverage',
  'surge-cast',
  'infotaxis',
  'quad-active',
  'quad-zero-strength-sham',
] as const
export type M4Arm = typeof M4_ARMS[number]

export const M4_REFERENCES = [
  'coverage',
  'surge-cast',
  'infotaxis',
  'quad-zero-strength-sham',
] as const satisfies readonly M4Arm[]

export const M4_SCHEMA = 'm4-development-pilot-analysis-v2'
export const M4_SPEC_SCHEMA = 'phase2-m4-pilot-analysis-spec-v1'
export const M4_SPEC_SHA256 = '4938fea1e8bd83c49887652cacbfd34cf19bf55b0ff91dfd55907f9dfe3269a8'

const BOOTSTRAP_SEED = 1_295_278_156
const BOOTSTRAP_RESAMPLES = 10_000
const CHECKPOINT_SECONDS = 180
const TIMING_COLUMNS = new Set(['mean_compute_ms', 'p95_compute_ms'])

type RawRow = Record<string, string>
type AnalysisSpec = {
  schemaVersion: string
  inputs: {
    manifestFileSha256: string
    manifestSemanticSha256: string
    primaryRawResultsSha256: string
    reproductionRawResultsSha256: string
    scientificResultsSha256: string
    implementationSha256: string
    runtimeFingerprint: string
  }
  design: {
    partition: string
    targetStatus: string
    checkpointSeconds: number
    independentUnits: number
    rows: number
    armsPerUnit: number
    arms: string[]
  }
  primary: {
    candidate: string
    references: string[]
    bootstrapResamples: number
    bootstrapSeed: number
  }
  claimBoundary: string
}
type ArchiveMetadata = {
  complete?: boolean
  implementationSha256?: string
  manifestSha256?: string
  plannedCells?: number
  rawResultRows?: number
  rawResultsSha256?: string
  runtimeFingerprint?: string
  scientificResultsSha256?: string
}
type RunChecksums = {
  manifestSha256?: string
  rawResultsSha256?: string
  scientificResultsSha256?: string
  coreArtifactInventory?: Array<{ path: string; sha256: string; bytes: number }>
}
type ArchiveVerification = {
  archiveLabel: string
  inventoryEntries: number
  inventorySha256: string
  manifestFileSha256: string
  manifestSemanticSha256: string
  rawResultsSha256: string
  scientificResultsSha256: string
  implementationSha256: string
  runtimeFingerprint: string
  rawText: string
  header: string[]
  rows: RawRow[]
}

export type M4Unit = {
  pairingKey: string
  scenario: 'open' | 'obstructed'
  orientation: 'downwind' | 'crosswind-left' | 'upwind' | 'crosswind-right'
  replicate: number
  rows: ReadonlyMap<M4Arm, RawRow>
}
export type ProportionSummary = {
  numerator: number; denominator: number; estimate: number; low: number; high: number
}
export type ContinuousSummary = {
  n: number; mean: number; sd: number; median: number; q1: number; q3: number
  iqr: number; min: number; max: number
}
export type M4ArmSummary = {
  stratumType: 'overall' | 'scenario' | 'scenario-orientation'
  stratum: string
  scenario: string
  orientation: string
  arm: M4Arm
  units: number
  proximitySuccess: ProportionSummary
  correctDeclaration: ProportionSummary
  declarationCoverage: ProportionSummary
  falseDeclarationProbability: ProportionSummary
  declarationPrecision: ProportionSummary | null
  correctDeclarations: number
  wrongDeclarations: number
  abstentions: number
  deadlineNondeclarations: number
  normalizedError: ContinuousSummary
  pathNormalized: ContinuousSummary
  directDistancePathOverhead: ContinuousSummary
  plumeContactEpisodes: ContinuousSummary
  plumeTimeSeconds: ContinuousSummary
  reacquisitions: ContinuousSummary
  activeProbeCount: ContinuousSummary
  quadSniffCycles: ContinuousSummary
  activeSamplingSeconds: ContinuousSummary
  airPulseEnergy: ContinuousSummary
  quadSuctionEnergyProxy: ContinuousSummary
  meanPenalizedDecisionTimeSeconds: number
  meanCorrectDeclarationTimeSeconds: number | null
}
type PairedBinarySummary = {
  pairs: number; referenceRisk: number; candidateRisk: number; riskDifference: number
  referenceOnly: number; candidateOnly: number; both: number; neither: number
  mcnemarExactP: number
}
type BootstrapInterval = {
  estimate: number; low: number; high: number; pairs: number; resamples: number; seed: number
}
export type M4PrimaryComparison = {
  candidateArm: 'quad-active'
  referenceArm: typeof M4_REFERENCES[number]
  pairs: number
  correctDeclaration: PairedBinarySummary
  correctDeclarationRiskDifference95: BootstrapInterval
  holmAdjustedP: number
  proximitySuccess: PairedBinarySummary
  proximitySuccessRiskDifference95: BootstrapInterval
  normalizedErrorReferenceMean: number
  normalizedErrorCandidateMean: number
  normalizedErrorMeanDifference95: BootstrapInterval
  normalizedErrorMedianDifference: number
  penalizedDecisionTimeReferenceMeanSeconds: number
  penalizedDecisionTimeCandidateMeanSeconds: number
  penalizedDecisionTimeMeanDifference95: BootstrapInterval
}
export type M4Analysis = {
  schemaVersion: typeof M4_SCHEMA
  analysisSpec: { schemaVersion: typeof M4_SPEC_SCHEMA; sha256: string; bootstrapSeed: number; bootstrapResamples: number }
  input: {
    primaryArchive: Omit<ArchiveVerification, 'rawText' | 'header' | 'rows'>
    reproductionArchive: Omit<ArchiveVerification, 'rawText' | 'header' | 'rows'>
    timingColumnsExcludedFromScientificEquivalence: string[]
    scientificRowsIdentical: true
  }
  design: {
    storedRows: 80; independentPairedWorlds: 16; armsPerWorld: 5
    partition: 'development'; targetStatus: 'emitting'; checkpointSeconds: 180
    scenarioWorlds: { open: 8; obstructed: 8 }; worldsPerScenarioOrientation: 2
    primaryCandidate: 'quad-active'; primaryReferences: readonly typeof M4_REFERENCES[number][]
    primaryMultiplicityFamilySize: 4
  }
  qualityGates: Array<{ gate: string; status: 'pass'; detail: string }>
  armSummaries: M4ArmSummary[]
  primaryComparisons: M4PrimaryComparison[]
  pairedUnits: Array<{
    pairingKey: string; scenario: string; orientation: string; replicate: number
    arms: Array<{
      arm: M4Arm; terminalOutcome: string; correctDeclaration: boolean
      proximitySuccess: boolean; normalizedError: number; penalizedDecisionTimeSeconds: number
    }>
  }>
  claimBoundary: string
}

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T
const finite = (row: RawRow, field: string) => {
  const raw = row[field]
  if (raw === undefined || raw === '' || !Number.isFinite(Number(raw))) {
    throw new Error(`Non-finite or missing numeric value in ${field}`)
  }
  return Number(raw)
}
const nonNegativeInteger = (row: RawRow, field: string) => {
  const value = finite(row, field)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`)
  return value
}
const binary = (row: RawRow, field: string) => {
  const value = row[field]
  if (value !== '0' && value !== '1') throw new Error(`${field} must be 0 or 1`)
  return value === '1'
}
const csvEscape = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
const toCsv = (headers: readonly string[], rows: readonly Record<string, unknown>[]) =>
  `${headers.join(',')}\n${rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')).join('\n')}\n`

export const parseM4Csv = (text: string) => {
  const lines = text.trimEnd().split(/\r?\n/)
  const header = lines.shift()?.split(',') ?? []
  if (!header.length || new Set(header).size !== header.length) throw new Error('Raw CSV has an invalid or duplicate header')
  if (text.includes('"')) throw new Error('Frozen M3 scalar CSV unexpectedly contains quoted fields')
  const rows = lines.filter(Boolean).map((line, index): RawRow => {
    const values = line.split(',')
    if (values.length !== header.length) {
      throw new Error(`Raw CSV row ${index + 2} has ${values.length} fields; expected ${header.length}`)
    }
    return Object.fromEntries(header.map((name, column) => [name, values[column] ?? '']))
  })
  return { header, rows }
}

const REQUIRED_COLUMNS = [
  'manifest_sha256', 'partition', 'scenario_id', 'cell_id', 'orientation_bin', 'replicate',
  'method_arm', 'algorithm', 'scenario', 'target_status', 'seed', 'source_seed', 'controller_seed',
  'controller_observation_model_seed', 'controller_observation_model_version', 'source_x_normalized',
  'source_y_normalized', 'robot_start_x_normalized', 'robot_start_y_normalized',
  'robot_start_heading_deg', 'checkpoint_s', 'terminal_outcome', 'normalized_error',
  'proximity_success', 'path_normalized', 'direct_distance_path_overhead',
  'passive_contact_episodes', 'plume_time_s', 'reacquisitions', 'native_declaration',
  'declaration_time_s', 'false_declarations', 'native_abstention', 'abstention_time_s',
  'active_probe_count', 'quad_sniff_cycles', 'active_sampling_s', 'air_pulse_energy',
  'quad_suction_energy_proxy', 'domain_side_m', 'duration_s', 'physics_step_s',
  'effective_physics_step_s', 'physics_mode', 'grid_resolution', 'success_threshold_normalized',
] as const
const SHARED_WORLD_FIELDS = [
  'manifest_sha256', 'partition', 'scenario_id', 'orientation_bin', 'replicate', 'scenario',
  'target_status', 'seed', 'source_seed', 'controller_seed', 'controller_observation_model_seed',
  'controller_observation_model_version', 'source_x_normalized', 'source_y_normalized',
  'robot_start_x_normalized', 'robot_start_y_normalized', 'robot_start_heading_deg',
  'placement_overridden', 'obstacle_complexity_level', 'obstacle_count',
  'obstacle_occupied_fraction', 'obstacle_normalized_perimeter', 'obstacle_layout_hash',
  'obstacle_generator_version', 'terrain_slope_deg', 'terrain_grade_percent',
  'terrain_uphill_direction_deg', 'gas_buoyancy_class', 'terrain_gas_drift_scale',
  'terrain_model_version', 'checkpoint_s', 'domain_side_m', 'duration_s', 'fixed_dt_s',
  'physics_step_s', 'effective_physics_step_s', 'robot_speed_normalized_s', 'sensor_noise',
  'sensor_lag_s', 'sensor_threshold_scale', 'sensor_saturation', 'sensor_false_positive_rate',
  'sensor_false_negative_rate', 'quad_channel_noise_correlation', 'quad_channel_gain_mismatch',
  'quad_channel_crosstalk', 'quad_channel_lag_mismatch', 'wind_noise_rad',
  'active_sniff_enabled', 'active_sniff_reach_normalized', 'active_sniff_cycle_s',
  'physics_mode', 'grid_resolution', 'wind_direction_toward_deg', 'wind_speed_scale',
  'turbulence_scale', 'gust_fraction_of_mean', 'diffusivity_scale', 'source_emission_rate_scale',
  'effective_source_emission_rate_scale', 'success_threshold_normalized', 'simulator_version',
] as const
const EXPECTED_ORIENTATIONS = ['downwind', 'crosswind-left', 'upwind', 'crosswind-right'] as const

export const validateM4Rows = (rows: RawRow[], expectedManifestSha?: string): M4Unit[] => {
  if (rows.length !== 80) throw new Error(`M4 requires exactly 80 rows; received ${rows.length}`)
  for (const column of REQUIRED_COLUMNS) {
    if (!(column in rows[0]!)) throw new Error(`Raw CSV is missing required column: ${column}`)
  }
  const manifestDigests = new Set(rows.map((row) => row.manifest_sha256))
  if (manifestDigests.size !== 1 || manifestDigests.has('') || (expectedManifestSha && !manifestDigests.has(expectedManifestSha))) {
    throw new Error('Rows do not have exactly one expected manifest SHA-256')
  }
  const groups = new Map<string, RawRow[]>()
  for (const row of rows) {
    if (row.partition !== 'development') throw new Error(`M4 requires development partition; received ${row.partition}`)
    if (row.target_status !== 'emitting') throw new Error(`M4 requires emitting targets; received ${row.target_status}`)
    if (!M4_ARMS.includes(row.method_arm as M4Arm)) throw new Error(`Invalid M4 arm vocabulary: ${row.method_arm}`)
    const expectedAlgorithm = row.method_arm.startsWith('quad-') ? 'quad-sniff' : row.method_arm
    if (row.algorithm !== expectedAlgorithm) throw new Error(`Arm/algorithm mismatch for ${row.method_arm}: ${row.algorithm}`)
    if (finite(row, 'checkpoint_s') !== CHECKPOINT_SECONDS) throw new Error(`M4 requires final checkpoint 180 s; received ${row.checkpoint_s}`)
    if (row.physics_mode !== 'grid' || finite(row, 'grid_resolution') !== 96 || finite(row, 'physics_step_s') !== 0.0125 || finite(row, 'effective_physics_step_s') !== 0.0125) {
      throw new Error('M4 requires grid-96 with 0.0125 s requested/effective physics step')
    }
    if (finite(row, 'domain_side_m') !== 100 || finite(row, 'duration_s') !== 180 || finite(row, 'success_threshold_normalized') !== 0.01) {
      throw new Error('M4 requires the frozen 100 m, 180 s, 0.01-threshold design')
    }
    const outcome = row.terminal_outcome
    if (!['correct-declaration', 'wrong-declaration', 'missed-source-abstention', 'deadline-nondeclaration-present'].includes(outcome)) {
      throw new Error(`Invalid source-present terminal outcome: ${outcome}`)
    }
    const proximity = binary(row, 'proximity_success')
    const declared = binary(row, 'native_declaration')
    const abstained = binary(row, 'native_abstention')
    const error = finite(row, 'normalized_error')
    const falseDeclarations = nonNegativeInteger(row, 'false_declarations')
    if (error < 0) throw new Error('normalized_error must be non-negative')
    if (proximity !== (error <= 0.01)) throw new Error('proximity_success does not match the frozen 0.01 threshold')
    const hasDeclarationTime = row.declaration_time_s !== ''
    if (declared !== hasDeclarationTime) throw new Error('Declaration flag and declaration time are inconsistent')
    if (hasDeclarationTime) {
      const time = finite(row, 'declaration_time_s')
      if (time < 0 || time > 180) throw new Error('declaration_time_s is outside the mission budget')
    }
    if (declared !== ['correct-declaration', 'wrong-declaration'].includes(outcome)) {
      throw new Error('Declaration flag and terminal outcome are inconsistent')
    }
    if ((outcome === 'correct-declaration' && falseDeclarations !== 0) || (outcome === 'wrong-declaration' && falseDeclarations < 1) || (!declared && falseDeclarations !== 0)) {
      throw new Error('False-declaration count and terminal outcome are inconsistent')
    }
    const hasAbstentionTime = row.abstention_time_s !== ''
    if (abstained !== hasAbstentionTime || abstained !== (outcome === 'missed-source-abstention')) {
      throw new Error('Abstention flag/time and terminal outcome are inconsistent')
    }
    if (hasAbstentionTime) {
      const time = finite(row, 'abstention_time_s')
      if (time < 0 || time > 180) throw new Error('abstention_time_s is outside the mission budget')
    }
    for (const field of ['seed', 'source_seed', 'controller_seed', 'controller_observation_model_seed', 'replicate', 'passive_contact_episodes', 'reacquisitions', 'active_probe_count', 'quad_sniff_cycles']) {
      nonNegativeInteger(row, field)
    }
    for (const field of ['path_normalized', 'direct_distance_path_overhead', 'plume_time_s', 'active_sampling_s', 'air_pulse_energy', 'quad_suction_energy_proxy']) {
      if (finite(row, field) < 0) throw new Error(`${field} must be non-negative`)
    }
    const group = groups.get(row.scenario_id) ?? []
    group.push(row)
    groups.set(row.scenario_id, group)
  }
  if (groups.size !== 16) throw new Error(`M4 requires exactly 16 paired worlds; received ${groups.size}`)
  const units: M4Unit[] = []
  for (const [pairingKey, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length !== 5) throw new Error(`Incomplete pairing for ${pairingKey}: expected 5 rows, received ${group.length}`)
    const armRows = new Map<M4Arm, RawRow>()
    for (const row of group) {
      const arm = row.method_arm as M4Arm
      if (armRows.has(arm)) throw new Error(`Duplicate arm ${arm} in ${pairingKey}`)
      armRows.set(arm, row)
    }
    for (const arm of M4_ARMS) if (!armRows.has(arm)) throw new Error(`Incomplete arm set for ${pairingKey}: missing ${arm}`)
    for (const field of SHARED_WORLD_FIELDS) {
      if (new Set(group.map((row) => row[field] ?? '')).size !== 1) {
        throw new Error(`Mixed world/configuration field in ${pairingKey}: ${field}`)
      }
    }
    const first = group[0]!
    const scenario = first.scenario
    const orientation = first.orientation_bin
    const replicate = nonNegativeInteger(first, 'replicate')
    if (scenario !== 'open' && scenario !== 'obstructed') throw new Error(`Unexpected scenario: ${scenario}`)
    if (!EXPECTED_ORIENTATIONS.includes(orientation as typeof EXPECTED_ORIENTATIONS[number])) throw new Error(`Unexpected orientation: ${orientation}`)
    if (replicate !== 0 && replicate !== 1) throw new Error(`Unexpected replicate: ${replicate}`)
    if (pairingKey !== `${scenario}-${orientation}-${replicate}`) throw new Error(`scenario_id does not match frozen pairing identity: ${pairingKey}`)
    for (const row of group) {
      if (row.cell_id !== `${row.method_arm}-${pairingKey}`) throw new Error(`cell_id does not match arm/pairing identity: ${row.cell_id}`)
    }
    units.push({ pairingKey, scenario, orientation: orientation as M4Unit['orientation'], replicate, rows: armRows })
  }
  for (const scenario of ['open', 'obstructed'] as const) {
    const scenarioUnits = units.filter((unit) => unit.scenario === scenario)
    if (scenarioUnits.length !== 8) throw new Error(`${scenario} must contain exactly 8 paired worlds`)
    for (const orientation of EXPECTED_ORIENTATIONS) {
      const cell = scenarioUnits.filter((unit) => unit.orientation === orientation)
      if (cell.length !== 2 || new Set(cell.map((unit) => unit.replicate)).size !== 2) {
        throw new Error(`${scenario}/${orientation} must contain replicates 0 and 1`)
      }
    }
  }
  return units
}

const quantile = (values: readonly number[], probability: number) => {
  if (!values.length) throw new RangeError('Quantile requires at least one value')
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * probability
  const low = Math.floor(position)
  const high = Math.ceil(position)
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low)
}
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
const continuousSummary = (values: readonly number[]): ContinuousSummary => {
  if (!values.length || values.some((value) => !Number.isFinite(value))) throw new RangeError('Continuous summary requires finite values')
  const average = mean(values)
  const q1 = quantile(values, 0.25)
  const q3 = quantile(values, 0.75)
  return {
    n: values.length,
    mean: average,
    sd: values.length > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)) : 0,
    median: quantile(values, 0.5), q1, q3, iqr: q3 - q1,
    min: Math.min(...values), max: Math.max(...values),
  }
}
const inverseNormal = (p: number) => {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924]
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857]
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878]
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742]
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]!*q+c[1]!)*q+c[2]!)*q+c[3]!)*q+c[4]!)*q+c[5]!) / ((((d[0]!*q+d[1]!)*q+d[2]!)*q+d[3]!)*q+1) }
  if (p > 0.97575) { const q = Math.sqrt(-2 * Math.log(1-p)); return -(((((c[0]!*q+c[1]!)*q+c[2]!)*q+c[3]!)*q+c[4]!)*q+c[5]!) / ((((d[0]!*q+d[1]!)*q+d[2]!)*q+d[3]!)*q+1) }
  const q = p - 0.5; const r = q*q
  return (((((a[0]!*r+a[1]!)*r+a[2]!)*r+a[3]!)*r+a[4]!)*r+a[5]!)*q / (((((b[0]!*r+b[1]!)*r+b[2]!)*r+b[3]!)*r+b[4]!)*r+1)
}
const wilsonInterval = (successes: number, trials: number): ProportionSummary => {
  const z = inverseNormal(0.975); const z2 = z*z; const estimate = successes/trials
  const center = (estimate + z2/(2*trials))/(1+z2/trials)
  const half = z*Math.sqrt((estimate*(1-estimate)+z2/(4*trials))/trials)/(1+z2/trials)
  return { numerator: successes, denominator: trials, estimate, low: Math.max(0,center-half), high: Math.min(1,center+half) }
}
const exactMcNemarP = (referenceOnly: number, candidateOnly: number) => {
  const discordant = referenceOnly + candidateOnly
  if (!discordant) return 1
  const tail = Math.min(referenceOnly, candidateOnly)
  let probability = 0.5 ** discordant; let lower = probability
  for (let i=0;i<tail;i+=1) { probability *= (discordant-i)/(i+1); lower += probability }
  return Math.min(1, 2*lower)
}
const pairedBinary = (reference: readonly boolean[], candidate: readonly boolean[]): PairedBinarySummary => {
  let referenceOnly=0, candidateOnly=0, both=0, neither=0
  for (let i=0;i<reference.length;i+=1) {
    if (reference[i] && candidate[i]) both += 1
    else if (reference[i]) referenceOnly += 1
    else if (candidate[i]) candidateOnly += 1
    else neither += 1
  }
  return { pairs: reference.length, referenceRisk:(both+referenceOnly)/reference.length, candidateRisk:(both+candidateOnly)/reference.length, riskDifference:(candidateOnly-referenceOnly)/reference.length, referenceOnly, candidateOnly, both, neither, mcnemarExactP:exactMcNemarP(referenceOnly,candidateOnly) }
}
const makeBootstrapIndices = (pairs: number) => {
  let state = BOOTSTRAP_SEED >>> 0
  return Array.from({length:BOOTSTRAP_RESAMPLES}, () => Array.from({length:pairs}, () => {
    state=(Math.imul(state,1_664_525)+1_013_904_223)>>>0
    // Use the full 32-bit state. Taking `state % 16` would cycle through every
    // index exactly once per resample for this LCG and falsely collapse CIs.
    return Math.floor((state / 0x1_0000_0000) * pairs)
  }))
}
const bootstrapPairedMeanDifference = (reference: readonly number[], candidate: readonly number[], indices: readonly (readonly number[])[]): BootstrapInterval => {
  const differences = reference.map((value,index)=>candidate[index]!-value)
  const estimates = indices.map((sample)=>mean(sample.map((index)=>differences[index]!)))
  return { estimate:mean(differences), low:quantile(estimates,0.025), high:quantile(estimates,0.975), pairs:differences.length, resamples:indices.length, seed:BOOTSTRAP_SEED }
}
const holmAdjust = (pValues: readonly number[]) => {
  const ranked=pValues.map((p,index)=>({p,index})).sort((a,b)=>a.p-b.p); const adjusted=Array<number>(pValues.length).fill(1); let previous=0
  ranked.forEach(({p,index},rank)=>{ previous=Math.max(previous,Math.min(1,p*(ranked.length-rank))); adjusted[index]=previous })
  return adjusted
}
const correctDeclaration = (row: RawRow) => row.terminal_outcome === 'correct-declaration'
const penalizedDecisionTime = (row: RawRow) => correctDeclaration(row) ? finite(row,'declaration_time_s') : 180
const summarizeArm = (units: readonly M4Unit[], arm: M4Arm, stratumType: M4ArmSummary['stratumType'], stratum:string, scenario:string, orientation:string): M4ArmSummary => {
  const rows=units.map((unit)=>unit.rows.get(arm)!); const correct=rows.filter(correctDeclaration).length
  const wrong=rows.filter((row)=>row.terminal_outcome==='wrong-declaration').length
  const abstentions=rows.filter((row)=>row.terminal_outcome==='missed-source-abstention').length
  const deadline=rows.filter((row)=>row.terminal_outcome==='deadline-nondeclaration-present').length
  const declarations=correct+wrong; const proximity=rows.filter((row)=>binary(row,'proximity_success')).length
  const values=(field:string)=>rows.map((row)=>finite(row,field))
  return { stratumType,stratum,scenario,orientation,arm,units:rows.length, proximitySuccess:wilsonInterval(proximity,rows.length), correctDeclaration:wilsonInterval(correct,rows.length), declarationCoverage:wilsonInterval(declarations,rows.length), falseDeclarationProbability:wilsonInterval(wrong,rows.length), declarationPrecision:declarations?wilsonInterval(correct,declarations):null, correctDeclarations:correct, wrongDeclarations:wrong, abstentions, deadlineNondeclarations:deadline, normalizedError:continuousSummary(values('normalized_error')), pathNormalized:continuousSummary(values('path_normalized')), directDistancePathOverhead:continuousSummary(values('direct_distance_path_overhead')), plumeContactEpisodes:continuousSummary(values('passive_contact_episodes')), plumeTimeSeconds:continuousSummary(values('plume_time_s')), reacquisitions:continuousSummary(values('reacquisitions')), activeProbeCount:continuousSummary(values('active_probe_count')), quadSniffCycles:continuousSummary(values('quad_sniff_cycles')), activeSamplingSeconds:continuousSummary(values('active_sampling_s')), airPulseEnergy:continuousSummary(values('air_pulse_energy')), quadSuctionEnergyProxy:continuousSummary(values('quad_suction_energy_proxy')), meanPenalizedDecisionTimeSeconds:mean(rows.map(penalizedDecisionTime)), meanCorrectDeclarationTimeSeconds:correct?mean(rows.filter(correctDeclaration).map((row)=>finite(row,'declaration_time_s'))):null }
}
const buildArmSummaries = (units: readonly M4Unit[]) => {
  const summaries:M4ArmSummary[]=[]
  for (const arm of M4_ARMS) summaries.push(summarizeArm(units,arm,'overall','all','all','all'))
  for (const scenario of ['open','obstructed'] as const) {
    const scenarioUnits=units.filter((unit)=>unit.scenario===scenario)
    for (const arm of M4_ARMS) summaries.push(summarizeArm(scenarioUnits,arm,'scenario',scenario,scenario,'all'))
    for (const orientation of EXPECTED_ORIENTATIONS) {
      const cell=scenarioUnits.filter((unit)=>unit.orientation===orientation)
      for (const arm of M4_ARMS) summaries.push(summarizeArm(cell,arm,'scenario-orientation',`${scenario}|${orientation}`,scenario,orientation))
    }
  }
  return summaries
}
const buildPrimaryComparisons = (units: readonly M4Unit[]): M4PrimaryComparison[] => {
  const indices=makeBootstrapIndices(units.length)
  const raw=M4_REFERENCES.map((referenceArm):Omit<M4PrimaryComparison,'holmAdjustedP'>=>{
    const referenceRows=units.map((unit)=>unit.rows.get(referenceArm)!); const candidateRows=units.map((unit)=>unit.rows.get('quad-active')!)
    const refCorrect=referenceRows.map(correctDeclaration); const candCorrect=candidateRows.map(correctDeclaration)
    const refProximity=referenceRows.map((row)=>binary(row,'proximity_success')); const candProximity=candidateRows.map((row)=>binary(row,'proximity_success'))
    const refError=referenceRows.map((row)=>finite(row,'normalized_error')); const candError=candidateRows.map((row)=>finite(row,'normalized_error'))
    const errorDiff=refError.map((value,index)=>candError[index]!-value)
    const refTime=referenceRows.map(penalizedDecisionTime); const candTime=candidateRows.map(penalizedDecisionTime)
    return { candidateArm:'quad-active', referenceArm, pairs:units.length, correctDeclaration:pairedBinary(refCorrect,candCorrect), correctDeclarationRiskDifference95:bootstrapPairedMeanDifference(refCorrect.map(Number),candCorrect.map(Number),indices), proximitySuccess:pairedBinary(refProximity,candProximity), proximitySuccessRiskDifference95:bootstrapPairedMeanDifference(refProximity.map(Number),candProximity.map(Number),indices), normalizedErrorReferenceMean:mean(refError), normalizedErrorCandidateMean:mean(candError), normalizedErrorMeanDifference95:bootstrapPairedMeanDifference(refError,candError,indices), normalizedErrorMedianDifference:quantile(errorDiff,0.5), penalizedDecisionTimeReferenceMeanSeconds:mean(refTime), penalizedDecisionTimeCandidateMeanSeconds:mean(candTime), penalizedDecisionTimeMeanDifference95:bootstrapPairedMeanDifference(refTime,candTime,indices) }
  })
  const adjusted=holmAdjust(raw.map((comparison)=>comparison.correctDeclaration.mcnemarExactP))
  return raw.map((comparison,index)=>({...comparison,holmAdjustedP:adjusted[index]!}))
}

const sanitizeArchiveEntry = (archive:string, entry:string) => {
  if (isAbsolute(entry)) throw new Error(`Absolute path in archive inventory: ${entry}`)
  const target=resolve(archive,entry)
  if (target!==archive && !target.startsWith(`${archive}/`)) throw new Error(`Archive inventory path escapes root: ${entry}`)
  return target
}
export const verifyM4ArchiveChecksums = async (archiveDirectory:string) => {
  const archive=resolve(archiveDirectory); const sums=await readFile(join(archive,'SHA256SUMS'),'utf8')
  const entries=sums.trim().split(/\r?\n/).filter(Boolean).map((line)=>{ const match=line.match(/^([a-f0-9]{64})\s+\*?(?:\.\/)?(.+)$/); if(!match) throw new Error(`Invalid SHA256SUMS line: ${line}`); return {digest:match[1]!,path:match[2]!} })
  if (!entries.length || entries.some((entry)=>entry.path==='SHA256SUMS') || new Set(entries.map((entry)=>entry.path)).size!==entries.length) throw new Error('SHA256SUMS has an invalid inventory')
  for (const entry of entries) if (sha256(await readFile(sanitizeArchiveEntry(archive,entry.path)))!==entry.digest) throw new Error(`Archive checksum mismatch: ${entry.path}`)
  return {entries:entries.length,sha256:sha256(sums)}
}
const verifyArchive = async (archiveDirectory:string, archiveLabel:'primary'|'reproduction', spec:AnalysisSpec):Promise<ArchiveVerification> => {
  const archive=resolve(archiveDirectory); const inventory=await verifyM4ArchiveChecksums(archive); const run=join(archive,'run')
  const manifestBytes=await readFile(join(run,'manifest.json')); const rawText=await readFile(join(run,'raw-results.csv'),'utf8')
  const rawResultsSha256=sha256(rawText); const manifestFileSha256=sha256(manifestBytes)
  const manifest=JSON.parse(manifestBytes.toString('utf8')) as {schemaVersion?:string;manifestSha256?:string;partition?:string;design?:{finalCheckpointSeconds?:number;pairedLayouts?:boolean;sourcePresentOnly?:boolean};arms?:Array<{id?:string}>;cells?:unknown[]}
  const metadata=await readJson<ArchiveMetadata>(join(run,'metadata.json')); const checksums=await readJson<RunChecksums>(join(run,'checksums.json'))
  const implementation=await readJson<{implementationSha256?:string}>(join(run,'implementation.json')); const runtime=await readJson<{runtimeFingerprint?:string}>(join(run,'runtime.json'))
  const parsed=parseM4Csv(rawText); const expectedRaw=archiveLabel==='primary'?spec.inputs.primaryRawResultsSha256:spec.inputs.reproductionRawResultsSha256
  if (manifestFileSha256!==spec.inputs.manifestFileSha256) throw new Error(`${archiveLabel} manifest file digest does not match the frozen contract`)
  if (rawResultsSha256!==expectedRaw) throw new Error(`${archiveLabel} raw-results digest does not match the frozen contract`)
  if (manifest.schemaVersion!=='phase2-development-pilot-manifest-v4' || manifest.partition!=='development' || manifest.design?.finalCheckpointSeconds!==180 || manifest.design?.pairedLayouts!==true || manifest.design?.sourcePresentOnly!==true || manifest.cells?.length!==80 || JSON.stringify(manifest.arms?.map((arm)=>arm.id))!==JSON.stringify(M4_ARMS)) throw new Error(`${archiveLabel} manifest structure does not match the frozen design`)
  if (manifest.manifestSha256!==spec.inputs.manifestSemanticSha256) throw new Error(`${archiveLabel} manifest semantic digest mismatch`)
  if (metadata.complete!==true || metadata.plannedCells!==80 || metadata.rawResultRows!==80 || metadata.manifestSha256!==spec.inputs.manifestSemanticSha256 || metadata.rawResultsSha256!==expectedRaw || metadata.scientificResultsSha256!==spec.inputs.scientificResultsSha256 || metadata.implementationSha256!==spec.inputs.implementationSha256 || metadata.runtimeFingerprint!==spec.inputs.runtimeFingerprint) throw new Error(`${archiveLabel} metadata does not match the frozen provenance contract`)
  if (checksums.manifestSha256!==spec.inputs.manifestSemanticSha256 || checksums.rawResultsSha256!==expectedRaw || checksums.scientificResultsSha256!==spec.inputs.scientificResultsSha256 || !checksums.coreArtifactInventory?.some((entry)=>entry.path==='raw-results.csv'&&entry.sha256===expectedRaw)) throw new Error(`${archiveLabel} run checksums do not bind the frozen inputs`)
  if (implementation.implementationSha256!==spec.inputs.implementationSha256 || runtime.runtimeFingerprint!==spec.inputs.runtimeFingerprint) throw new Error(`${archiveLabel} implementation/runtime fingerprints do not match`)
  validateM4Rows(parsed.rows,spec.inputs.manifestSemanticSha256)
  return { archiveLabel:basename(archive), inventoryEntries:inventory.entries, inventorySha256:inventory.sha256, manifestFileSha256, manifestSemanticSha256:manifest.manifestSha256, rawResultsSha256, scientificResultsSha256:metadata.scientificResultsSha256, implementationSha256:metadata.implementationSha256, runtimeFingerprint:metadata.runtimeFingerprint, rawText, header:parsed.header, rows:parsed.rows }
}
const verifyScientificRepeat = (primary:ArchiveVerification,reproduction:ArchiveVerification) => {
  if (JSON.stringify(primary.header)!==JSON.stringify(reproduction.header) || primary.rows.length!==reproduction.rows.length) throw new Error('Primary and reproduction CSV structures differ')
  for (let rowIndex=0;rowIndex<primary.rows.length;rowIndex+=1) for (const column of primary.header) {
    if (!TIMING_COLUMNS.has(column) && primary.rows[rowIndex]![column]!==reproduction.rows[rowIndex]![column]) throw new Error(`Scientific repeat mismatch at row ${rowIndex+2}, column ${column}`)
  }
}
const publicArchive=(archive:ArchiveVerification):Omit<ArchiveVerification,'rawText'|'header'|'rows'>=>({ archiveLabel:archive.archiveLabel,inventoryEntries:archive.inventoryEntries,inventorySha256:archive.inventorySha256,manifestFileSha256:archive.manifestFileSha256,manifestSemanticSha256:archive.manifestSemanticSha256,rawResultsSha256:archive.rawResultsSha256,scientificResultsSha256:archive.scientificResultsSha256,implementationSha256:archive.implementationSha256,runtimeFingerprint:archive.runtimeFingerprint })

export const analyzeM4Rows = (rows:RawRow[], provenance?:{primary:ArchiveVerification;reproduction:ArchiveVerification}, claimBoundary='Descriptive development-only pilot evidence; no powered, confirmatory, superiority, physical-validation, methane-specific, buried-source, landfill, urban, or field-performance claim.'):M4Analysis => {
  const units=validateM4Rows(rows,provenance?.primary.manifestSemanticSha256); const placeholder={archiveLabel:'unit-test',inventoryEntries:0,inventorySha256:'',manifestFileSha256:'',manifestSemanticSha256:rows[0]!.manifest_sha256,rawResultsSha256:'',scientificResultsSha256:'',implementationSha256:'',runtimeFingerprint:''}
  return { schemaVersion:M4_SCHEMA, analysisSpec:{schemaVersion:M4_SPEC_SCHEMA,sha256:M4_SPEC_SHA256,bootstrapSeed:BOOTSTRAP_SEED,bootstrapResamples:BOOTSTRAP_RESAMPLES}, input:{primaryArchive:provenance?publicArchive(provenance.primary):placeholder,reproductionArchive:provenance?publicArchive(provenance.reproduction):placeholder,timingColumnsExcludedFromScientificEquivalence:[...TIMING_COLUMNS].sort(),scientificRowsIdentical:true}, design:{storedRows:80,independentPairedWorlds:16,armsPerWorld:5,partition:'development',targetStatus:'emitting',checkpointSeconds:180,scenarioWorlds:{open:8,obstructed:8},worldsPerScenarioOrientation:2,primaryCandidate:'quad-active',primaryReferences:M4_REFERENCES,primaryMultiplicityFamilySize:4}, qualityGates:[{gate:'archive-inventories',status:'pass',detail:'Both SHA256SUMS inventories verified.'},{gate:'frozen-provenance',status:'pass',detail:'Manifest, raw, scientific, implementation, and runtime digests match the frozen contract.'},{gate:'scientific-repeat',status:'pass',detail:'All non-timing CSV fields are byte-identical across the fresh repeat.'},{gate:'paired-design',status:'pass',detail:'80 rows form 16 complete five-arm paired worlds with the frozen 2 x 4 x 2 layout.'},{gate:'row-semantics',status:'pass',detail:'Outcome flags, thresholds, checkpoints, physics, identity, and numeric fields are consistent.'}], armSummaries:buildArmSummaries(units), primaryComparisons:buildPrimaryComparisons(units), pairedUnits:units.map((unit)=>({pairingKey:unit.pairingKey,scenario:unit.scenario,orientation:unit.orientation,replicate:unit.replicate,arms:M4_ARMS.map((arm)=>{const row=unit.rows.get(arm)!;return {arm,terminalOutcome:row.terminal_outcome,correctDeclaration:correctDeclaration(row),proximitySuccess:binary(row,'proximity_success'),normalizedError:finite(row,'normalized_error'),penalizedDecisionTimeSeconds:penalizedDecisionTime(row)}})})), claimBoundary }
}

const armSummaryRows=(summaries:readonly M4ArmSummary[])=>summaries.map((s)=>({stratum_type:s.stratumType,stratum:s.stratum,scenario:s.scenario,orientation:s.orientation,arm:s.arm,paired_worlds:s.units,proximity_successes:s.proximitySuccess.numerator,proximity_rate:s.proximitySuccess.estimate,proximity_wilson_low:s.proximitySuccess.low,proximity_wilson_high:s.proximitySuccess.high,correct_declarations:s.correctDeclarations,correct_declaration_rate:s.correctDeclaration.estimate,correct_declaration_wilson_low:s.correctDeclaration.low,correct_declaration_wilson_high:s.correctDeclaration.high,wrong_declarations:s.wrongDeclarations,abstentions:s.abstentions,deadline_nondeclarations:s.deadlineNondeclarations,declaration_coverage:s.declarationCoverage.estimate,false_declaration_probability:s.falseDeclarationProbability.estimate,declaration_precision:s.declarationPrecision?.estimate??null,normalized_error_mean:s.normalizedError.mean,normalized_error_sd:s.normalizedError.sd,normalized_error_median:s.normalizedError.median,normalized_error_q1:s.normalizedError.q1,normalized_error_q3:s.normalizedError.q3,normalized_error_min:s.normalizedError.min,normalized_error_max:s.normalizedError.max,path_normalized_mean:s.pathNormalized.mean,path_overhead_mean:s.directDistancePathOverhead.mean,contact_episodes_median:s.plumeContactEpisodes.median,plume_time_s_median:s.plumeTimeSeconds.median,reacquisitions_median:s.reacquisitions.median,active_probe_count_median:s.activeProbeCount.median,quad_sniff_cycles_median:s.quadSniffCycles.median,active_sampling_s_mean:s.activeSamplingSeconds.mean,air_pulse_energy_mean:s.airPulseEnergy.mean,quad_suction_energy_proxy_mean:s.quadSuctionEnergyProxy.mean,mean_penalized_decision_time_s:s.meanPenalizedDecisionTimeSeconds,mean_correct_declaration_time_s:s.meanCorrectDeclarationTimeSeconds}))
const ARM_HEADERS=['stratum_type','stratum','scenario','orientation','arm','paired_worlds','proximity_successes','proximity_rate','proximity_wilson_low','proximity_wilson_high','correct_declarations','correct_declaration_rate','correct_declaration_wilson_low','correct_declaration_wilson_high','wrong_declarations','abstentions','deadline_nondeclarations','declaration_coverage','false_declaration_probability','declaration_precision','normalized_error_mean','normalized_error_sd','normalized_error_median','normalized_error_q1','normalized_error_q3','normalized_error_min','normalized_error_max','path_normalized_mean','path_overhead_mean','contact_episodes_median','plume_time_s_median','reacquisitions_median','active_probe_count_median','quad_sniff_cycles_median','active_sampling_s_mean','air_pulse_energy_mean','quad_suction_energy_proxy_mean','mean_penalized_decision_time_s','mean_correct_declaration_time_s'] as const
const primaryRows=(analysis:M4Analysis)=>analysis.primaryComparisons.map((c)=>({candidate_arm:c.candidateArm,reference_arm:c.referenceArm,paired_worlds:c.pairs,candidate_correct_risk:c.correctDeclaration.candidateRisk,reference_correct_risk:c.correctDeclaration.referenceRisk,correct_risk_difference:c.correctDeclaration.riskDifference,correct_risk_difference_low:c.correctDeclarationRiskDifference95.low,correct_risk_difference_high:c.correctDeclarationRiskDifference95.high,reference_only:c.correctDeclaration.referenceOnly,candidate_only:c.correctDeclaration.candidateOnly,both:c.correctDeclaration.both,neither:c.correctDeclaration.neither,mcnemar_exact_p:c.correctDeclaration.mcnemarExactP,holm_adjusted_p:c.holmAdjustedP,candidate_proximity_risk:c.proximitySuccess.candidateRisk,reference_proximity_risk:c.proximitySuccess.referenceRisk,proximity_risk_difference:c.proximitySuccess.riskDifference,proximity_risk_difference_low:c.proximitySuccessRiskDifference95.low,proximity_risk_difference_high:c.proximitySuccessRiskDifference95.high,candidate_error_mean:c.normalizedErrorCandidateMean,reference_error_mean:c.normalizedErrorReferenceMean,error_mean_difference:c.normalizedErrorMeanDifference95.estimate,error_mean_difference_low:c.normalizedErrorMeanDifference95.low,error_mean_difference_high:c.normalizedErrorMeanDifference95.high,error_median_paired_difference:c.normalizedErrorMedianDifference,candidate_penalized_time_mean_s:c.penalizedDecisionTimeCandidateMeanSeconds,reference_penalized_time_mean_s:c.penalizedDecisionTimeReferenceMeanSeconds,penalized_time_mean_difference_s:c.penalizedDecisionTimeMeanDifference95.estimate,penalized_time_difference_low_s:c.penalizedDecisionTimeMeanDifference95.low,penalized_time_difference_high_s:c.penalizedDecisionTimeMeanDifference95.high,bootstrap_resamples:c.correctDeclarationRiskDifference95.resamples,bootstrap_seed:c.correctDeclarationRiskDifference95.seed}))
const PRIMARY_HEADERS=['candidate_arm','reference_arm','paired_worlds','candidate_correct_risk','reference_correct_risk','correct_risk_difference','correct_risk_difference_low','correct_risk_difference_high','reference_only','candidate_only','both','neither','mcnemar_exact_p','holm_adjusted_p','candidate_proximity_risk','reference_proximity_risk','proximity_risk_difference','proximity_risk_difference_low','proximity_risk_difference_high','candidate_error_mean','reference_error_mean','error_mean_difference','error_mean_difference_low','error_mean_difference_high','error_median_paired_difference','candidate_penalized_time_mean_s','reference_penalized_time_mean_s','penalized_time_mean_difference_s','penalized_time_difference_low_s','penalized_time_difference_high_s','bootstrap_resamples','bootstrap_seed'] as const
const pairedRows=(analysis:M4Analysis)=>analysis.pairedUnits.flatMap((unit)=>unit.arms.map((arm)=>({pairing_key:unit.pairingKey,scenario:unit.scenario,orientation:unit.orientation,replicate:unit.replicate,arm:arm.arm,terminal_outcome:arm.terminalOutcome,correct_declaration:Number(arm.correctDeclaration),proximity_success:Number(arm.proximitySuccess),normalized_error:arm.normalizedError,penalized_decision_time_s:arm.penalizedDecisionTimeSeconds})))
const PAIRED_HEADERS=['pairing_key','scenario','orientation','replicate','arm','terminal_outcome','correct_declaration','proximity_success','normalized_error','penalized_decision_time_s'] as const

export const analysisToMarkdown=(analysis:M4Analysis)=>{const overall=analysis.armSummaries.filter((s)=>s.stratumType==='overall');return `# M4 Phase 2 development-pilot analysis

## Design and provenance

- Stored rows: ${analysis.design.storedRows}
- Independent paired worlds: ${analysis.design.independentPairedWorlds}
- Arms per world: ${analysis.design.armsPerWorld}
- Partition/checkpoint: ${analysis.design.partition}, ${analysis.design.checkpointSeconds} s
- Primary scientific SHA-256: \`${analysis.input.primaryArchive.scientificResultsSha256}\`
- Fresh-repeat scientific SHA-256: \`${analysis.input.reproductionArchive.scientificResultsSha256}\`
- Scientific equivalence: exact for every CSV field except the two declared host-timing columns

## Overall descriptive outcomes

| Arm | Paired worlds | Proximity success | Correct declaration | Wrong | Abstention | Deadline | Mean normalized error | Mean penalized decision time (s) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${overall.map((s)=>`| ${s.arm} | ${s.units} | ${s.proximitySuccess.numerator}/${s.units} (${(100*s.proximitySuccess.estimate).toFixed(1)}%) | ${s.correctDeclarations}/${s.units} (${(100*s.correctDeclaration.estimate).toFixed(1)}%) | ${s.wrongDeclarations} | ${s.abstentions} | ${s.deadlineNondeclarations} | ${s.normalizedError.mean.toFixed(5)} | ${s.meanPenalizedDecisionTimeSeconds.toFixed(2)} |`).join('\n')}

## Frozen primary family: Quad Active minus reference

| Reference | Pairs | Correct risk difference (95% paired bootstrap) | Discordant: reference / candidate | Exact McNemar p | Holm p |
|---|---:|---:|---:|---:|---:|
${analysis.primaryComparisons.map((c)=>`| ${c.referenceArm} | ${c.pairs} | ${c.correctDeclaration.riskDifference.toFixed(3)} [${c.correctDeclarationRiskDifference95.low.toFixed(3)}, ${c.correctDeclarationRiskDifference95.high.toFixed(3)}] | ${c.correctDeclaration.referenceOnly} / ${c.correctDeclaration.candidateOnly} | ${c.correctDeclaration.mcnemarExactP.toFixed(4)} | ${c.holmAdjustedP.toFixed(4)} |`).join('\n')}

The four tests above form one global Holm family. With only 16 paired worlds and sparse discordance, the p-values and intervals are diagnostics, not confirmatory evidence. Scenario-orientation cells contain only two paired worlds.

Quad Active produced proximity successes without a correct terminal declaration, so its declaration policy must be repaired or recalibrated before a larger campaign. A zero-discordance result is uninformative and is not evidence of equivalence.

**Claim boundary.** ${analysis.claimBoundary}
`}
const writeOutputs=async(outputDirectory:string,analysis:M4Analysis)=>{await mkdir(outputDirectory,{recursive:true});const overall=analysis.armSummaries.filter((s)=>s.stratumType==='overall');const strata=analysis.armSummaries.filter((s)=>s.stratumType!=='overall');const files=new Map<string,string>([['analysis.json',`${JSON.stringify(analysis,null,2)}\n`],['arm-summaries.csv',toCsv(ARM_HEADERS,armSummaryRows(overall))],['primary-comparisons.csv',toCsv(PRIMARY_HEADERS,primaryRows(analysis))],['stratum-summaries.csv',toCsv(ARM_HEADERS,armSummaryRows(strata))],['paired-units.csv',toCsv(PAIRED_HEADERS,pairedRows(analysis))],['report.md',analysisToMarkdown(analysis)]]);for(const[name,content]of files)await writeFile(join(outputDirectory,name),content);const sums=[...files].sort(([a],[b])=>a.localeCompare(b)).map(([name,content])=>`${sha256(content)}  ./${name}`).join('\n');await writeFile(join(outputDirectory,'SHA256SUMS'),`${sums}\n`)}

export async function runM4PilotAnalysis(primaryArchiveDirectory:string,reproductionArchiveDirectory:string,outputDirectory:string,specPath=join(resolve('.'),'research/protocols/m4_phase2_pilot_analysis_spec.json')) {
  const specBytes=await readFile(specPath); if(sha256(specBytes)!==M4_SPEC_SHA256) throw new Error('Frozen M4 analysis specification digest mismatch')
  const spec=JSON.parse(specBytes.toString('utf8')) as AnalysisSpec
  if(spec.schemaVersion!==M4_SPEC_SCHEMA||spec.design.rows!==80||spec.design.independentUnits!==16||spec.design.armsPerUnit!==5||spec.design.partition!=='development'||spec.design.targetStatus!=='emitting'||spec.design.checkpointSeconds!==180||JSON.stringify(spec.design.arms)!==JSON.stringify(M4_ARMS)||spec.primary.candidate!=='quad-active'||JSON.stringify(spec.primary.references)!==JSON.stringify(M4_REFERENCES)||spec.primary.bootstrapResamples!==BOOTSTRAP_RESAMPLES||spec.primary.bootstrapSeed!==BOOTSTRAP_SEED) throw new Error('Frozen M4 analysis specification structure mismatch')
  const primary=await verifyArchive(primaryArchiveDirectory,'primary',spec); const reproduction=await verifyArchive(reproductionArchiveDirectory,'reproduction',spec); verifyScientificRepeat(primary,reproduction)
  const analysis=analyzeM4Rows(primary.rows,{primary,reproduction},spec.claimBoundary); await writeOutputs(outputDirectory,analysis); return analysis
}
const cli=async()=>{const args=process.argv.slice(2);const value=(flag:string)=>{const index=args.indexOf(flag);return index>=0?args[index+1]:undefined};const primary=value('--primary-archive');const reproduction=value('--reproduction-archive');const output=value('--output');const spec=value('--spec');if(!primary||!reproduction||!output)throw new Error('Usage: m4-pilot-analysis --primary-archive DIR --reproduction-archive DIR --output DIR [--spec FILE]');await runM4PilotAnalysis(primary,reproduction,output,spec)}
if (process.argv.includes('--primary-archive')) await cli()
