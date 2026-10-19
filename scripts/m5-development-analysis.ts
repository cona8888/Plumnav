/** Exploratory, development-only diagnostics for the frozen M5 screen. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyDevelopmentBenchmark } from './finalize-development-benchmark'

const ARMS = [
  'coverage',
  'surge-cast',
  'infotaxis',
  'quad-active',
  'quad-zero-strength-sham',
  'quad-passive',
] as const
type Arm = typeof ARMS[number]
type Row = Record<string, string>

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const finite = (row: Row, key: string) => {
  const value = Number(row[key])
  if (!Number.isFinite(value)) throw new Error(`Non-finite ${key} in ${row.scenario_id}/${row.method_arm}`)
  return value
}
const flag = (row: Row, key: string) => row[key] === '1'
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
const quantile = (values: readonly number[], probability: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! * (upper - index) + sorted[upper]! * (index - lower)
}
const pct = (value: number) => `${(100 * value).toFixed(1)}%`
const fixed = (value: number, digits = 3) => value.toFixed(digits)

const parseCsv = (text: string) => {
  const lines = text.trimEnd().split(/\r?\n/)
  const header = lines[0]!.split(',')
  return lines.slice(1).map((line, rowIndex) => {
    const values = line.split(',')
    if (values.length !== header.length) {
      throw new Error(`CSV row ${rowIndex + 2} has ${values.length} fields; expected ${header.length}`)
    }
    return Object.fromEntries(header.map((key, index) => [key, values[index] ?? '']))
  })
}

const summarize = (rows: readonly Row[]) => {
  const correct = rows.filter((row) => row.terminal_outcome === 'correct-declaration').length
  const wrong = rows.filter((row) => row.terminal_outcome === 'wrong-declaration').length
  const abstentions = rows.filter((row) => flag(row, 'native_abstention')).length
  const proximity = rows.filter((row) => flag(row, 'proximity_success')).length
  const values = (key: string) => rows.map((row) => finite(row, key))
  return {
    runs: rows.length,
    proximity: proximity / rows.length,
    correctDeclarations: correct,
    correctDeclarationRate: correct / rows.length,
    wrongDeclarations: wrong,
    wrongDeclarationRate: wrong / rows.length,
    declarations: correct + wrong,
    abstentions,
    deadlineNondeclarations: rows.length - correct - wrong - abstentions,
    normalizedErrorMean: mean(values('normalized_error')),
    normalizedErrorMedian: quantile(values('normalized_error'), 0.5),
    normalizedErrorQ1: quantile(values('normalized_error'), 0.25),
    normalizedErrorQ3: quantile(values('normalized_error'), 0.75),
    pathNormalizedMean: mean(values('path_normalized')),
    passiveContactEpisodesMean: mean(values('passive_contact_episodes')),
    plumeTimeSecondsMean: mean(values('plume_time_s')),
    activeReturnSamplesMean: mean(values('active_return_samples')),
    quadActiveCyclesMean: mean(values('quad_sniff_cycles')),
    quadPassiveCyclesMean: mean(values('quad_passive_cycles')),
    activeSamplingSecondsMean: mean(values('active_sampling_s')),
    passiveSamplingSecondsMean: mean(values('quad_passive_sampling_s')),
    quadSuctionEnergyMean: mean(values('quad_suction_energy_proxy')),
    quadDirectionalContrastMean: mean(values('mean_quad_directional_contrast')),
    quadValidDirectionsMean: mean(values('quad_valid_directions')),
    quadDirectionAbstentionsMean: mean(values('quad_direction_abstentions')),
  }
}

const pairDiagnostics = (rows: readonly Row[], firstArm: Arm, secondArm: Arm) => {
  const byCell = new Map<string, Map<string, Row>>()
  for (const row of rows) {
    const group = byCell.get(row.scenario_id) ?? new Map<string, Row>()
    group.set(row.method_arm, row)
    byCell.set(row.scenario_id, group)
  }
  const pairs = [...byCell.values()].map((group) => {
    const first = group.get(firstArm)
    const second = group.get(secondArm)
    if (!first || !second) throw new Error(`Incomplete ${firstArm}/${secondArm} pair`)
    return [first, second] as const
  })
  const absDiff = (key: string) => pairs.map(([first, second]) =>
    Math.abs(finite(first, key) - finite(second, key)))
  const firstProximity = pairs.map(([first]) => flag(first, 'proximity_success'))
  const secondProximity = pairs.map(([, second]) => flag(second, 'proximity_success'))
  return {
    firstArm,
    secondArm,
    pairs: pairs.length,
    identicalTerminalOutcomes: pairs.filter(([first, second]) =>
      first.terminal_outcome === second.terminal_outcome).length,
    identicalProximityClassifications: pairs.filter((_, index) =>
      firstProximity[index] === secondProximity[index]).length,
    firstOnlyProximity: pairs.filter((_, index) => firstProximity[index] && !secondProximity[index]).length,
    secondOnlyProximity: pairs.filter((_, index) => !firstProximity[index] && secondProximity[index]).length,
    meanAbsoluteNormalizedErrorDifference: mean(absDiff('normalized_error')),
    maximumAbsoluteNormalizedErrorDifference: Math.max(...absDiff('normalized_error')),
    meanAbsolutePathDifference: mean(absDiff('path_normalized')),
    maximumAbsolutePathDifference: Math.max(...absDiff('path_normalized')),
  }
}

const table = (summaries: Array<{ label: string; summary: ReturnType<typeof summarize> }>) => [
  '| Arm | n | Proximity | Correct declaration | Wrong declaration | Mean error | Median error | Mean path |',
  '|---|---:|---:|---:|---:|---:|---:|---:|',
  ...summaries.map(({ label, summary }) =>
    `| ${label} | ${summary.runs} | ${pct(summary.proximity)} | ${pct(summary.correctDeclarationRate)} | ${pct(summary.wrongDeclarationRate)} | ${fixed(summary.normalizedErrorMean)} | ${fixed(summary.normalizedErrorMedian)} | ${fixed(summary.pathNormalizedMean)} |`),
].join('\n')

export const analyzeM5Development = async (runDirectory: string, outputDirectory: string) => {
  const verification = await verifyDevelopmentBenchmark(runDirectory)
  const rawText = await readFile(join(runDirectory, 'raw-results.csv'), 'utf8')
  const rows = parseCsv(rawText)
  if (rows.length !== 768) throw new Error(`Expected 768 rows, found ${rows.length}`)
  const cells = new Set(rows.map((row) => row.scenario_id))
  if (cells.size !== 128) throw new Error(`Expected 128 cells, found ${cells.size}`)
  for (const cell of cells) {
    const arms = rows.filter((row) => row.scenario_id === cell).map((row) => row.method_arm)
    if (JSON.stringify(arms) !== JSON.stringify(ARMS)) {
      throw new Error(`${cell}: arm order or completeness mismatch`)
    }
  }

  const overall = Object.fromEntries(ARMS.map((arm) => [
    arm,
    summarize(rows.filter((row) => row.method_arm === arm)),
  ])) as Record<Arm, ReturnType<typeof summarize>>
  const byScenario = Object.fromEntries(['open', 'obstructed'].map((scenario) => [
    scenario,
    Object.fromEntries(ARMS.map((arm) => [
      arm,
      summarize(rows.filter((row) => row.scenario === scenario && row.method_arm === arm)),
    ])),
  ])) as Record<string, Record<Arm, ReturnType<typeof summarize>>>
  const byScenarioOrientation = Object.fromEntries(
    ['open', 'obstructed'].flatMap((scenario) =>
      ['downwind', 'crosswind-left', 'upwind', 'crosswind-right'].map((orientation) => {
        const key = `${scenario}|${orientation}`
        return [key, Object.fromEntries(ARMS.map((arm) => [
          arm,
          summarize(rows.filter((row) =>
            row.scenario === scenario && row.orientation_bin === orientation && row.method_arm === arm)),
        ]))]
      })),
  ) as Record<string, Record<Arm, ReturnType<typeof summarize>>>
  const activeVsPassive = pairDiagnostics(rows, 'quad-active', 'quad-passive')
  const activeVsSham = pairDiagnostics(rows, 'quad-active', 'quad-zero-strength-sham')

  const findings = [
    'All 128 source-present worlds and all six arms passed provenance, cell-digest, row-matrix, and artifact-inventory checks.',
    `Quad-Active made 0 correct or wrong terminal declarations; its proximity rate was ${pct(overall['quad-active'].proximity)} overall (${pct(byScenario.open['quad-active'].proximity)} open; ${pct(byScenario.obstructed['quad-active'].proximity)} obstructed).`,
    `Quad-Passive matched ${activeVsPassive.identicalProximityClassifications}/${activeVsPassive.pairs} Quad-Active proximity classifications; the discordances were balanced (${activeVsPassive.firstOnlyProximity} active-only and ${activeVsPassive.secondOnlyProximity} passive-only), and the mean absolute normalized-error difference was ${fixed(activeVsPassive.meanAbsoluteNormalizedErrorDifference, 5)}.`,
    `Quad-Active exceeded the zero-strength sham in proximity on ${activeVsSham.firstOnlyProximity} paired worlds versus ${activeVsSham.secondOnlyProximity} in the opposite direction, showing that captured signal changes navigation, but this screen does not isolate an advantage over the genuine passive array.`,
    `Infotaxis produced the most correct declarations (${overall.infotaxis.correctDeclarations}/${overall.infotaxis.runs}) but also ${overall.infotaxis.wrongDeclarations} wrong declarations; this is a sensitivity-specificity trade-off, not evidence of general superiority.`,
    'The repaired Quad terminal evidence gate is still non-operational in this screen: neither active, passive, nor sham Quad declared. Declaration calibration must be redesigned before validation or AWS scaling.',
  ]
  const claimBoundary =
    'Exploratory development-only evidence. No validation, test, superiority, novelty, methane, landfill, buried-pipe, urban, field, or deployment claim.'
  const analysis = {
    schemaVersion: 'm5-development-diagnostic-v1',
    generatedAtUtc: new Date().toISOString(),
    verification,
    design: { independentPairedWorlds: 128, armsPerWorld: 6, storedRows: 768 },
    qualityGates: [
      '128/128 cell artifacts verified',
      '768/768 expected result rows present',
      'six-arm paired matrix complete and ordered in every world',
      '264-entry copied archive inventory verified',
    ],
    overall,
    byScenario,
    byScenarioOrientation,
    pairedDiagnostics: { activeVsPassive, activeVsSham },
    findings,
    claimBoundary,
  }
  const analysisJson = `${JSON.stringify(analysis, null, 2)}\n`
  const markdown = `# M5 development-screen diagnostic report

## Status and scope

The M5 screen completed 128 independent paired source-present worlds and 768 arm runs. All frozen provenance and artifact-integrity gates passed. These are exploratory development results only.

${table(ARMS.map((arm) => ({ label: arm, summary: overall[arm] })))}

## Open terrain

${table(ARMS.map((arm) => ({ label: arm, summary: byScenario.open[arm] })))}

## Obstructed terrain

${table(ARMS.map((arm) => ({ label: arm, summary: byScenario.obstructed[arm] })))}

## What M5 teaches us

${findings.map((finding) => `- ${finding}`).join('\n')}

## Decision

Do not open validation/test worlds and do not scale this controller to AWS yet. M6 should calibrate a truth-blind Quad declaration rule on new development worlds, diagnose why active and passive navigation coincide, and include source-absent trials to estimate false-alarm/correct-rejection behaviour. Freeze that repaired controller before any validation campaign.

**Claim boundary:** ${claimBoundary}

## Provenance

- Manifest SHA-256: \`${verification.manifestSha256}\`
- Scientific-results SHA-256: \`${verification.scientificResultsSha256}\`
- Inventory SHA-256: \`${verification.coreArtifactInventorySha256}\`
- Diagnostic JSON SHA-256: \`${sha256(analysisJson)}\`
`
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(join(outputDirectory, 'm5-diagnostic-analysis.json'), analysisJson, 'utf8')
  await writeFile(join(outputDirectory, 'm5-diagnostic-report.md'), markdown, 'utf8')
  return {
    status: 'complete',
    outputDirectory,
    analysisSha256: sha256(analysisJson),
    reportSha256: sha256(markdown),
    findings,
  }
}

const sourcePath = fileURLToPath(import.meta.url)
const scriptIndex = process.argv.findIndex((argument) => resolve(argument) === sourcePath)
if (scriptIndex >= 0) {
  const runDirectory = process.argv[scriptIndex + 1]
  const outputDirectory = process.argv[scriptIndex + 2]
  if (!runDirectory || !outputDirectory) {
    throw new Error('Usage: m5-development-analysis.ts <verified-run-directory> <output-directory>')
  }
  analyzeM5Development(resolve(runDirectory), resolve(outputDirectory))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`M5 analysis failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
