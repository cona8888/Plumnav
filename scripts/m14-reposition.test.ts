import { expect, it } from 'vitest'
import { m14Jobs, runM14Job } from './m14-sniff-turn-diagnostic'

it('executes the fallback with real robot travel inside the fixed scan budget', async () => {
  const jobs = await m14Jobs()
  const base = jobs.find((j) => j.world === 'open-downwind-0' && j.poseId === 'source' &&
    j.armId === 'geometry-active' && j.policy === 'sniff-turn')!
  if (base.plan.mode === 'fixed') throw new Error('Expected a sniff-turn plan')
  // Explicit kinematic witness on an open map, not one of the scientific jobs.
  const result = runM14Job({ ...base, config: { ...base.config, gridResolution: 32 },
    plan: { ...base.plan, mode: 'turn-and-reposition', secondPosition: { x: base.anchor.x + 0.025, y: base.anchor.y } } })
  if (!('costs' in result)) throw new Error('Unavailable scheduling fixture')
  expect(result.missedSlots).toEqual([])
  expect(result.records).toHaveLength(12)
  expect(result.costs!.pathLengthNormalized).toBeCloseTo(11 * 0.025, 6)
  expect(result.costs!.collisionAttempts).toBe(0)
  expect(result.costs!.turningSeconds).toBeCloseTo(5.5, 8)
  expect(result.timing!.every((t) => t.issuedAt === t.deadline && t.settledSeconds >= 0.5)).toBe(true)
}, 20000)
