import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { m18Plans, m18Rows, screenM18 } from './lib/m18-geometry-feasibility'

const root = 'research/evidence/m18_geometry_feasibility_2026-09-08'
const read = async (p: string) => JSON.parse(await readFile(join(root, p), 'utf8'))
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
it('verifies the complete M18 archive and every inherited source without outcome data', async () => {
  const design = await read('design.json'); const inventory = await read('checksums.json')
  expect(inventory.complete).toBe(true); expect(inventory.inventory).toHaveLength(146)
  expect(design.sourceInventory).toHaveLength(78); expect(design.plans).toEqual(m18Plans())
  for (const [prefix, entries] of [['', inventory.inventory], ['source-snapshot/', design.sourceInventory]] as const) {
    for (const e of entries) {
      const b = await readFile(join(root, `${prefix}${e.path}`))
      expect(hash(b), e.path).toBe(e.sha256); expect(b.length).toBe(e.bytes)
      if (prefix) expect(hash(await readFile(e.path)), e.path).toBe(e.sha256)
    }
  }
})
it('independently replays all 432 epochs and recomputes the complete qualification decision', async () => {
  const summary = await read('summary.json')
  expect(summary.complete).toBe(true); expect(summary.plans).toBe(144); expect(summary.epochs).toBe(432); expect(summary.plumeTrajectories).toBe(0)
  let count = 0; let qualified = 0
  for (const plan of m18Plans()) {
    const data = await read(`${plan.id}.json`); const result = screenM18(plan)
    expect(JSON.stringify(result)).toBe(JSON.stringify(data.result))
    expect(JSON.stringify(result.epochs.map((e) => m18Rows(plan, e.block)))).toBe(JSON.stringify(data.geometry))
    expect(result.feasible).toBe(result.budget.budgetValid && result.epochs.every((e) => Object.values(e.gates).every(Boolean)))
    for (const rows of data.geometry) {
      expect(rows.trainingTimes.every((t: number) => t <= rows.cutoff)).toBe(true)
      expect(rows.testTimes.every((t: number) => t > rows.cutoff)).toBe(true)
      for (const row of [...rows.training, ...rows.testing]) expect(Object.keys(row).sort()).toEqual(['sigma', 'x'])
    }
    count += result.epochs.length; qualified += Number(result.feasible)
  }
  expect(count).toBe(432)
  const folder = 'research/analysis/m18_geometry_feasibility_2026-09-08'
  const checksums = JSON.parse(await readFile(join(folder, 'analysis-checksums.json'), 'utf8'))
  for (const e of checksums) {
    const b = await readFile(join(folder, e.path)); expect(hash(b)).toBe(e.sha256); expect(b.length).toBe(e.bytes)
  }
  const analysis = JSON.parse(await readFile(join(folder, 'm18-analysis.json'), 'utf8'))
  expect(analysis.qualifiedPlans).toBe(qualified); expect(analysis.anyEligibleForManufacturedDiagnostic).toBe(qualified > 0)
  expect(analysis.advancesToPhysicalPlumeBenchmark).toBe(false)
  for (const [gate, failures] of Object.entries(analysis.failureEpochCounts)) {
    expect(failures).toBe(analysis.results.flatMap((r: any) => r.epochs).filter((e: any) => !e.gates[gate]).length)
  }
})
