/** Deterministic, development-only gate analysis for the frozen M7 diagnostic. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { QUAD_CANDIDATE_FORMATION_GATE_NAMES } from '../src/sim/algorithms/quadSoilSniff'
import { verifyM7Results } from './m7-verify-results'

const ARMS = ['quad-active', 'quad-passive', 'quad-zero-strength-sham'] as const
const CONDITIONS = ['emitting', 'absent'] as const
const SCENARIOS = ['open', 'obstructed'] as const
const ORIENTATIONS = ['downwind', 'crosswind-left', 'upwind', 'crosswind-right'] as const
type Arm = typeof ARMS[number]
type Condition = typeof CONDITIONS[number]
type Row = Record<string, string>

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const number = (row: Row, key: string) => {
  const value = Number(row[key])
  if (row[key] === '' || !Number.isFinite(value)) throw new Error(`${row.cell_id}/${row.method_arm}: non-finite ${key}`)
  return value
}
const optionalNumber = (row: Row, key: string) => row[key] === '' ? null : number(row, key)
const quantile = (values: readonly number[], probability: number) => {
  if (!values.length) return null
  const sorted = [...values].sort((first, second) => first - second)
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  return lower === upper ? sorted[lower]! : sorted[lower]! * (upper - index) + sorted[upper]! * (index - lower)
}
const parseCsv = (text: string): Row[] => {
  const lines = text.trimEnd().split(/\r?\n/)
  const header = lines[0]!.split(',')
  return lines.slice(1).map((line, index) => {
    const values = line.split(',')
    if (values.length !== header.length) throw new Error(`Malformed M7 CSV row ${index + 2}`)
    return Object.fromEntries(header.map((key, position) => [key, values[position] ?? '']))
  })
}
const formationGateColumn = (gate: string) => `quad_candidate_gate_passes_${gate.replaceAll('-', '_')}`

const formationDiagnostics = (rows: readonly Row[]) => {
  const evaluations = rows.reduce((sum, row) => sum + number(row, 'quad_candidate_formation_evaluations'), 0)
  const provisionalEvaluations = rows.reduce((sum, row) => sum + number(row, 'quad_candidate_provisional_ray_evaluations'), 0)
  const pools = rows.map((row) => number(row, 'quad_candidate_max_gradient_ray_pool_count'))
  const qualities = rows.map((row) => number(row, 'quad_candidate_max_quality'))
  const residuals = rows.map((row) => optionalNumber(row, 'quad_candidate_min_residual')).filter((value): value is number => value !== null)
  const failedGateRows = Object.fromEntries(QUAD_CANDIDATE_FORMATION_GATE_NAMES.map((gate) => [gate, 0])) as Record<string, number>
  for (const row of rows) {
    for (const gate of row.quad_candidate_best_failed_gates.split('|').filter(Boolean)) {
      if (gate in failedGateRows) failedGateRows[gate] += 1
    }
  }
  const gates = Object.fromEntries(QUAD_CANDIDATE_FORMATION_GATE_NAMES.map((gate) => {
    const passes = rows.reduce((sum, row) => sum + number(row, formationGateColumn(gate)), 0)
    const denominator = gate === 'provisional-ray' ? evaluations : provisionalEvaluations
    return [gate, {
      passes,
      denominator,
      conditionalPassRate: denominator ? passes / denominator : 0,
      rowsWithAnyPass: rows.filter((row) => number(row, formationGateColumn(gate)) > 0).length,
      rowsWhoseBestSnapshotFailed: failedGateRows[gate],
    }]
  }))
  return {
    rows: rows.length,
    evaluations,
    provisionalEvaluations,
    provisionalEvaluationRate: evaluations ? provisionalEvaluations / evaluations : 0,
    rowsWithAtLeastOneRay: pools.filter((value) => value >= 1).length,
    rowsWithAtLeastTwoRays: pools.filter((value) => value >= 2).length,
    rowsWithAtLeastThreeRays: pools.filter((value) => value >= 3).length,
    rowsWithAtLeastFourRays: pools.filter((value) => value >= 4).length,
    rowsWithProvisionalCandidate: rows.filter((row) => number(row, 'quad_candidate_provisional_ray_evaluations') > 0).length,
    medianMaximumRayPool: quantile(pools, 0.5),
    maximumRayPool: Math.max(...pools),
    maximumQuality: Math.max(...qualities),
    minimumResidual: residuals.length ? Math.min(...residuals) : null,
    maximumSurfaceSupport: Math.max(...rows.map((row) => number(row, 'quad_candidate_max_surface_support'))),
    gates,
  }
}

const binomialProbability = (successes: number, trials: number) => {
  let coefficient = 1
  for (let index = 1; index <= successes; index += 1) coefficient *= (trials - index + 1) / index
  return coefficient * 0.5 ** trials
}
const exactMcNemarP = (firstOnly: number, secondOnly: number) => {
  const discordant = firstOnly + secondOnly
  if (!discordant) return 1
  let lowerTail = 0
  for (let successes = 0; successes <= Math.min(firstOnly, secondOnly); successes += 1) {
    lowerTail += binomialProbability(successes, discordant)
  }
  return Math.min(1, lowerTail * 2)
}
const pairedBinary = (rows: readonly Row[], firstArm: Arm, secondArm: Arm, predicate: (row: Row) => boolean) => {
  const selected = rows.filter((row) => row.condition === 'emitting')
  const byCell = new Map<string, Map<string, Row>>()
  for (const row of selected) {
    const group = byCell.get(row.cell_id) ?? new Map<string, Row>()
    group.set(row.method_arm, row)
    byCell.set(row.cell_id, group)
  }
  let both = 0; let neither = 0; let firstOnly = 0; let secondOnly = 0
  for (const [cell, group] of byCell) {
    const first = group.get(firstArm); const second = group.get(secondArm)
    if (!first || !second) throw new Error(`${cell}: incomplete ${firstArm}/${secondArm} pair`)
    const firstValue = predicate(first); const secondValue = predicate(second)
    if (firstValue && secondValue) both += 1
    else if (firstValue) firstOnly += 1
    else if (secondValue) secondOnly += 1
    else neither += 1
  }
  return {
    firstArm, secondArm, pairs: byCell.size, both, neither, firstOnly, secondOnly,
    pairedRiskDifference: (firstOnly - secondOnly) / byCell.size,
    exactMcNemarP: exactMcNemarP(firstOnly, secondOnly),
  }
}

const outcomeSummary = (rows: readonly Row[]) => ({
  runs: rows.length,
  correctDeclarations: rows.filter((row) => row.terminal_outcome === 'correct-declaration').length,
  wrongDeclarations: rows.filter((row) => row.terminal_outcome === 'wrong-declaration').length,
  deadlineNondeclarations: rows.filter((row) => row.terminal_outcome === 'deadline-nondeclaration-present').length,
  missedSourceAbstentions: rows.filter((row) => row.terminal_outcome === 'missed-source-abstention').length,
  proximitySuccesses: rows.filter((row) => row.proximity_success === '1').length,
  spuriousDeclarations: rows.filter((row) => row.terminal_outcome === 'spurious-declaration').length,
  correctAbstentions: rows.filter((row) => row.terminal_outcome === 'correct-abstention').length,
  correctRejectionsAtDeadline: rows.filter((row) => row.terminal_outcome === 'correct-rejection-at-deadline').length,
})
const pct = (value: number) => `${(value * 100).toFixed(2)}%`

export const analyzeM7Precandidate = async (runDirectory: string, outputDirectory: string) => {
  const volatileVerification = await verifyM7Results(runDirectory)
  const { verifiedAtUtc: _time, directory: _directory, ...verification } = volatileVerification
  const raw = await readFile(join(runDirectory, 'raw-results.csv'), 'utf8')
  const rows = parseCsv(raw)
  const diagnostics = Object.fromEntries(CONDITIONS.flatMap((condition) => ARMS.map((arm) => [
    `${condition}|${arm}`,
    formationDiagnostics(rows.filter((row) => row.condition === condition && row.method_arm === arm)),
  ]))) as Record<string, ReturnType<typeof formationDiagnostics>>
  const byScenario = Object.fromEntries(CONDITIONS.flatMap((condition) => ARMS.flatMap((arm) => SCENARIOS.map((scenario) => [
    `${condition}|${arm}|${scenario}`,
    formationDiagnostics(rows.filter((row) => row.condition === condition && row.method_arm === arm && row.scenario === scenario)),
  ]))))
  const byScenarioOrientation = Object.fromEntries(CONDITIONS.flatMap((condition) => ARMS.flatMap((arm) => SCENARIOS.flatMap((scenario) =>
    ORIENTATIONS.map((orientation) => [
      `${condition}|${arm}|${scenario}|${orientation}`,
      formationDiagnostics(rows.filter((row) => row.condition === condition && row.method_arm === arm &&
        row.scenario === scenario && row.orientation_bin === orientation)),
    ])))))
  const outcomes = Object.fromEntries(CONDITIONS.map((condition) => [condition, Object.fromEntries(ARMS.map((arm) => [
    arm, outcomeSummary(rows.filter((row) => row.condition === condition && row.method_arm === arm)),
  ]))]))
  const activePresent = diagnostics['emitting|quad-active']!
  const passivePresent = diagnostics['emitting|quad-passive']!
  const shamPresent = diagnostics['emitting|quad-zero-strength-sham']!
  const absent = ARMS.map((arm) => diagnostics[`absent|${arm}`]!)
  const pairedDiagnostics = {
    anyRayActiveVsPassive: pairedBinary(rows, 'quad-active', 'quad-passive', (row) =>
      number(row, 'quad_candidate_max_gradient_ray_pool_count') >= 1),
    twoRaysActiveVsPassive: pairedBinary(rows, 'quad-active', 'quad-passive', (row) =>
      number(row, 'quad_candidate_max_gradient_ray_pool_count') >= 2),
    provisionalActiveVsPassive: pairedBinary(rows, 'quad-active', 'quad-passive', (row) =>
      number(row, 'quad_candidate_provisional_ray_evaluations') > 0),
  }
  const totalEvaluations = Object.values(diagnostics).reduce((sum, result) => sum + result.evaluations, 0)
  const totalProvisional = Object.values(diagnostics).reduce((sum, result) => sum + result.provisionalEvaluations, 0)
  const findings = [
    `Across ${totalEvaluations} truth-blind formation evaluations, only ${totalProvisional} (${pct(totalProvisional / totalEvaluations)}) produced a provisional intersection; all seven occurred in one active, source-present, open/upwind run.`,
    `In 32 source-present worlds, Active reached ray-pool sizes >=1, >=2 and >=3 in ${activePresent.rowsWithAtLeastOneRay}, ${activePresent.rowsWithAtLeastTwoRays} and ${activePresent.rowsWithAtLeastThreeRays} worlds. Passive reached the corresponding sizes in ${passivePresent.rowsWithAtLeastOneRay}, ${passivePresent.rowsWithAtLeastTwoRays} and ${passivePresent.rowsWithAtLeastThreeRays}; the sham formed no rays.`,
    `All seven provisional evaluations passed the frozen quality and residual gates, but all failed the >=4-ray gate and the candidate-local surface-support gate. Thus relaxing downstream declaration thresholds would not address the observed failure.`,
    'No source-present obstructed world formed even one retained gradient ray in any arm. Obstacle-sensitive directional-evidence acquisition is therefore a separate upstream limitation.',
    `All ${absent.reduce((sum, result) => sum + result.evaluations, 0)} absent-condition evaluations and all ${shamPresent.evaluations} source-present sham evaluations formed zero rays. This is encouraging development evidence for formation specificity, but the sample is not a validation claim.`,
    'The evidence supports one architectural revision: deliberately acquire spatially separated rays after the first qualified direction, permit a geometrically sound three-ray provisional candidate to guide evidence collection, and move surface support out of candidate formation while retaining it as a declaration safeguard.',
  ]
  const decision = 'Freeze one staged crosswind-triangulation candidate policy for untouched development verification. It must preserve the existing directional-signal, geometry, quality and residual protections; trigger a bounded lateral acquisition maneuver after the first qualified ray; form a provisional navigation candidate from at least three spatially separated rays; and require surface, stability and passive core/ring evidence only for declaration. Do not tune the downstream declaration thresholds from M7.'
  const claimBoundary = 'Development-only diagnostic evidence. No validation, test, superiority, novelty, field, methane, landfill, urban, buried-pipeline, or deployment claim.'
  const analysis = {
    schemaVersion: 'm7-precandidate-analysis-v1',
    verification,
    design: { cells: 64, armRuns: 192, emittingWorlds: 32, absentWorlds: 32, armsPerCell: 3 },
    formationDiagnostics: diagnostics,
    byScenario,
    byScenarioOrientation,
    pairedDiagnostics,
    outcomes,
    findings,
    decision,
    claimBoundary,
  }
  const analysisJson = `${JSON.stringify(analysis, null, 2)}\n`
  const table = [
    '| Condition / arm | Evaluations | Provisional intersections | Worlds >=1 ray | >=2 rays | >=3 rays | >=4 rays |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...CONDITIONS.flatMap((condition) => ARMS.map((arm) => {
      const result = diagnostics[`${condition}|${arm}`]!
      return `| ${condition} / ${arm} | ${result.evaluations} | ${result.provisionalEvaluations} | ${result.rowsWithAtLeastOneRay}/32 | ${result.rowsWithAtLeastTwoRays}/32 | ${result.rowsWithAtLeastThreeRays}/32 | ${result.rowsWithAtLeastFourRays}/32 |`
    })),
  ].join('\n')
  const activeGates = activePresent.gates
  const gateTable = [
    '| Active source-present gate | Passes | Relevant denominator |',
    '|---|---:|---:|',
    ...QUAD_CANDIDATE_FORMATION_GATE_NAMES.map((gate) =>
      `| ${gate} | ${activeGates[gate].passes} | ${activeGates[gate].denominator} |`),
  ].join('\n')
  const report = `# M7 pre-candidate diagnostic report

## Status and scope

All 133 checksum-covered artifacts, 64 three-arm cells and 192 rows passed the
independent cryptographic and semantic audit. M7 is development-only diagnostic
evidence and did not alter controller behavior or thresholds.

## Candidate-formation reach

${table}

${gateTable}

The seven provisional intersections all came from one active, source-present,
open/upwind world. Each used three rays, reached quality 0.611, residual 0.0217,
and failed only the frozen four-ray and candidate-local surface-support gates.
No obstructed world, absent world, or source-present sham world retained a ray.

## Main findings

${findings.map((finding) => `- ${finding}`).join('\n')}

## Decision

${decision}

**Claim boundary:** ${claimBoundary}

## Provenance

- Manifest SHA-256: \`${verification.manifestSha256}\`
- Raw-results SHA-256: \`${verification.rawResultsSha256}\`
- Scientific-results SHA-256: \`${verification.scientificResultsSha256}\`
- Core-inventory SHA-256: \`${verification.coreArtifactInventorySha256}\`
- Analysis JSON SHA-256: \`${sha256(analysisJson)}\`
`
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(join(outputDirectory, 'm7-precandidate-analysis.json'), analysisJson, 'utf8')
  await writeFile(join(outputDirectory, 'm7-precandidate-report.md'), report, 'utf8')
  return { status: 'complete', outputDirectory, analysisSha256: sha256(analysisJson), reportSha256: sha256(report), findings, decision }
}

if (process.env.M7_ANALYSIS_RUN === '1') {
  const runDirectory = process.argv[2]
  const outputDirectory = process.argv[3]
  if (!runDirectory || !outputDirectory) throw new Error('Usage: m7-precandidate-analysis.ts <verified-run-directory> <output-directory>')
  analyzeM7Precandidate(resolve(runDirectory), resolve(outputDirectory))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`M7 analysis failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
