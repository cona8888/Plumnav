/** Behavior-preserving telemetry replay of the exact M65 emitting worlds. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createDefaultConfig, SIMULATOR_VERSION } from '../src/sim/config'
import { SimulationEngine } from '../src/sim/engine'
import { QUAD_BRACKET_GATE_NAMES } from '../src/sim/algorithms/quadSoilSniff'
import type { QuadBracketEvidenceStatus, ScenarioKind } from '../src/sim/types'

const output = resolve('research/evidence/m66_bracket_telemetry_replay_2026-09-12')
const scenarios: ScenarioKind[] = ['open', 'obstructed']
const contract = JSON.parse(await readFile(
  'research/protocols/m60_soil_regimes/soil-regime-contract.json', 'utf8',
)) as { cases: Array<{ case_id: string; reti?: never; emission_scale_relative_to_sand_sw_0p2: number }> }
const soils = contract.cases.filter(row =>
  row.case_id === 'sand-sw-0p2' || row.case_id === 'sand-sw-0p5')

const referenceLines = (await readFile(
  'research/evidence/m65_spatial_bracket_development_2026-09-12/results.csv', 'utf8',
)).trim().split('\n').map(line => line.split(','))
const referenceHeader = referenceLines.shift()!
const index = (name: string) => referenceHeader.indexOf(name)
const references = new Map(referenceLines
  .filter(row => row[index('algorithm')] === 'quad-sniff-bracket' && row[index('target_status')] === 'emitting')
  .map(row => [`${row[index('m65_cell')]}|${row[index('scenario')]}|${row[index('source_seed')]}`, row]))

type ReplayRow = {
  soil: string; scenario: ScenarioKind; replicate: number; sourceSeed: number
  attempted: boolean; completed: boolean; ready: boolean; best: QuadBracketEvidenceStatus | null
  bestCompleted: QuadBracketEvidenceStatus | null
  outcomeEquivalent: boolean
}
const rows: ReplayRow[] = []
let block = 0
for (const soil of soils) for (const scenario of scenarios) {
  for (let replicate = 0; replicate < 30; replicate += 1) {
    const config = createDefaultConfig('quad-sniff-bracket', scenario)
    config.seed = 65_000_000 + block * 1_000_003 + replicate * 7_919
    config.sourceSeed = 65_000_017 + block * 1_000_033 + replicate * 15_485_863
    config.controllerSeed = 65_000_029 + block * 1_000_037 + replicate * 104_729
    config.observationModelSeed = 65_000_043 + block * 1_000_081 + replicate * 1_000_003
    config.emissionRateScale = soil.emission_scale_relative_to_sand_sw_0p2
    config.checkpointSeconds = [180]
    config.stopOnNativeDeclaration = false
    const engine = new SimulationEngine(config)
    let attempted = false
    let best: QuadBracketEvidenceStatus | null = null
    let bestCompleted: QuadBracketEvidenceStatus | null = null
    let completed = false
    let ready = false
    while (!engine.isCompleted()) {
      const status = engine.step().decision.quadBracketEvidence
      if (!status) continue
      attempted = true
      if (!best || status.gatesPassed > best.gatesPassed ||
          (status.gatesPassed === best.gatesPassed && status.pairCount > best.pairCount)) best = status
      if (status.completedAt !== null) {
        completed = true
        if (!bestCompleted || status.gatesPassed > bestCompleted.gatesPassed) bestCompleted = status
      }
      if (status.ready) ready = true
    }
    const metrics = engine.getFrame().metrics
    const reference = references.get(`${soil.case_id}|${scenario}|${config.sourceSeed}`)
    const same = (column: string, value: string | number | null | undefined) =>
      Boolean(reference) && String(value ?? '') === reference![index(column)]
    const outcomeEquivalent =
      same('terminal_outcome', metrics.terminalOutcome) &&
      same('normalized_error', metrics.normalizedError) &&
      same('path_normalized', metrics.pathLengthNormalized) &&
      same('estimate_x_normalized', metrics.estimate?.x) &&
      same('estimate_y_normalized', metrics.estimate?.y) &&
      same('native_declaration', metrics.nativeDeclaration ? 1 : 0)
    rows.push({ soil: soil.case_id, scenario, replicate, sourceSeed: config.sourceSeed,
      attempted, completed, ready, best, bestCompleted, outcomeEquivalent })
  }
  block += 1
}
const groups = soils.flatMap(soil => scenarios.map(scenario => {
  const group = rows.filter(row => row.soil === soil.case_id && row.scenario === scenario)
  return {
    soil: soil.case_id, scenario, runs: group.length,
    attempted: group.filter(row => row.attempted).length,
    completed: group.filter(row => row.completed).length,
    ready: group.filter(row => row.ready).length,
    outcomeEquivalent: group.filter(row => row.outcomeEquivalent).length,
    runsPassingGate: Object.fromEntries(QUAD_BRACKET_GATE_NAMES.map(name => [
      name, group.filter(row => row.best?.gates[name]).length,
    ])),
    completedAttemptsFailingGate: Object.fromEntries(QUAD_BRACKET_GATE_NAMES.map(name => [
      name, group.filter(row => row.bestCompleted && !row.bestCompleted.gates[name]).length,
    ])),
    medianBestGatesPassed: group.map(row => row.best?.gatesPassed ?? 0)
      .sort((a, b) => a - b)[Math.floor(group.length / 2)],
  }
}))
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 'm66-bracket-telemetry-replay-v1', simulatorVersion: SIMULATOR_VERSION,
  purpose: 'behavior-preserving diagnostic replay of exact M65 emitting seeds',
  decisionThresholdsChanged: false, sourceEvidence: 'M65 accepted evidence remains immutable',
}, null, 2)}\n`)
await writeFile(resolve(output, 'run-telemetry.json'), `${JSON.stringify(rows, null, 2)}\n`)
await writeFile(resolve(output, 'summary.json'), `${JSON.stringify(groups, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(groups)}\n`)
