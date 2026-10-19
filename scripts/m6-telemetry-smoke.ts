/** Short grid-physics smoke for M6 telemetry and truth-condition contracts. */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { batchResultsToCsv, runBatch } from '../src/sim/batch'
import type { BatchResult, SimulationConfig } from '../src/sim/types'
import { M6_ARMS, createM6CalibrationManifest } from './m6-calibration-manifest'

const selectSmokeCells = () => {
  const manifest = createM6CalibrationManifest()
  const baseKeys = [
    manifest.cells.find((cell) => cell.scenarioKind === 'open')!.counterfactualPairingKey,
    manifest.cells.find((cell) => cell.scenarioKind === 'obstructed')!.counterfactualPairingKey,
  ]
  return manifest.cells.filter((cell) => baseKeys.includes(cell.counterfactualPairingKey))
}

export const runM6TelemetrySmoke = async (outputDirectory: string) => {
  const results: Array<BatchResult & { m6Arm: string; m6Condition: string; m6Cell: string }> = []
  for (const cell of selectSmokeCells()) {
    for (const arm of M6_ARMS) {
      const config: SimulationConfig = {
        ...cell.config,
        ...arm.configOverrides,
        algorithmId: arm.algorithmId,
        durationSeconds: 45,
        checkpointSeconds: [45],
        gridResolution: 64,
        physicsStepSeconds: 0.025,
      }
      const batch = await runBatch(config, [arm.algorithmId], [cell.scenarioKind], 1)
      const result = batch.results[0]
      if (!result) throw new Error(`${cell.id}/${arm.id}: no smoke result`)
      results.push({ ...result, m6Arm: arm.id, m6Condition: cell.condition, m6Cell: cell.id })
    }
  }
  if (results.length !== 16) throw new Error(`Expected 16 smoke runs, found ${results.length}`)

  const quad = results.filter((result) => result.m6Arm !== 'infotaxis')
  const passive = results.filter((result) => result.m6Arm === 'quad-passive')
  const sham = results.filter((result) => result.m6Arm === 'quad-zero-strength-sham')
  const active = results.filter((result) => result.m6Arm === 'quad-active')
  const absent = results.filter((result) => result.m6Condition === 'absent')
  if (quad.some((result) => result.metrics.quadDeclarationEvaluations < 1)) {
    throw new Error('Every Quad smoke run must record at least one declaration-evidence evaluation')
  }
  if (passive.some((result) =>
    result.metrics.activeSamplingSeconds !== 0 ||
    result.metrics.quadSuctionEnergy !== 0 ||
    result.metrics.quadPassiveSamplingSeconds <= 0
  )) throw new Error('Passive-array resource accounting contract failed')
  if (sham.some((result) => result.metrics.quadSuctionEnergy !== 0)) {
    throw new Error('Zero-strength sham incurred suction energy')
  }
  if (active.some((result) => result.metrics.quadSuctionEnergy <= 0)) {
    throw new Error('Active arm did not incur suction energy')
  }
  if (absent.some((result) =>
    result.metrics.normalizedError !== null ||
    result.scenarioKind !== result.config.scenarioKind ||
    result.config.sourcePositionOverride !== undefined
  )) throw new Error('Absent-source output leaked source geometry or localization error')

  const rendered = results.map((result) => {
    const csv = batchResultsToCsv([result]).trimEnd().split(/\r?\n/)
    return { header: csv[0]!, row: csv[1]! }
  })
  if (new Set(rendered.map((item) => item.header)).size !== 1) {
    throw new Error('Smoke rows do not share one CSV schema')
  }
  const csv = `m6_cell,m6_condition,m6_arm,${rendered[0]!.header}\n${results
    .map((result, index) =>
      `${result.m6Cell},${result.m6Condition},${result.m6Arm},${rendered[index]!.row}`)
    .join('\n')}\n`
  if (!csv.includes('quad_declaration_best_failed_gates')) {
    throw new Error('M6 declaration evidence columns are missing')
  }
  await mkdir(outputDirectory, { recursive: true })
  const outputPath = resolve(outputDirectory, 'm6-telemetry-smoke.csv')
  const temporary = `${outputPath}.${process.pid}.tmp`
  await writeFile(temporary, csv, 'utf8')
  await rename(temporary, outputPath)
  return {
    status: 'pass',
    outputPath,
    runs: results.length,
    quadRuns: quad.length,
    emittingRuns: results.length - absent.length,
    absentRuns: absent.length,
    activeSuctionEnergy: active.reduce((sum, result) => sum + result.metrics.quadSuctionEnergy, 0),
    passiveSamplingSeconds: passive.reduce(
      (sum, result) => sum + result.metrics.quadPassiveSamplingSeconds,
      0,
    ),
  }
}

const outputDirectory = process.argv.at(-1)
if (!outputDirectory || outputDirectory.endsWith('m6-telemetry-smoke.ts')) {
  throw new Error('Usage: m6-telemetry-smoke.ts <output-directory>')
}
runM6TelemetrySmoke(resolve(outputDirectory))
  .then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`))
  .catch((error) => {
    process.stderr.write(`M6 telemetry smoke failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
