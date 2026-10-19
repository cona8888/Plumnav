import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { analyzeCalibration, simulateCalibration } from './lib/m15-measurement-calibration'

const root = 'research/evidence/m15_measurement_calibration_2026-09-06'
const read = async (p: string) => JSON.parse(await readFile(join(root, p), 'utf8'))
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
it('verifies the complete M15 evidence and unchanged frozen source inventory', async () => {
  const design = await read('design.json'); const inventory = await read('checksums.json')
  expect(inventory.complete).toBe(true)
  expect(inventory.inventory).toHaveLength(1442)
  expect(design.sourceInventory).toHaveLength(64)
  for (const [prefix, entries] of [['', inventory.inventory], ['source-snapshot/', design.sourceInventory]] as const) {
    for (const e of entries) {
      const bytes = await readFile(join(root, `${prefix}${e.path}`))
      expect(hash(bytes), e.path).toBe(e.sha256)
      expect(bytes.length, e.path).toBe(e.bytes)
      if (prefix) expect(hash(await readFile(e.path)), e.path).toBe(e.sha256)
    }
  }
})
it('regenerates the predefined forward subset and replays its complete window analyses', async () => {
  const design = await read('design.json'); const summary = await read('summary.json')
  expect(summary.complete).toBe(true)
  expect(summary.trajectories).toBe(1440)
  expect(summary.windowAnalyses).toBe(2880)
  expect(summary.scoreRecords).toBe(34560)
  expect(design.verificationSubset).toHaveLength(12)
  for (const id of design.verificationSubset) {
    const r = await read(`${id}.json`)
    // JSON intentionally canonicalizes IEEE -0 to 0; compare archive bytes,
    // not a stricter in-memory distinction that the archive cannot preserve.
    expect(JSON.stringify(simulateCalibration(r.observations.job))).toBe(JSON.stringify(r.observations))
    expect(JSON.stringify(analyzeCalibration(r.observations))).toBe(JSON.stringify(r.analyses))
  }
  const analysisRoot = 'research/analysis/m15_measurement_calibration_2026-09-06'
  const inventory = JSON.parse(await readFile(join(analysisRoot, 'analysis-checksums.json'), 'utf8'))
  for (const e of inventory) expect(hash(await readFile(join(analysisRoot, e.path)))).toBe(e.sha256)
})
