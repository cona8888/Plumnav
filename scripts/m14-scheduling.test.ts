import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { m14Jobs, runM14Job } from './m14-sniff-turn-diagnostic'

describe('M14 matched-budget measurement schedule', () => {
  it.skipIf(process.env.M14_REFERENCE_SMOKE !== '1')('exactly replays a frozen M13 nonzero-bearing control', async () => {
    const jobs = await m14Jobs()
    const job = jobs.find((j) => j.world === 'open-downwind-0' && j.poseId === 'source' &&
      j.armId === 'geometry-active' && j.policy === 'fixed')!
    const previous = JSON.parse(await readFile('research/evidence/m13_flow_confirmation_2026-09-06/open-downwind-0-source-geometry-active.json', 'utf8'))
    const result = runM14Job(job)
    expect(result.records).toHaveLength(12)
    if (!('scans' in result)) throw new Error('Unavailable reference')
    for (let i = 0; i < 12; i++) {
      expect(result.scans![i]!.quad.readings).toEqual(previous.scans[i].quad.readings)
      expect(result.records[i]!.frozenM13).toEqual(previous.scans[i].flowEvidence)
    }
  }, 30000)
  it('freezes 40 jobs with no target-truth argument in the measurement rule', async () => {
    const jobs = await m14Jobs()
    expect(jobs).toHaveLength(40)
    expect(new Set(jobs.map((j) => j.id)).size).toBe(40)
    expect(jobs.every((j) => j.config.durationSeconds === 40)).toBe(true)
    expect(jobs.filter((j) => j.poseId === 'outside-tolerance').every((j) => j.evaluatorOffsetNormalized === 0.015)).toBe(true)
  })
  it('charges twelve fixed slots and finite turn time without moving the turn-only control', async () => {
    const jobs = await m14Jobs()
    const base = jobs.find((j) => j.world === 'open-downwind-0' && j.poseId === 'source' &&
      j.armId === 'geometry-active' && j.policy === 'sniff-turn')!
    // Coarse grid is used for this scheduling witness only, never for M14 evidence.
    const result = runM14Job({ ...base, config: { ...base.config, gridResolution: 32 } })
    expect(result.available).toBe(true)
    expect(result.records).toHaveLength(12)
    if (!('costs' in result)) throw new Error('Unavailable fixture')
    expect(result.missedSlots).toEqual([])
    expect(result.timing!.every((t) => t.issuedAt === t.deadline && t.settledSeconds >= 0.5)).toBe(true)
    expect(result.costs!.turnRadians).toBeCloseTo(11 * Math.PI / 4, 8)
    expect(result.costs!.turningSeconds).toBeCloseTo(5.5, 8)
    expect(result.costs!.pathLengthNormalized).toBe(0)
    expect(result.costs!.activeCycles).toBe(12)
  }, 20000)
})
