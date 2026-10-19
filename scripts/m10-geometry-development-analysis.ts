/** Deterministic decision analysis for the frozen M10 geometry-conditioned development. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  QUAD_CANDIDATE_FORMATION_GATE_NAMES,
  QUAD_DECLARATION_GATE_NAMES,
} from '../src/sim/algorithms/quadSoilSniff'
import { verifyM10Results } from './m10-verify-results'

const ARMS = [
  'geometry-active',
  'adaptive-active',
  'geometry-passive',
  'geometry-zero-strength-sham',
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
    if (values.length !== header.length) throw new Error(`Malformed M10 CSV row ${index + 2}`)
    return Object.fromEntries(header.map((key, position) => [key, values[position] ?? '']))
  })
}
const formationGateColumn = (gate: string) =>
  `quad_candidate_gate_passes_${gate.replaceAll('-', '_')}`
const declarationGateColumn = (gate: string) =>
  `quad_declaration_gate_passes_${gate.replaceAll('-', '_')}`
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

const declarationDiagnostics = (rows: readonly Row[]) => ({
  rows: rows.length,
  evaluations: rows.reduce((sum, row) => sum + number(row, 'quad_declaration_evaluations'), 0),
  maximumGatesPassed: Math.max(...rows.map((row) => number(row, 'quad_declaration_max_gates_passed'))),
  maximumScore: Math.max(...rows.map((row) => number(row, 'quad_declaration_max_score'))),
  gates: Object.fromEntries(QUAD_DECLARATION_GATE_NAMES.map((gate) => [gate, {
    passes: rows.reduce((sum, row) => sum + number(row, declarationGateColumn(gate)), 0),
    rowsWithAnyPass: rows.filter((row) => number(row, declarationGateColumn(gate)) > 0).length,
  }])),
})

const binomialProbability = (successes: number, trials: number) => {
  let coefficient = 1
  for (let index = 1; index <= successes; index += 1) {
    coefficient *= (trials - index + 1) / index
  }
  return coefficient * 0.5 ** trials
}
export const exactM10McNemarP = (firstOnly: number, secondOnly: number) => {
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
  let geometryOnly = 0
  let adaptiveOnly = 0
  for (const [cell, group] of byCell) {
    const geometry = group.get('geometry-active')
    const adaptive = group.get('adaptive-active')
    if (!geometry || !adaptive) throw new Error(`${cell}: incomplete geometry/adaptive pair`)
    const geometryValue = trustedCandidate(geometry)
    const adaptiveValue = trustedCandidate(adaptive)
    if (geometryValue && adaptiveValue) both += 1
    else if (geometryValue) geometryOnly += 1
    else if (adaptiveValue) adaptiveOnly += 1
    else neither += 1
  }
  return {
    pairs: byCell.size,
    both,
    neither,
    geometryOnly,
    adaptiveOnly,
    geometryOnlyMinusAdaptiveOnly: geometryOnly - adaptiveOnly,
    pairedRiskDifference: (geometryOnly - adaptiveOnly) / byCell.size,
    exactMcNemarP: exactM10McNemarP(geometryOnly, adaptiveOnly),
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

const confirmationProgressed = (row: Row) => trustedCandidate(row) &&
  number(row, 'quad_declaration_gate_passes_candidate') > 0 &&
  number(row, 'quad_declaration_gate_passes_surface_count') > 0 &&
  number(row, 'quad_declaration_gate_passes_passive_core_count') > 0 &&
  number(row, 'quad_declaration_gate_passes_passive_ring_count') > 0

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
    confirmationProgressed: confirmationProgressed(row),
    terminalOutcome: row.terminal_outcome,
  }))
  .sort((first, second) => first.cellId.localeCompare(second.cellId) || first.arm.localeCompare(second.arm))

const pct = (value: number) => `${(value * 100).toFixed(2)}%`
const fixed = (value: number | null, digits = 4) => value === null ? 'n/a' : value.toFixed(digits)

export const analyzeM10GeometryDevelopment = async (runDirectory: string, outputDirectory: string) => {
  const volatileVerification = await verifyM10Results(runDirectory)
  const { verifiedAtUtc: _time, directory: _directory, ...verification } = volatileVerification
  const raw = await readFile(join(runDirectory, 'raw-results.csv'), 'utf8')
  const rows = parseCsv(raw)
  const manifest = JSON.parse(await readFile(join(runDirectory, 'manifest.json'), 'utf8')) as {
    unchangedDeclarationPolicy?: boolean
    frozenRevision?: { version?: string }
    frozenComparator?: { version?: string }
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
  const declarationByConditionArm = Object.fromEntries(CONDITIONS.flatMap((condition) =>
    ARMS.map((arm) => [`${condition}|${arm}`, declarationDiagnostics(rows.filter((row) =>
      row.condition === condition && row.method_arm === arm))])))

  const geometryPresent = diagnostics['emitting|geometry-active']!
  const adaptivePresent = diagnostics['emitting|adaptive-active']!
  const geometryObstructed = byScenario['emitting|geometry-active|obstructed']!
  const paired = pairedTrustedCandidates(rows)
  const geometryAbsentRows = rows.filter((row) =>
    row.condition === 'absent' && row.method_arm === 'geometry-active')
  const geometryPresentRows = rows.filter((row) =>
    row.condition === 'emitting' && row.method_arm === 'geometry-active')
  const geometryAbsentSpurious = geometryAbsentRows.filter(spuriousDeclaration).length
  const geometryConfirmationProgressions = geometryPresentRows.filter(confirmationProgressed).length
  const geometryCorrectDeclarations = geometryPresentRows.filter((row) =>
    row.terminal_outcome === 'correct-declaration' && row.native_declaration === '1').length
  const geometryWrongDeclarations = geometryPresentRows.filter((row) =>
    row.terminal_outcome === 'wrong-declaration').length
  const declarationPolicyUnchanged = manifest.unchangedDeclarationPolicy === true &&
    manifest.frozenRevision?.version === 'quad-geometry-conditioned-v1' &&
    manifest.frozenComparator?.version === 'quad-adaptive-viewpoint-v1'
  const criteria = [
    {
      id: 'C1-geometry-candidate-reach',
      requirement: 'geometry-active trusted candidates >= 6/32 emitting worlds',
      observed: geometryPresent.trustedCandidateWorlds,
      threshold: 6,
      passed: geometryPresent.trustedCandidateWorlds >= 6,
    },
    {
      id: 'C2-paired-improvement',
      requirement: 'geometry-only minus adaptive-only >= 6 and two-sided exact McNemar p <= 0.05',
      observed: {
        geometryOnly: paired.geometryOnly,
        adaptiveOnly: paired.adaptiveOnly,
        difference: paired.geometryOnlyMinusAdaptiveOnly,
        exactMcNemarP: paired.exactMcNemarP,
      },
      threshold: { minimumDifference: 6, maximumP: 0.05 },
      passed: paired.geometryOnlyMinusAdaptiveOnly >= 6 && paired.exactMcNemarP <= 0.05,
    },
    {
      id: 'C3-obstructed-candidate-reach',
      requirement: 'geometry-active trusted candidates >= 3/16 obstructed emitting worlds',
      observed: geometryObstructed.trustedCandidateWorlds,
      threshold: 3,
      passed: geometryObstructed.trustedCandidateWorlds >= 3,
    },
    {
      id: 'C4-ray-conditioning-mechanism',
      requirement: 'geometry-active retains >=3 rays in >=10/32 emitting worlds and passes ray quality in >=6/32 emitting worlds',
      observed: {
        worldsWithThreeRays: geometryPresent.rowsWithAtLeastThreeRays,
        worldsPassingRayQuality: geometryPresent.gates['ray-quality']!.rowsWithAnyPass,
      },
      threshold: { minimumThreeRayWorlds: 10, minimumQualityWorlds: 6 },
      passed: geometryPresent.rowsWithAtLeastThreeRays >= 10 &&
        geometryPresent.gates['ray-quality']!.rowsWithAnyPass >= 6,
    },
    {
      id: 'C5-passive-confirmation-progression',
      requirement: 'geometry-active passes candidate, surface-count, passive-core-count and passive-ring-count evidence gates in >= 2/32 emitting worlds',
      observed: geometryConfirmationProgressions,
      threshold: 2,
      passed: geometryConfirmationProgressions >= 2,
    },
    {
      id: 'C6-correct-native-declaration',
      requirement: 'geometry-active produces >= 1 correct native declaration and zero wrong declarations in 32 emitting worlds',
      observed: { correctNativeDeclarations: geometryCorrectDeclarations, wrongDeclarations: geometryWrongDeclarations },
      threshold: { minimumCorrect: 1, maximumWrong: 0 },
      passed: geometryCorrectDeclarations >= 1 && geometryWrongDeclarations === 0,
    },
    {
      id: 'C7-source-absent-safety',
      requirement: 'zero geometry-active spurious declarations in 32 absent worlds',
      observed: geometryAbsentSpurious,
      threshold: 0,
      passed: geometryAbsentSpurious === 0,
    },
    {
      id: 'C8-no-downstream-retuning',
      requirement: 'no downstream declaration threshold changed after outcomes were viewed',
      observed: declarationPolicyUnchanged,
      threshold: true,
      passed: declarationPolicyUnchanged,
    },
  ]
  const failedCriteria = criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.id)
  const proceed = failedCriteria.length === 0
  const candidates = candidateDetails(rows)
  const geometryCandidateErrors = geometryPresent.trustedCandidateErrorNormalized
  const allAbsentSpurious = rows.filter((row) => row.condition === 'absent' && spuriousDeclaration(row)).length
  const reachResult = criteria[0]!.passed ? 'passed' : 'failed'
  const pairedResult = criteria[1]!.passed ? 'passed' : 'failed'
  const geometryDeclaration = declarationByConditionArm['emitting|geometry-active']!
  const geometryQualityGate = geometryPresent.gates['ray-quality']!
  const adaptiveQualityGate = adaptivePresent.gates['ray-quality']!
  const findings = [
    `Geometry-active formed trusted candidates in ${geometryPresent.trustedCandidateWorlds}/32 emitting worlds versus ${adaptivePresent.trustedCandidateWorlds}/32 for adaptive-active. The paired table was geometry-only ${paired.geometryOnly}, adaptive-only ${paired.adaptiveOnly}, both ${paired.both}, neither ${paired.neither}; the risk difference was ${pct(paired.pairedRiskDifference)} and two-sided exact McNemar p=${paired.exactMcNemarP.toFixed(4)}.`,
    `The primary reach criterion ${reachResult} (${geometryPresent.trustedCandidateWorlds} observed; 6 required), and the paired improvement criterion ${pairedResult} (${paired.geometryOnlyMinusAdaptiveOnly} geometry-only excess; 6 required).`,
    `In open emitting worlds, geometry-active retained at least one, two and three rays in ${byScenario['emitting|geometry-active|open']!.rowsWithAtLeastOneRay}/16, ${byScenario['emitting|geometry-active|open']!.rowsWithAtLeastTwoRays}/16 and ${byScenario['emitting|geometry-active|open']!.rowsWithAtLeastThreeRays}/16 worlds. In obstructed emitting worlds the corresponding counts were ${geometryObstructed.rowsWithAtLeastOneRay}/16, ${geometryObstructed.rowsWithAtLeastTwoRays}/16 and ${geometryObstructed.rowsWithAtLeastThreeRays}/16, with ${geometryObstructed.trustedCandidateWorlds} trusted candidate${geometryObstructed.trustedCandidateWorlds === 1 ? '' : 's'}.`,
    `Geometry-active reached at least three retained rays in ${geometryPresent.rowsWithAtLeastThreeRays}/32 worlds versus ${adaptivePresent.rowsWithAtLeastThreeRays}/32 for adaptive-active, but its ray-quality gate passed only ${geometryQualityGate.passes}/${geometryQualityGate.denominator} provisional evaluations versus ${adaptiveQualityGate.passes}/${adaptiveQualityGate.denominator} for adaptive-active.`,
    `The ${geometryPresent.trustedCandidateWorlds} geometry candidates had normalized source errors from ${fixed(geometryCandidateErrors.minimum)} to ${fixed(geometryCandidateErrors.maximum)} (median ${fixed(geometryCandidateErrors.median)}); ${geometryConfirmationProgressions}/32 emitting worlds progressed through the four predeclared confirmation evidence gates.`,
    `The confirmation trajectory accumulated passive core and ring sample counts in ${geometryDeclaration.gates['passive-core-count']!.rowsWithAnyPass}/32 and ${geometryDeclaration.gates['passive-ring-count']!.rowsWithAnyPass}/32 geometry-active worlds, but surface-count, passive-core-mean and aggregate-score passed in ${geometryDeclaration.gates['surface-count']!.rowsWithAnyPass}/32, ${geometryDeclaration.gates['passive-core-mean']!.rowsWithAnyPass}/32 and ${geometryDeclaration.gates['aggregate-score']!.rowsWithAnyPass}/32.`,
    `Geometry-active produced ${geometryCorrectDeclarations}/32 correct native declarations, ${geometryWrongDeclarations}/32 wrong declarations and ${geometryAbsentSpurious}/32 absent-world spurious declarations. All four arms together produced ${allAbsentSpurious}/128 absent-world spurious declarations.`,
    'These are development-screen results under the simulator model; they do not establish nominal validation, superiority, novelty or field performance.',
  ]
  const decision = proceed
    ? 'All frozen M10 criteria passed; nominal validation design may be opened without retuning the frozen controller.'
    : `M10 failed frozen criteria ${failedCriteria.join(', ')}. Do not open nominal validation or test seeds. Return to upstream acquisition design while preserving the downstream declaration safeguards.`
  const claimBoundary = 'Untouched development-verification evidence only. No nominal validation, test, superiority, novelty, field, methane, landfill, urban, buried-pipeline, or deployment claim.'
  const analysis = {
    schemaVersion: 'm10-geometry-conditioned-development-analysis-v1',
    verification,
    design: { cells: 64, armRuns: 256, emittingWorlds: 32, absentWorlds: 32, armsPerCell: 4 },
    frozenPolicyVersion: manifest.frozenRevision?.version,
    criteria,
    failedCriteria,
    proceedToNominalValidation: proceed,
    pairedTrustedCandidates: paired,
    formationDiagnostics: diagnostics,
    declarationDiagnostics: declarationByConditionArm,
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
    `| C1 candidate reach | ${geometryPresent.trustedCandidateWorlds}/32 | >=6/32 | ${criteria[0]!.passed ? 'PASS' : 'FAIL'} |`,
    `| C2 paired improvement | ${paired.geometryOnly}-${paired.adaptiveOnly}; difference ${paired.geometryOnlyMinusAdaptiveOnly}; p=${paired.exactMcNemarP.toFixed(4)} | difference >=6 and p<=0.05 | ${criteria[1]!.passed ? 'PASS' : 'FAIL'} |`,
    `| C3 obstructed reach | ${geometryObstructed.trustedCandidateWorlds}/16 | >=3/16 | ${criteria[2]!.passed ? 'PASS' : 'FAIL'} |`,
    `| C4 ray conditioning | ${geometryPresent.rowsWithAtLeastThreeRays}/32 with three rays; ${geometryQualityGate.rowsWithAnyPass}/32 pass quality | >=10 and >=6 worlds | ${criteria[3]!.passed ? 'PASS' : 'FAIL'} |`,
    `| C5 confirmation progression | ${geometryConfirmationProgressions}/32 | >=2/32 | ${criteria[4]!.passed ? 'PASS' : 'FAIL'} |`,
    `| C6 correct native declaration | ${geometryCorrectDeclarations} correct; ${geometryWrongDeclarations} wrong | >=1 correct and 0 wrong | ${criteria[5]!.passed ? 'PASS' : 'FAIL'} |`,
    `| C7 absent safety | ${geometryAbsentSpurious}/32 spurious | 0/32 | ${criteria[6]!.passed ? 'PASS' : 'FAIL'} |`,
    `| C8 no downstream retuning | ${declarationPolicyUnchanged ? 'unchanged' : 'not verified'} | unchanged | ${criteria[7]!.passed ? 'PASS' : 'FAIL'} |`,
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
  const report = `# M10 geometry-conditioned development report

## Decision

**${proceed ? 'PROCEED — nominal validation design may be opened.' : 'HALT — nominal validation remains sealed.'}**

${decision}

${criteriaTable}

## What M10 demonstrated

${findings.map((finding) => `- ${finding}`).join('\n')}

## Acquisition reach

${reachTable}

## Trusted candidates

${candidateTable}

Candidate error is descriptive because candidate formation, not localization
accuracy, was the frozen primary endpoint. A trusted candidate is a navigation
target; final declaration safeguards remained unchanged.

## Scientific interpretation

M10 is judged only by the eight criteria frozen before execution. Candidate
errors, per-orientation patterns and ablation-arm outcomes are descriptive
diagnostics and cannot replace a failed primary gate. If any criterion fails,
nominal validation remains sealed and any further revision must be declared in
a new development protocol. Passing all criteria would permit design of a
separate untouched validation campaign, but would not itself establish
superiority or field performance.

The C5 confirmation endpoint records whether each of four gates passed at
least once during a run. The aggregate counters cannot establish simultaneous
confirmation of the same candidate. Native declaration requires all evidence
gates to hold together in the controller. Predicted ray conditioning is a
navigation heuristic: a local concentration gradient need not point toward
the source in an advecting or obstructed plume. The 32-world screen is a
development decision; repeated development p-values are not confirmatory
evidence of superiority. Zero false declarations in 32 absent worlds also
does not establish a negligible population false-alarm rate.

**Claim boundary:** ${claimBoundary}

## Provenance

- Manifest SHA-256: \`${verification.manifestSha256}\`
- Raw-results SHA-256: \`${verification.rawResultsSha256}\`
- Scientific-results SHA-256: \`${verification.scientificResultsSha256}\`
- Core-inventory SHA-256: \`${verification.coreArtifactInventorySha256}\`
- Analysis JSON SHA-256: \`${sha256(analysisJson)}\`
`
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(join(outputDirectory, 'm10-geometry-development-analysis.json'), analysisJson, 'utf8')
  await writeFile(join(outputDirectory, 'm10-geometry-development-report.md'), report, 'utf8')
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

if (process.env.M10_ANALYSIS_RUN === '1') {
  const runDirectory = process.argv[2]
  const outputDirectory = process.argv[3]
  if (!runDirectory || !outputDirectory) {
    throw new Error('Usage: m10-geometry-development-analysis.ts <verified-run-directory> <output-directory>')
  }
  analyzeM10GeometryDevelopment(resolve(runDirectory), resolve(outputDirectory))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`M10 analysis failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
