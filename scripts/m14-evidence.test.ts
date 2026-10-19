import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const root = 'research/evidence/m14_sniff_turn_bearing_corrected_2026-09-06'
const read = async (path: string) => JSON.parse(await readFile(join(root, path), 'utf8'))
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
it('verifies the complete corrected M14 artifact/source archive', async () => {
  const design = await read('design.json'); const inventory = await read('checksums.json')
  expect(design.schemaVersion).toBe('m14-sniff-turn-diagnostic-v2-bearing-aligned')
  expect(inventory.complete).toBe(true)
  expect(inventory.inventory).toHaveLength(42)
  expect(design.sourceInventory).toHaveLength(59)
  for (const [prefix, entries] of [['', inventory.inventory], ['source-snapshot/', design.sourceInventory]] as const) {
    for (const e of entries) {
      const b = await readFile(join(root, `${prefix}${e.path}`))
      expect(hash(b), e.path).toBe(e.sha256)
      expect(b.length, e.path).toBe(e.bytes)
    }
  }
})
it('recomputes all case votes and checks nonzero-heading timing/cost records', async () => {
  const summary = await read('summary.json')
  expect(summary.complete).toBe(true)
  expect(summary.summaries).toHaveLength(40)
  for (const row of summary.summaries) {
    const result = await read(`${row.id}.json`)
    expect(result.records).toHaveLength(12)
    expect(result.missedSlots).toEqual([])
    expect(result.costs.collisionAttempts).toBe(0)
    // Frozen raw activeCycles is the engine's inclusive four-channel counter.
    expect(result.costs.activeCycles).toBe(12)
    expect(result.costs.passiveCycles).toBe(row.armId === 'geometry-passive' ? 12 : 0)
    expect(result.costs.activeSamplingSeconds).toBe(row.armId === 'geometry-active' ? 9 : 0)
    expect(result.costs.passiveSamplingSeconds).toBe(row.armId === 'geometry-passive' ? 9 : 0)
    const positives = result.records.slice(-6).filter((r: any) => r.evidence.positive).length
    expect(row.finalPositiveScans).toBe(positives)
    expect(row.casePositive).toBe(positives >= 4)
    const initialBearing = (result.job.config.robotStartHeadingDegrees ?? 0) * Math.PI / 180
    for (const [i, event] of result.timing.entries()) {
      expect(event.issuedAt).toBe(10 + i * 2.5)
      expect(event.settledSeconds).toBeGreaterThanOrEqual(0.5)
      expect(event.bearing).toBeCloseTo(initialBearing + (row.policy === 'sniff-turn' && i % 2 ? Math.PI / 4 : 0), 10)
    }
    expect(result.costs.turningSeconds).toBeCloseTo(row.policy === 'sniff-turn' ? 5.5 : 0, 10)
  }
})
