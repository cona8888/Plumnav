/** Post-outcome mechanism audit: did frozen M65 runs reach/finish confirmation? */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createDefaultConfig } from '../src/sim/config'
import { SimulationEngine } from '../src/sim/engine'
import type { ScenarioKind } from '../src/sim/types'

const scenarios: ScenarioKind[] = ['open', 'obstructed']
const contract = JSON.parse(await readFile(
  'research/protocols/m60_soil_regimes/soil-regime-contract.json', 'utf8',
)) as { cases: Array<{ case_id: string; emission_scale_relative_to_sand_sw_0p2: number }> }
const soils = contract.cases.filter(row =>
  row.case_id === 'sand-sw-0p2' || row.case_id === 'sand-sw-0p5')
const rows: Array<Record<string, unknown>> = []
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
    let confirmationSteps = 0
    let failedReacquisitionSteps = 0
    let confirmationEntries = 0
    let priorConfirmation = false
    while (!engine.isCompleted()) {
      const frame = engine.step()
      const confirmation = frame.decision.phase.includes('CANDIDATE CONFIRMATION')
      if (confirmation) confirmationSteps += 1
      if (confirmation && !priorConfirmation) confirmationEntries += 1
      if (frame.decision.phase === 'FAILED-CANDIDATE REACQUISITION') failedReacquisitionSteps += 1
      priorConfirmation = confirmation
    }
    rows.push({ soil: soil.case_id, scenario, replicate, confirmationEntries,
      confirmationSteps, failedReacquisitionSteps })
  }
  block += 1
}
const groups = soils.flatMap(soil => scenarios.map(scenario => {
  const group = rows.filter(row => row.soil === soil.case_id && row.scenario === scenario)
  return {
    soil: soil.case_id, scenario, runs: group.length,
    enteredConfirmation: group.filter(row => Number(row.confirmationEntries) > 0).length,
    showedFailedReacquisition: group.filter(row => Number(row.failedReacquisitionSteps) > 0).length,
    medianConfirmationSteps: group.map(row => Number(row.confirmationSteps))
      .sort((a, b) => a - b)[Math.floor(group.length / 2)],
  }
}))
await writeFile(resolve(
  'research/evidence/m65_spatial_bracket_development_2026-09-12/phase-diagnostic.json',
), `${JSON.stringify({ purpose: 'post-outcome mechanism audit; not advancement evidence', groups }, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(groups)}\n`)
