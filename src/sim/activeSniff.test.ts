import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config'
import {
  activeSniffKernel,
  activeSniffPhaseAt,
  createActiveSniffEvent,
} from './activeSniff'
import type { PlumeModel } from './plume'
import { createScenario } from './scenarios'

const gradientPlume = (): PlumeModel => {
  const config = createDefaultConfig('pulse-sniff', 'open')
  const scenario = createScenario('open', 12, config)
  return {
    scenario,
    seed: 12,
    windAt: () => ({ x: -0.05, y: 0 }),
    transportAt: () => ({ x: -0.05, y: 0 }),
    puffsAt: () => [],
    concentrationAt: (point) => point.x,
    expectedHitRate: () => 0.1,
  }
}

describe('active sniff observation proxy', () => {
  it('forms a normalized forward footprint and clips it at obstacles', () => {
    const samples = activeSniffKernel(
      { x: 0.5, y: 0.5 },
      { x: 1, y: 0 },
      0.1,
      (point) => point.x > 0.56,
    )
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.every((sample) => sample.point.x <= 0.56)).toBe(true)
    expect(samples.reduce((sum, sample) => sum + sample.weight, 0)).toBeCloseTo(1, 12)
    expect(samples.reduce((sum, sample) => sum + sample.nominalWeight, 0)).toBeLessThan(1)
  })

  it('returns a larger scalar when the pulse points up a known gradient', () => {
    const plume = gradientPlume()
    const common = {
      origin: { x: 0.5, y: 0.5 },
      time: 3,
      strengthScale: 1,
      reach: 0.1,
      cycleSeconds: 0.75,
      plume,
      isBlocked: () => false,
    }
    const east = createActiveSniffEvent({
      ...common,
      command: { probeId: 1, direction: { x: 1, y: 0 } },
    })
    const west = createActiveSniffEvent({
      ...common,
      command: { probeId: 2, direction: { x: -1, y: 0 } },
    })
    expect(east?.latentReturn).toBeGreaterThan(0.5)
    expect(west?.latentReturn).toBeLessThan(0.5)
    expect(east?.latentReturn).toBeGreaterThan(west?.latentReturn ?? 1)
  })

  it('falls back to the local reading when every forward path is blocked', () => {
    const event = createActiveSniffEvent({
      command: { probeId: 8, direction: { x: 1, y: 0 } },
      origin: { x: 0.5, y: 0.5 },
      time: 0,
      strengthScale: 1,
      reach: 0.1,
      cycleSeconds: 0.75,
      plume: gradientPlume(),
      isBlocked: (point) => point.x > 0.501,
    })
    expect(event?.latentReturn).toBeCloseTo(0.5, 12)
  })

  it('provides no remote directional information at zero pulse strength', () => {
    const event = createActiveSniffEvent({
      command: { probeId: 9, direction: { x: 1, y: 0 } },
      origin: { x: 0.5, y: 0.5 },
      time: 0,
      strengthScale: 0,
      reach: 0.1,
      cycleSeconds: 0.75,
      plume: gradientPlume(),
      isBlocked: () => false,
    })
    expect(event?.latentReturn).toBeCloseTo(0.5, 12)
  })

  it('uses an explicit exhale, settle and delayed return sequence', () => {
    const event = createActiveSniffEvent({
      command: { probeId: 3, direction: { x: 1, y: 0 } },
      origin: { x: 0.5, y: 0.5 },
      time: 10,
      strengthScale: 0.8,
      reach: 0.05,
      cycleSeconds: 0.75,
      plume: gradientPlume(),
      isBlocked: () => false,
    })
    expect(event).not.toBeNull()
    expect(activeSniffPhaseAt(event!, 10.2)).toBe('exhale')
    expect(activeSniffPhaseAt(event!, 10.5)).toBe('settle')
    expect(activeSniffPhaseAt(event!, 10.75)).toBe('return')
  })
})
