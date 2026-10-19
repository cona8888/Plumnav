/** Deterministic decision analysis for the frozen M8 staged-policy verification. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { QUAD_CANDIDATE_FORMATION_GATE_NAMES } from '../src/sim/algorithms/quadSoilSniff'
import { verifyM8Results } from './m8-verify-results'

const ARMS = [
  'staged-active',
  'legacy-active',
  'staged-passive',
  'staged-zero-strength-sham',
] as const
const CONDITIONS = ['emitting', 'absent'] as const
const SCENARIOS = ['open', 'obstructed'] as const
const ORIENTATIONS = ['downwind', 'crosswind-left', 'upwind', 'crosswind-right'] as const
type Arm = typeof ARMS[number]
type Condition = typeof CONDITIONS[number]
type Row = Record<string, string>

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const number = (row: Row, key: string) => {
  const value = Number(row[key])
  if (row[key] === '' || !Number.isFinite(value)) {
    throw new Error(`${row.cell_id}/${row.method_arm}: non-finite ${key}`)
  }
  return value
}
const optionalNumber = (row: Row, key: string) => row[key] === '' ? null : number(row, key)
const quantile = (values: readonly number[], probability: number) => {
  if (!values.length) return null
  const sorted = [...values].sort((first, second) => first - second)
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  return lower === upper
    ? sorted[lower]!
    : sorted[lower]! * (upper - index) + sorted[upper]! * (index - lower)
}
const parseCsv = (text: string): Row[] => {
  const lines = text.trimEnd().split(/\r?\n/)
  const header = lines[0]!.split(',')
  return lines.slice(1).map((line, index) => {
    const values = line.split(',')
    if (values.length !== header.length) throw new Error(`Malformed M8 CSV row ${index + 2}`)
    return Object.fromEntries(header.map((key, position) => [key, values[position] ?? '']))
  })
}
const formationGateColumn = (gate: string) =>
  `quad_candidate_gate_passes_${gate.replaceAll('-', '_')}`
const trustedCandidate = (row: Row) => row.quad_candidate_best_trusted === '1'
const spuriousDeclaration = (row: Row) => row.terminal_outcome === 'spurious-declaration'

const candidateError = (row: Row) => {
  const dx = number(row, 'quad_candidate_best_provisional_x') - number(row, 'source_x_normalized')
  const dy = number(row, 'quad_candidate_best_provisional_y') - number(row, 'source_y_normalized')
  return Math.hypot(dx, dy)
}

const formationDiagnostics = (rows: readonly Row[]) => {
  const evaluations = rows.reduce((sum, row) => sum + number(row, 'quad_candidate_formation_evaluations'), 0)
  const provisionalEvaluations = rows.reduce(
    (sum, row) => sum + number(row, 'quad_candidate_provisional_ray_evaluations'), 0)
  const pools = rows.map((row) => number(row, 'quad_candidate_max_gradient_ray_pool_count'))
  const qualities = rows.map((row) => number(row, 'quad_candidate_max_quality'))
  const residuals = rows.map((row) => optionalNumber(row, 'quad_candidate_min_residual'))
    .filter((value): value is number => value !== null)
  const trustedRows = rows.filter(trustedCandidate)
  const candidateErrors = trustedRows
    .filter((row) => row.condition === 'emitting')
    .map(candidateError)
  const gates = Object.fromEntries(QUAD_CANDIDATE_FORMATION_GATE_NAMES.map((gate) => {
    const passes = rows.reduce((sum, row) => sum + number(row, formationGateColumn(gate)), 0)
    const denominator = gate === 'provisional-ray' ? evaluations : provisionalEvaluations
    return [gate, {
      passes,
      denominator,
      conditionalPassRate: denominator ? passes / denominator : 0,
      rowsWithAnyPass: rows.filter((row) => number(row, formationGateColumn(gate)) > 0).length,
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
    trustedCandidateWorlds: trustedRows.length,
    medianMaximumRayPool: quantile(pools, 0.5),
    maximumRayPool: Math.max(...pools),
    maximumQuality: Math.max(...qualities),
    minimumResidual: residuals.length ? Math.min(...residuals) : null,
    maximumSurfaceSupport: Math.max(...rows.map((row) =>
      number(row, 'quad_candidate_max_surface_support'))),
    trustedCandidateErrorNormalized: {
      count: candidateErrors.length,
      minimum: candidateErrors.length ? Math.min(...candidateErrors) : null,
      median: quantile(candidateErrors, 0.5),
      maximum: candidateErrors.length ? Math.max(...candidateErrors) : null,
    },
    gates,
  }
}

const binomialProbability = (successes: number, trials: number) => {
  let coefficient = 1
  for (let index = 1; index <= successes; index += 1) {
    coefficient *= (trials - index + 1) / index
  }
  return coefficient * 0.5 ** trials
}
export const exactM8McNemarP = (firstOnly: number, secondOnly: number) => {
  const discordant = firstOnly + secondOnly
  if (!discordant) return 1
  let lowerTail = 0
  for (let successes = 0; successes <= Math.min(firstOnly, secondOnly); successes += 1) {
    lowerTail += binomialProbability(successes, discordant)
  }
  return Math.min(1, lowerTail * 2)
}
const pairedTrustedCandidates = (rows: readonly Row[]) => {
  const selected = rows.filter((row) => row.condition === 'emitting')
  const byCell = new Map<string, Map<string, Row>>()
  for (const row of selected) {
    const group = byCell.get(row.cell_id) ?? new Map<string, Row>()
    group.set(row.method_arm, row)
    byCell.set(row.cell_id, group)
  }
  let both = 0
  let neither = 0
  let stagedOnly = 0
  let legacyOnly = 0
  for (const [cell, group] of byCell) {
    const staged = group.get('staged-active')
    const legacy = group.get('legacy-active')
    if (!staged || !legacy) throw new Error(`${cell}: incomplete staged/legacy pair`)
    const stagedValue = trustedCandidate(staged)
    const legacyValue = trustedCandidate(legacy)
    if (stagedValue && legacyValue) both += 1
    else if (stagedValue) stagedOnly += 1
    else if (legacyValue) legacyOnly += 1
    else neither += 1
  }
  return {
    pairs: byCell.size,
    both,
    neither,
    stagedOnly,
    legacyOnly,
    stagedOnlyMinusLegacyOnly: stagedOnly - legacyOnly,
    pairedRiskDifference: (stagedOnly - legacyOnly) / byCell.size,
    exactMcNemarP: exactM8McNemarP(stagedOnly, legacyOnly),
  }
}

const outcomeSummary = (rows: readonly Row[]) => ({
  runs: rows.length,
  correctDeclarations: rows.filter((row) => row.terminal_outcome === 'correct-declaration').length,
  wrongDeclarations: rows.filter((row) => row.terminal_outcome === 'wrong-declaration').length,
  deadlineNondeclarations: rows.filter((row) => row.terminal_outcome === 'deadline-nondeclaration-present').length,
  missedSourceAbstentions: rows.filter((row) => row.terminal_outcome === 'missed-source-abstention').length,
  proximitySuccesses: rows.filter((row) => row.proximity_success === '1').length,
  spuriousDeclarations: rows.filter(spuriousDeclaration).length,
  correctAbstentions: rows.filter((row) => row.terminal_outcome === 'correct-abstention').length,
  correctRejectionsAtDeadline: rows.filter(
    (row) => row.terminal_outcome === 'correct-rejection-at-deadline').length,
})

const candidateDetails = (rows: readonly Row[]) => rows
  .filter((row) => row.condition === 'emitting' && trustedCandidate(row))
  .map((row) => ({
    cellId: row.cell_id,
    arm: row.method_arm,
    scenario: row.scenario,
    orientation: row.orientation_bin,
    errorNormalized: candidateError(row),
    rayCount: number(row, 'quad_candidate_best_provisional_ray_count'),
    quality: number(row, 'quad_candidate_best_quality'),
    residual: number(row, 'quad_candidate_best_residual'),
    surfaceSupport: number(row, 'quad_candidate_best_surface_support'),
    terminalOutcome: row.terminal_outcome,
  }))
  .sort((first, second) => first.cellId.localeCompare(second.cellId) || first.arm.localeCompare(second.arm))

const pct = (value: number) => `${(value * 100).toFixed(2)}%`
const fixed = (value: number | null, digits = 4) => value === null ? 'n/a' : value.toFixed(digits)

export const analyzeM8StagedVerification = async (runDirectory: string, outputDirectory: string) => {
  const volatileVerification = await verifyM8Results(runDirectory)
  const { verifiedAtUtc: _time, directory: _directory, ...verification } = volatileVerification
  const raw = await readFile(join(runDirectory, 'raw-results.csv'), 'utf8')
  const rows = parseCsv(raw)
  const manifest = JSON.parse(await readFile(join(runDirectory, 'manifest.json'), 'utf8')) as {
    unchangedDeclarationPolicy?: boolean
    frozenRevision?: { version?: string }
  }
  const diagnostics = Object.fromEntries(CONDITIONS.flatMap((condition) => ARMS.map((arm) => [
    `${condition}|${arm}`,
    formationDiagnostics(rows.filter((row) => row.condition === condition && row.method_arm === arm)),
  ]))) as Record<string, ReturnType<typeof formationDiagnostics>>
  const byScenario = Object.fromEntries(CONDITIONS.flatMap((condition) => ARMS.flatMap((arm) =>
    SCENARIOS.map((scenario) => [
      `${condition}|${arm}|${scenario}`,
      formationDiagnostics(rows.filter((row) => row.condition === condition &&
        row.method_arm === arm && row.scenario === scenario)),
    ])))) as Record<string, ReturnType<typeof formationDiagnostics>>
  const byScenarioOrientation = Object.fromEntries(CONDITIONS.flatMap((condition) => ARMS.flatMap((arm) =>
    SCENARIOS.flatMap((scenario) => ORIENTATIONS.map((orientation) => [
      `${condition}|${arm}|${scenario}|${orientation}`,
      formationDiagnostics(rows.filter((row) => row.condition === condition &&
        row.method_arm === arm && row.scenario === scenario && row.orientation_bin === orientation)),
    ])))))
  const outcomes = Object.fromEntries(CONDITIONS.map((condition) => [condition,
    Object.fromEntries(ARMS.map((arm) => [arm, outcomeSummary(rows.filter((row) =>
      row.condition === condition && row.method_arm === arm))]))]))

  const stagedPresent = diagnostics['emitting|staged-active']!
  const legacyPresent = diagnostics['emitting|legacy-active']!
  const stagedObstructed = byScenario['emitting|staged-active|obstructed']!
  const paired = pairedTrustedCandidates(rows)
  const stagedAbsentRows = rows.filter((row) =>
    row.condition === 'absent' && row.method_arm === 'staged-active')
  const stagedAbsentSpurious = stagedAbsentRows.filter(spuriousDeclaration).length
  const declarationPolicyUnchanged = manifest.unchangedDeclarationPolicy === true &&
    manifest.frozenRevision?.version === 'quad-staged-crosswind-v1'
  const criteria = [
    {
      id: 'C1-staged-candidate-reach',
      requirement: 'staged-active trusted candidates >= 8/64 emitting worlds',
      observed: stagedPresent.trustedCandidateWorlds,
      threshold: 8,
      passed: stagedPresent.trustedCandidateWorlds >= 8,
    },
    {
      id: 'C2-paired-improvement',
      requirement: 'staged-only minus legacy-only >= 6 and two-sided exact McNemar p <= 0.05',
      observed: {
        stagedOnly: paired.stagedOnly,
        legacyOnly: paired.legacyOnly,
        difference: paired.stagedOnlyMinusLegacyOnly,
        exactMcNemarP: paired.exactMcNemarP,
      },
      threshold: { minimumDifference: 6, maximumP: 0.05 },
      passed: paired.stagedOnlyMinusLegacyOnly >= 6 && paired.exactMcNemarP <= 0.05,
    },
    {
      id: 'C3-obstructed-candidate-reach',
      requirement: 'staged-active trusted candidates >= 4/32 obstructed emitting worlds',
      observed: stagedObstructed.trustedCandidateWorlds,
      threshold: 4,
      passed: stagedObstructed.trustedCandidateWorlds >= 4,
    },
    {
      id: 'C4-source-absent-safety',
      requirement: 'zero staged-active spurious declarations in 64 absent worlds',
      observed: stagedAbsentSpurious,
      threshold: 0,
      passed: stagedAbsentSpurious === 0,
    },
    {
      id: 'C5-no-downstream-retuning',
      requirement: 'no downstream declaration threshold changed after outcomes were viewed',
      observed: declarationPolicyUnchanged,
      threshold: true,
      passed: declarationPolicyUnchanged,
    },
  ]
  const failedCriteria = criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.id)
  const proceed = failedCriteria.length === 0
  const candidates = candidateDetails(rows)
  const stagedCandidateErrors = stagedPresent.trustedCandidateErrorNormalized
  const allAbsentSpurious = rows.filter((row) => row.condition === 'absent' && spuriousDeclaration(row)).length
  const findings = [
    `Staged-active formed trusted candidates in ${stagedPresent.trustedCandidateWorlds}/64 emitting worlds versus ${legacyPresent.trustedCandidateWorlds}/64 for legacy-active. The paired table was staged-only ${paired.stagedOnly}, legacy-only ${paired.legacyOnly}, both ${paired.both}, neither ${paired.neither}; the risk difference was ${pct(paired.pairedRiskDifference)} and two-sided exact McNemar p=${paired.exactMcNemarP.toFixed(4)}.`,
    `The primary reach criterion failed (${stagedPresent.trustedCandidateWorlds} observed; 8 required), and the paired improvement criterion failed (${paired.stagedOnlyMinusLegacyOnly} staged-only excess; 6 required).`,
    `In open emitting worlds, staged-active retained at least one, two and three rays in ${byScenario['emitting|staged-active|open']!.rowsWithAtLeastOneRay}/32, ${byScenario['emitting|staged-active|open']!.rowsWithAtLeastTwoRays}/32 and ${byScenario['emitting|staged-active|open']!.rowsWithAtLeastThreeRays}/32 worlds. In obstructed emitting worlds the corresponding counts were ${stagedObstructed.rowsWithAtLeastOneRay}/32, ${stagedObstructed.rowsWithAtLeastTwoRays}/32 and ${stagedObstructed.rowsWithAtLeastThreeRays}/32, with ${stagedObstructed.trustedCandidateWorlds} trusted candidates.`,
    `The ${stagedPresent.trustedCandidateWorlds} staged candidates had normalized source errors from ${fixed(stagedCandidateErrors.minimum)} to ${fixed(stagedCandidateErrors.maximum)} (median ${fixed(stagedCandidateErrors.median)}). None accumulated candidate-local surface support or produced a source declaration.`,
    `Source-absent safety passed: staged-active produced ${stagedAbsentSpurious}/64 spurious declarations, and all four arms together produced ${allAbsentSpurious}/256. This is development-verification evidence, not nominal validation.`,
    'The staged maneuver improved candidate formation in three open worlds but did not solve multi-view acquisition or obstacle occlusion. The next revision must remain upstream: adaptive viewpoint acquisition plus candidate-conditioned passive surface confirmation, without relaxing declaration safeguards.',
  ]
  const decision = proceed
    ? 'All frozen M8 criteria passed; nominal validation design may be opened without retuning the frozen controller.'
    : `M8 failed frozen criteria ${failedCriteria.join(', ')}. Do not open nominal validation or test seeds. Return to upstream acquisition design while preserving the downstream declaration safeguards.`
  const claimBoundary = 'Untouched development-verification evidence only. No nominal validation, test, superiority, novelty, field, methane, landfill, urban, buried-pipeline, or deployment claim.'
  const analysis = {
    schemaVersion: 'm8-staged-policy-verification-analysis-v1',
    verification,
    design: { cells: 128, armRuns: 512, emittingWorlds: 64, absentWorlds: 64, armsPerCell: 4 },
    frozenPolicyVersion: manifest.frozenRevision?.version,
    criteria,
    failedCriteria,
    proceedToNominalValidation: proceed,
    pairedTrustedCandidates: paired,
    formationDiagnostics: diagnostics,
    byScenario,
    byScenarioOrientation,
    trustedCandidateDetails: candidates,
    outcomes,
    findings,
    decision,
    claimBoundary,
  }
  const analysisJson = `${JSON.stringify(analysis, null, 2)}\n`
  const criteriaTable = [
    '| Criterion | Observed | Frozen requirement | Result |',
    '|---|---:|---|---|',
    `| C1 candidate reach | ${stagedPresent.trustedCandidateWorlds}/64 | >=8/64 | ${criteria[0]!.passed ? 'PASS' : 'FAIL'} |`,
    `| C2 paired improvement | ${paired.stagedOnly}-${paired.legacyOnly}; difference ${paired.stagedOnlyMinusLegacyOnly}; p=${paired.exactMcNemarP.toFixed(4)} | difference >=6 and p<=0.05 | ${criteria[1]!.passed ? 'PASS' : 'FAIL'} |`,
    `| C3 obstructed reach | ${stagedObstructed.trustedCandidateWorlds}/32 | >=4/32 | ${criteria[2]!.passed ? 'PASS' : 'FAIL'} |`,
    `| C4 absent safety | ${stagedAbsentSpurious}/64 spurious | 0/64 | ${criteria[3]!.passed ? 'PASS' : 'FAIL'} |`,
    `| C5 no downstream retuning | ${declarationPolicyUnchanged ? 'unchanged' : 'not verified'} | unchanged | ${criteria[4]!.passed ? 'PASS' : 'FAIL'} |`,
  ].join('\n')
  const reachTable = [
    '| Emitting arm / setting | Worlds | >=1 ray | >=2 rays | >=3 rays | Trusted candidate |',
    '|---|---:|---:|---:|---:|---:|',
    ...ARMS.flatMap((arm) => SCENARIOS.map((scenario) => {
      const result = byScenario[`emitting|${arm}|${scenario}`]!
      return `| ${arm} / ${scenario} | ${result.rows} | ${result.rowsWithAtLeastOneRay} | ${result.rowsWithAtLeastTwoRays} | ${result.rowsWithAtLeastThreeRays} | ${result.trustedCandidateWorlds} |`
    })),
  ].join('\n')
  const candidateTable = candidates.length
    ? [
        '| Cell | Arm | Orientation | Error (normalized) | Rays | Quality | Residual | Surface support |',
        '|---|---|---|---:|---:|---:|---:|---:|',
        ...candidates.map((candidate) =>
          `| ${candidate.cellId} | ${candidate.arm} | ${candidate.orientation} | ${candidate.errorNormalized.toFixed(4)} | ${candidate.rayCount} | ${candidate.quality.toFixed(4)} | ${candidate.residual.toFixed(4)} | ${candidate.surfaceSupport} |`),
      ].join('\n')
    : 'No trusted candidates were formed.'
  const report = `# M8 staged-policy verification report

## Decision

**${proceed ? 'PROCEED — nominal validation design may be opened.' : 'HALT — nominal validation remains sealed.'}**

${decision}

${criteriaTable}

## What M8 demonstrated

${findings.map((finding) => `- ${finding}`).join('\n')}

## Acquisition reach

${reachTable}

## Trusted candidates

${candidateTable}

Candidate error is descriptive because candidate formation, not localization
accuracy, was the frozen primary endpoint. A trusted candidate is a navigation
target; final declaration safeguards remained unchanged.

## Scientific interpretation

The staged policy produced a small, directionally favourable change relative
to the legacy policy (three staged-only candidate worlds), but the frozen
minimum effect and significance requirements were not met. Evidence attrition
remains severe between the first and third spatially separated rays, and the
obstructed condition remains the decisive failure mode. Moreover, none of the
three candidates led to passive surface confirmation or a declaration.

The next development revision should alter how evidence is acquired, not what
counts as a declaration: use flow- and visibility-aware adaptive crosswind
viewpoints after the first ray, explicitly escape occluded wakes, and execute a
bounded passive confirmation pattern around a trusted candidate. These are
hypotheses for a newly frozen development study, not conclusions from M8.

**Claim boundary:** ${claimBoundary}

## Provenance

- Manifest SHA-256: \`${verification.manifestSha256}\`
- Raw-results SHA-256: \`${verification.rawResultsSha256}\`
- Scientific-results SHA-256: \`${verification.scientificResultsSha256}\`
- Core-inventory SHA-256: \`${verification.coreArtifactInventorySha256}\`
- Analysis JSON SHA-256: \`${sha256(analysisJson)}\`
`
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(join(outputDirectory, 'm8-staged-verification-analysis.json'), analysisJson, 'utf8')
  await writeFile(join(outputDirectory, 'm8-staged-verification-report.md'), report, 'utf8')
  return {
    status: 'complete',
    outputDirectory,
    proceedToNominalValidation: proceed,
    failedCriteria,
    analysisSha256: sha256(analysisJson),
    reportSha256: sha256(report),
    findings,
    decision,
  }
}

if (process.env.M8_ANALYSIS_RUN === '1') {
  const runDirectory = process.argv[2]
  const outputDirectory = process.argv[3]
  if (!runDirectory || !outputDirectory) {
    throw new Error('Usage: m8-staged-verification-analysis.ts <verified-run-directory> <output-directory>')
  }
  analyzeM8StagedVerification(resolve(runDirectory), resolve(outputDirectory))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`M8 analysis failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
