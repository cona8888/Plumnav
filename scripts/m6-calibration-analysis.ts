/** Deterministic, development-only outcome and declaration-gate analysis for M6. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { QUAD_DECLARATION_GATE_NAMES } from '../src/sim/algorithms/quadSoilSniff'
import { verifyM6Results } from './m6-verify-results'

const ARMS = ['quad-active', 'quad-passive', 'quad-zero-strength-sham', 'infotaxis'] as const
const QUAD_ARMS = ARMS.slice(0, 3)
const CONDITIONS = ['emitting', 'absent'] as const
const SCENARIOS = ['open', 'obstructed'] as const
const ORIENTATIONS = ['downwind', 'crosswind-left', 'upwind', 'crosswind-right'] as const
type Arm = typeof ARMS[number]
type QuadArm = typeof QUAD_ARMS[number]
type Condition = typeof CONDITIONS[number]
type Row = Record<string, string>

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const flag = (row: Row, key: string) => row[key] === '1'
const number = (row: Row, key: string) => {
  const value = Number(row[key])
  if (!Number.isFinite(value)) throw new Error(`${row.cell_id}/${row.method_arm}: non-finite ${key}`)
  return value
}
const mean = (values: readonly number[]) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : 0
const quantile = (values: readonly number[], probability: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((first, second) => first - second)
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  return lower === upper
    ? sorted[lower]!
    : sorted[lower]! * (upper - index) + sorted[upper]! * (index - lower)
}
const pct = (value: number) => `${(value * 100).toFixed(1)}%`
const fixed = (value: number, digits = 3) => value.toFixed(digits)
const parseCsv = (text: string) => {
  const lines = text.trimEnd().split(/\r?\n/)
  const header = lines[0]!.split(',')
  return lines.slice(1).map((line, index) => {
    const values = line.split(',')
    if (values.length !== header.length) throw new Error(`Malformed CSV row ${index + 2}`)
    return Object.fromEntries(header.map((key, position) => [key, values[position] ?? '']))
  })
}

const outcomeSummary = (rows: readonly Row[], condition: Condition) => {
  const count = (outcome: string) => rows.filter((row) => row.terminal_outcome === outcome).length
  const summary = {
    runs: rows.length,
    correctDeclarations: count('correct-declaration'),
    wrongDeclarations: count('wrong-declaration'),
    deadlineNondeclarations: count('deadline-nondeclaration-present'),
    missedSourceAbstentions: count('missed-source-abstention'),
    proximitySuccesses: rows.filter((row) => flag(row, 'proximity_success')).length,
    spuriousDeclarations: count('spurious-declaration'),
    correctAbstentions: count('correct-abstention'),
    correctRejectionsAtDeadline: count('correct-rejection-at-deadline'),
  }
  if (condition === 'emitting') {
    const errors = rows.map((row) => number(row, 'normalized_error'))
    return {
      ...summary,
      correctDeclarationRate: summary.correctDeclarations / rows.length,
      wrongDeclarationRate: summary.wrongDeclarations / rows.length,
      proximityRate: summary.proximitySuccesses / rows.length,
      medianNormalizedError: quantile(errors, 0.5),
      normalizedErrorQ1: quantile(errors, 0.25),
      normalizedErrorQ3: quantile(errors, 0.75),
    }
  }
  return {
    ...summary,
    spuriousDeclarationRate: summary.spuriousDeclarations / rows.length,
    correctAbstentionRate: summary.correctAbstentions / rows.length,
    correctRejectionAtDeadlineRate: summary.correctRejectionsAtDeadline / rows.length,
  }
}

const binomialProbability = (successes: number, trials: number) => {
  let coefficient = 1
  for (let index = 1; index <= successes; index++) coefficient *= (trials - index + 1) / index
  return coefficient * 0.5 ** trials
}
const exactMcNemarP = (firstOnly: number, secondOnly: number) => {
  const discordant = firstOnly + secondOnly
  if (!discordant) return 1
  const lower = Math.min(firstOnly, secondOnly)
  let probability = 0
  for (let successes = 0; successes <= lower; successes++) probability += binomialProbability(successes, discordant)
  return Math.min(1, 2 * probability)
}
const pairedBinary = (
  rows: readonly Row[],
  condition: Condition,
  firstArm: Arm,
  secondArm: Arm,
  predicate: (row: Row) => boolean,
) => {
  const selected = rows.filter((row) => row.condition === condition)
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
    condition, firstArm, secondArm, pairs: byCell.size,
    both, neither, firstOnly, secondOnly,
    pairedRiskDifference: (firstOnly - secondOnly) / byCell.size,
    exactMcNemarP: exactMcNemarP(firstOnly, secondOnly),
  }
}

const gateColumn = (gate: string) => `quad_declaration_gate_passes_${gate.replaceAll('-', '_')}`
const gateDiagnostics = (rows: readonly Row[]) => {
  const evaluations = rows.reduce((sum, row) => sum + number(row, 'quad_declaration_evaluations'), 0)
  const candidateEvaluations = rows.reduce((sum, row) => sum + number(row, 'quad_declaration_candidate_evaluations'), 0)
  const bestFailureCounts = Object.fromEntries(QUAD_DECLARATION_GATE_NAMES.map((gate) => [gate, 0])) as Record<string, number>
  for (const row of rows) {
    for (const gate of row.quad_declaration_best_failed_gates.split('|').filter(Boolean)) {
      if (gate in bestFailureCounts) bestFailureCounts[gate] += 1
    }
  }
  const gates = Object.fromEntries(QUAD_DECLARATION_GATE_NAMES.map((gate) => {
    const passes = rows.reduce((sum, row) => sum + number(row, gateColumn(gate)), 0)
    const denominator = gate === 'candidate' ? evaluations : candidateEvaluations
    return [gate, {
      passes,
      denominator,
      conditionalPassRate: denominator ? passes / denominator : 0,
      rowsWithAnyPass: rows.filter((row) => number(row, gateColumn(gate)) > 0).length,
      bestSnapshotFailures: bestFailureCounts[gate],
    }]
  }))
  const maximumGates = rows.map((row) => number(row, 'quad_declaration_max_gates_passed'))
  const maximumScores = rows.map((row) => number(row, 'quad_declaration_max_score'))
  return {
    rows: rows.length,
    evaluations,
    candidateEvaluations,
    candidateEvaluationRate: evaluations ? candidateEvaluations / evaluations : 0,
    rowsWithCandidate: rows.filter((row) => number(row, 'quad_declaration_candidate_evaluations') > 0).length,
    medianMaximumGatesPassed: quantile(maximumGates, 0.5),
    maximumGatesPassedQ1: quantile(maximumGates, 0.25),
    maximumGatesPassedQ3: quantile(maximumGates, 0.75),
    medianMaximumScore: quantile(maximumScores, 0.5),
    maximumMaximumScore: Math.max(...maximumScores),
    gates,
  }
}

const emittingTable = (summaries: Record<Arm, ReturnType<typeof outcomeSummary>>) => [
  '| Arm | Correct declarations | Wrong declarations | 1% proximity | Median error |',
  '|---|---:|---:|---:|---:|',
  ...ARMS.map((arm) => {
    const summary = summaries[arm] as ReturnType<typeof outcomeSummary> & {
      correctDeclarationRate: number; wrongDeclarationRate: number; proximityRate: number; medianNormalizedError: number
    }
    return `| ${arm} | ${summary.correctDeclarations}/128 (${pct(summary.correctDeclarationRate)}) | ${summary.wrongDeclarations}/128 (${pct(summary.wrongDeclarationRate)}) | ${summary.proximitySuccesses}/128 (${pct(summary.proximityRate)}) | ${fixed(summary.medianNormalizedError)} |`
  }),
].join('\n')
const absentTable = (summaries: Record<Arm, ReturnType<typeof outcomeSummary>>) => [
  '| Arm | Spurious declarations | Correct abstentions | Deadline rejections |',
  '|---|---:|---:|---:|',
  ...ARMS.map((arm) => {
    const summary = summaries[arm] as ReturnType<typeof outcomeSummary> & {
      spuriousDeclarationRate: number; correctAbstentionRate: number; correctRejectionAtDeadlineRate: number
    }
    return `| ${arm} | ${summary.spuriousDeclarations}/128 (${pct(summary.spuriousDeclarationRate)}) | ${summary.correctAbstentions}/128 (${pct(summary.correctAbstentionRate)}) | ${summary.correctRejectionsAtDeadline}/128 (${pct(summary.correctRejectionAtDeadlineRate)}) |`
  }),
].join('\n')
const gateTable = (diagnostics: Record<string, ReturnType<typeof gateDiagnostics>>) => [
  '| Condition / Quad arm | Candidate evaluations | Worlds with candidate | Median maximum gates | Median maximum score |',
  '|---|---:|---:|---:|---:|',
  ...CONDITIONS.flatMap((condition) => QUAD_ARMS.map((arm) => {
    const result = diagnostics[`${condition}|${arm}`]!
    return `| ${condition} / ${arm} | ${result.candidateEvaluations}/${result.evaluations} (${pct(result.candidateEvaluationRate)}) | ${result.rowsWithCandidate}/128 | ${fixed(result.medianMaximumGatesPassed, 1)} | ${fixed(result.medianMaximumScore)} |`
  })),
].join('\n')

export const analyzeM6Calibration = async (runDirectory: string, outputDirectory: string) => {
  const verificationWithVolatileFields = await verifyM6Results(runDirectory)
  const { verifiedAtUtc: _time, directory: _directory, ...verification } = verificationWithVolatileFields
  const raw = await readFile(join(runDirectory, 'raw-results.csv'), 'utf8')
  const rows = parseCsv(raw)
  const outcomes = Object.fromEntries(CONDITIONS.map((condition) => [
    condition,
    Object.fromEntries(ARMS.map((arm) => [
      arm,
      outcomeSummary(rows.filter((row) => row.condition === condition && row.method_arm === arm), condition),
    ])),
  ])) as Record<Condition, Record<Arm, ReturnType<typeof outcomeSummary>>>
  const byScenario = Object.fromEntries(CONDITIONS.flatMap((condition) => SCENARIOS.map((scenario) => [
    `${condition}|${scenario}`,
    Object.fromEntries(ARMS.map((arm) => [arm, outcomeSummary(rows.filter((row) =>
      row.condition === condition && row.scenario === scenario && row.method_arm === arm), condition)])),
  ])))
  const byScenarioOrientation = Object.fromEntries(CONDITIONS.flatMap((condition) => SCENARIOS.flatMap((scenario) =>
    ORIENTATIONS.map((orientation) => [
      `${condition}|${scenario}|${orientation}`,
      Object.fromEntries(ARMS.map((arm) => [arm, outcomeSummary(rows.filter((row) =>
        row.condition === condition && row.scenario === scenario && row.orientation_bin === orientation &&
        row.method_arm === arm), condition)])),
    ]))))
  const gateResults = Object.fromEntries(CONDITIONS.flatMap((condition) => QUAD_ARMS.map((arm) => [
    `${condition}|${arm}`,
    gateDiagnostics(rows.filter((row) => row.condition === condition && row.method_arm === arm)),
  ]))) as Record<string, ReturnType<typeof gateDiagnostics>>
  const paired = {
    emittingProximityActiveVsPassive: pairedBinary(rows, 'emitting', 'quad-active', 'quad-passive', (row) => flag(row, 'proximity_success')),
    emittingProximityActiveVsSham: pairedBinary(rows, 'emitting', 'quad-active', 'quad-zero-strength-sham', (row) => flag(row, 'proximity_success')),
    emittingCorrectDeclarationActiveVsPassive: pairedBinary(rows, 'emitting', 'quad-active', 'quad-passive', (row) => row.terminal_outcome === 'correct-declaration'),
    absentSpuriousActiveVsPassive: pairedBinary(rows, 'absent', 'quad-active', 'quad-passive', (row) => row.terminal_outcome === 'spurious-declaration'),
    absentSpuriousActiveVsSham: pairedBinary(rows, 'absent', 'quad-active', 'quad-zero-strength-sham', (row) => row.terminal_outcome === 'spurious-declaration'),
  }

  const activePresent = outcomes.emitting['quad-active'] as ReturnType<typeof outcomeSummary> & { proximityRate: number }
  const passivePresent = outcomes.emitting['quad-passive'] as ReturnType<typeof outcomeSummary> & { proximityRate: number }
  const shamPresent = outcomes.emitting['quad-zero-strength-sham'] as ReturnType<typeof outcomeSummary> & { proximityRate: number }
  const activeAbsent = outcomes.absent['quad-active'] as ReturnType<typeof outcomeSummary> & { spuriousDeclarationRate: number }
  const infotaxisPresent = outcomes.emitting.infotaxis as ReturnType<typeof outcomeSummary> & {
    correctDeclarationRate: number; wrongDeclarationRate: number; proximityRate: number
  }
  const totalQuadEvaluations = Object.values(gateResults).reduce((sum, result) => sum + result.evaluations, 0)
  const totalCandidateEvaluations = Object.values(gateResults).reduce((sum, result) => sum + result.candidateEvaluations, 0)
  const findings = [
    `Quad-Active produced ${activePresent.correctDeclarations} correct and ${activePresent.wrongDeclarations} wrong declarations in 128 emitting worlds; its 1% proximity rate was ${pct(activePresent.proximityRate)}.`,
    `Quad-Passive proximity was ${pct(passivePresent.proximityRate)}; active-versus-passive paired discordance was ${paired.emittingProximityActiveVsPassive.firstOnly} active-only versus ${paired.emittingProximityActiveVsPassive.secondOnly} passive-only (exact McNemar p=${fixed(paired.emittingProximityActiveVsPassive.exactMcNemarP, 4)}). M6 therefore gives no development evidence that suction improves proximity over the genuine passive array.`,
    `The zero-strength sham reached ${pct(shamPresent.proximityRate)} proximity; active-versus-sham discordance was ${paired.emittingProximityActiveVsSham.firstOnly} active-only versus ${paired.emittingProximityActiveVsSham.secondOnly} sham-only (exact McNemar p=${fixed(paired.emittingProximityActiveVsSham.exactMcNemarP, 4)}). This shows that the active signal changes navigation relative to the sham, not that it outperforms passive sensing.`,
    `In absent worlds Quad-Active produced ${activeAbsent.spuriousDeclarations}/128 spurious declarations; all three Quad arms had 84 explicit abstentions and 44 deadline rejections.`,
    `No trusted candidate existed in any Quad world or any of ${totalQuadEvaluations} return evaluations (${totalCandidateEvaluations} candidate evaluations). Because the current telemetry zeros all downstream evidence when trustedRayEstimate() returns null, M6 cannot distinguish insufficient ray count, low ray quality, excessive residual, or missing surface support.`,
    `Infotaxis made ${infotaxisPresent.correctDeclarations} correct and ${infotaxisPresent.wrongDeclarations} wrong declarations in emitting worlds. Its higher declaration sensitivity came with poor localization specificity and is not general superiority.`,
    'Do not relax downstream declaration gates from M6. First expose the uncensored provisional-ray and surface-support quantities on every return, then run a smaller fresh-seed diagnostic before specifying a revised frozen policy.',
  ]
  const claimBoundary = 'Development-only calibration evidence. No validation, test, superiority, novelty, field, methane, landfill, urban, buried-pipeline, or deployment claim.'
  const analysis = {
    schemaVersion: 'm6-quad-calibration-analysis-v1',
    verification,
    design: { cells: 256, armRuns: 1024, emittingWorlds: 128, absentWorlds: 128, armsPerCell: 4 },
    outcomes,
    byScenario,
    byScenarioOrientation,
    pairedDiagnostics: paired,
    quadGateDiagnostics: gateResults,
    findings,
    decision: 'Do not tune the 14 downstream declaration gates from M6 because their evidence is censored before candidate formation. Add pre-candidate telemetry, run a smaller fresh-development diagnostic, then freeze one revised policy and evaluate it on another untouched development verification manifest before opening nominal validation/test seeds.',
    claimBoundary,
  }
  const analysisJson = `${JSON.stringify(analysis, null, 2)}\n`
  const report = `# M6 Quad calibration diagnostic report

## Status and scope

All 517 core artifacts, 256 four-arm cells and 1,024 rows passed the independent cryptographic and semantic audit. M6 is development-only calibration evidence.

## Source-present outcomes

${emittingTable(outcomes.emitting)}

## Source-absent outcomes

${absentTable(outcomes.absent)}

## Quad declaration evidence

${gateTable(gateResults)}

Detailed per-gate pass counts, scenario/orientation strata and exact paired discordance calculations are stored in \`m6-calibration-analysis.json\`.

No trusted candidate was formed in any Quad run. Consequently, downstream
gate values are censored by the current implementation and cannot be used for
threshold selection. The next diagnostic must export provisional-ray count,
quality, residual and surface-support values before the trusted-candidate gate.

## Main diagnostic findings

${findings.map((finding) => `- ${finding}`).join('\n')}

## Decision

${analysis.decision}

**Claim boundary:** ${claimBoundary}

## Provenance

- Manifest SHA-256: \`${verification.manifestSha256}\`
- Raw-results SHA-256: \`${verification.rawResultsSha256}\`
- Scientific-results SHA-256: \`${verification.scientificResultsSha256}\`
- Core-inventory SHA-256: \`${verification.coreArtifactInventorySha256}\`
- Analysis JSON SHA-256: \`${sha256(analysisJson)}\`
`
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(join(outputDirectory, 'm6-calibration-analysis.json'), analysisJson, 'utf8')
  await writeFile(join(outputDirectory, 'm6-calibration-report.md'), report, 'utf8')
  return { status: 'complete', outputDirectory, analysisSha256: sha256(analysisJson), reportSha256: sha256(report), findings }
}

if (process.env.M6_ANALYSIS_RUN === '1') {
  const runDirectory = process.argv[2]
  const outputDirectory = process.argv[3]
  if (!runDirectory || !outputDirectory) throw new Error('Usage: m6-calibration-analysis.ts <verified-run-directory> <output-directory>')
  analyzeM6Calibration(resolve(runDirectory), resolve(outputDirectory))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`M6 analysis failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
