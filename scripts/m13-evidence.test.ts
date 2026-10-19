import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const archive = 'research/evidence/m13_flow_confirmation_2026-09-06'
const read = async (path: string) => JSON.parse(await readFile(join(archive, path), 'utf8'))
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
describe('completed M13 development diagnostic archive', () => {
  it('preserves all evidence and source snapshots', async () => {
    const checksums = await read('checksums.json'); const design = await read('design.json')
    expect(checksums.complete).toBe(true)
    expect(checksums.inventory).toHaveLength(30)
    expect(design.sourceInventory).toHaveLength(56)
    for (const [prefix, entries] of [['', checksums.inventory], ['source-snapshot/', design.sourceInventory]] as const) {
      for (const entry of entries) {
        const bytes = await readFile(join(archive, `${prefix}${entry.path}`))
        expect(hash(bytes), entry.path).toBe(entry.sha256)
        expect(bytes.length, entry.path).toBe(entry.bytes)
      }
    }
  })
  it('keeps unavailable poses distinct and reproduces the fixed final-six scan vote', async () => {
    const summary = await read('summary.json')
    expect(summary.complete).toBe(true)
    expect(summary.summaries).toHaveLength(28)
    expect(summary.summaries.filter((s: any) => s.available)).toHaveLength(24)
    let scans = 0
    for (const row of summary.summaries) {
      const result = await read(`${row.id}.json`)
      const last = result.scans.slice(-6)
      const positives = last.filter((s: any) => s.flowEvidence.positive).length
      expect(row.finalWindowPositiveScans).toBe(positives)
      expect(row.casePositive).toBe(last.length === 6 && positives >= 4)
      expect(result.scans.length).toBe(row.available ? 12 : 0)
      scans += result.scans.length
    }
    expect(scans).toBe(288)
    const activeSources = summary.summaries.filter((s: any) => s.armId === 'geometry-active' && s.poseId === 'source')
    expect(activeSources.filter((s: any) => s.casePositive)).toHaveLength(1)
    expect(summary.summaries.filter((s: any) => s.poseId !== 'source' && s.casePositive)).toHaveLength(0)
  })
})
