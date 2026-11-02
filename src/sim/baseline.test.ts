import { describe, expect, it } from 'vitest'
import { baselineHit, BlankBaseline, type BaselinePolicy } from './baseline'

const policy: BaselinePolicy = { flushSeconds: 1, spacingSeconds: 2, maximumGapSeconds: 1,
  minimumSamples: 4, minimumSpan: 0.5, maximumSpan: 8, maximumDrift: 3, margin: 1 }
const reading = (time: number, value: number) => ({ time, value, valid: true, inReference: true })
function calibrate(values: number[]) {
  const model = new BlankBaseline(policy)
  values.forEach((v, i) => model.observe(reading(i, v)))
  return model.finish()
}
const blank = [100, 5, 6, 6, 5, 7, 5, 6]

describe('frozen pre-search baseline', () => {
  it('purges, spaces independent time bins, and freezes a strict threshold', () => {
    const model = new BlankBaseline(policy)
    for (const [t,v] of blank.entries()) {
      model.observe(reading(t,v))
      model.observe(reading(t,v))
    }
    const frozen = model.finish()
    expect(frozen).toMatchObject({ status: 'ready', threshold: 8, count: 4, minimum: 5, maximum: 7 })
    expect([7,8,9].map(v => baselineHit(frozen, v, true))).toEqual([false,false,true])
    expect(baselineHit(frozen, NaN, true)).toBeNull()
    expect(baselineHit(frozen, 99, false)).toBeNull()
    expect(() => model.observe(reading(20,500))).toThrow(/frozen/)
    expect(model.finish()).toBe(frozen)
  })
  it('keeps earlier decisions identical when future search readings are appended or changed', () => {
    const run = (future: number[]) => {
      const frozen = calibrate(blank)
      return [9,7,8,...future].map(v => baselineHit(frozen,v,true)).slice(0,3)
    }
    expect(run([])).toEqual([true,false,false])
    expect(run([1e9,2e9,-10])).toEqual(run([0,0,0]))
    expect(run([0,0,0])).toEqual(run([]))
  })
  it.each([
    [[5,5,5], 'insufficient-blank'],
    [blank.map(() => 5), 'flat-signal'],
    [[5,5,6,6,16,7,5,6], 'excessive-range'],
    [[5,5,6,6,7,10,10,11], 'drifting-blank'],
  ] as const)('rejects invalid reference evidence %j', (values, reason) => {
    const frozen = calibrate([...values])
    expect(frozen.reason).toBe(reason)
    expect(baselineHit(frozen, 100, true)).toBeNull()
  })
  it.each(['clipped','contaminated'] as const)('rejects an explicitly %s reference session', key => {
    const model = new BlankBaseline(policy)
    blank.forEach((v,i) => model.observe({ ...reading(i,v), [key]: i === 3 }))
    expect(model.finish().reason).toBe(key === 'clipped' ? 'clipping' : 'contamination-flag')
  })
  it('resets the purge and count on data gaps, invalid samples or leaving the reference', () => {
    for (const interrupted of [{ ...reading(4,5), valid: false }, { ...reading(4,5), inReference: false }, reading(7,5)]) {
      const model = new BlankBaseline(policy)
      blank.slice(0,4).forEach((v,i) => model.observe(reading(i,v)))
      model.observe(interrupted)
      for (let i = 1; i <= 3; i++) model.observe(reading(interrupted.time + i,5+i))
      expect(model.finish().reason).toBe('insufficient-blank')
    }
  })
})
