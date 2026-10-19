import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SimulationEngine } from '../src/sim/engine'
import { evaluateMultiView } from './lib/multiview-source-evidence'

const root = 'research/evidence/m14_concentration_noise_followup_2026-09-06'
const primary = 'research/evidence/m14_sniff_turn_bearing_corrected_2026-09-06'
const read = async (path: string) => JSON.parse(await readFile(join(root, path), 'utf8'))
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
it('preserves the two post-hoc controls and all frozen source snapshots', async () => {
  const design = await read('design.json'); const inventory = await read('checksums.json')
  expect(inventory.complete).toBe(true)
  expect(inventory.inventory).toHaveLength(4)
  expect(design.sourceInventory).toHaveLength(60)
  expect(design.primaryDecisionChanged).toBe(false)
  expect(design.selectedAfterPrimaryOutcomes).toBe(true)
  for (const [prefix, entries] of [['', inventory.inventory], ['source-snapshot/', design.sourceInventory]] as const) {
    for (const e of entries) {
      const bytes = await readFile(join(root, `${prefix}${e.path}`))
      expect(hash(bytes), e.path).toBe(e.sha256)
      expect(bytes.length, e.path).toBe(e.bytes)
    }
  }
})
it('replays all control scores with only concentration noise changed and identical measured winds', async () => {
  const design = await read('design.json')
  for (const job of design.jobs) {
    const originalId = job.id.replace(/-zero-concentration-noise$/, '')
    const prior = JSON.parse(await readFile(join(primary, `${originalId}.json`), 'utf8'))
    const r = await read(`${job.id}.json`)
    expect(job).toEqual({ ...prior.job, id: job.id, config: { ...prior.job.config, sensorNoise: 0 } })
    expect(r.costs).toEqual(prior.costs)
    expect(r.timing).toEqual(prior.timing)
    expect(r.missedSlots).toEqual([])
    expect(r.records).toHaveLength(12)
    const engine = new SimulationEngine(job.config)
    for (const [i, record] of r.records.entries()) {
      expect(record.wind).toEqual(prior.records[i].wind)
      expect(record.sensorNoise).toBe(0)
      expect(evaluateMultiView({ ...record, isBlocked: engine.environment.isBlocked })).toEqual(record.evidence)
    }
    const positive = r.records.slice(-6).filter((v: any) => v.evidence.positive).length
    expect(r.summary.finalPositiveScans).toBe(positive)
    expect(r.summary.casePositive).toBe(positive >= 4)
  }
})
