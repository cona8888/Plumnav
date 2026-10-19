import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config'
import { dot, magnitude, normalize } from './math'
import type { PlumeModel } from './plume'
import {
  createQuadSniffEvent,
  integrateQuadSniffEvent,
  pairedQuadSniffGradient,
  QUAD_PASSIVE_ARRAY_RADIUS,
  QUAD_SNIFF_CHANNEL_ORDER,
  quadSniffEffectiveSampleCount,
  quadSniffChannelDirections,
  quadSniffFrameAt,
  quadSniffPhaseAt,
  quadSniffStatusAt,
  type QuadSniffEvent,
} from './quadSniff'
import { createScenario } from './scenarios'
import type { QuadSniffChannelReading, Vec2 } from './types'

const ORIGIN = { x: 0.5, y: 0.5 }

const plumeFor = (
  concentrationAt: (point: Vec2, time: number) => number,
): PlumeModel => {
  const config = createDefaultConfig('pulse-sniff', 'open')
  const scenario = createScenario('open', 17, config)
  return {
    scenario,
    seed: 17,
    windAt: () => ({ x: 0, y: 0 }),
    transportAt: () => ({ x: 0, y: 0 }),
    puffsAt: () => [],
    concentrationAt,
    expectedHitRate: () => 0.1,
  }
}

const createEvent = ({
  plume = plumeFor(() => 0.4),
  forward = { x: 1, y: 0 },
  strengthScale = 1,
  reachForDirection = () => 0.1,
  isBlocked = () => false,
  time = 6.25,
  cycleSeconds = 1.2,
  samplingMode = 'active-suction',
}: {
  plume?: PlumeModel
  forward?: Vec2
  strengthScale?: number
  reachForDirection?: Parameters<typeof createQuadSniffEvent>[0]['reachForDirection']
  isBlocked?: (point: Vec2, clearance?: number) => boolean
  time?: number
  cycleSeconds?: number
  samplingMode?: Parameters<typeof createQuadSniffEvent>[0]['samplingMode']
} = {}) => createQuadSniffEvent({
  command: { scanId: 12, forward },
  origin: ORIGIN,
  time,
  strengthScale,
  samplingMode,
  cycleSeconds,
  reachForDirection,
  plume,
  isBlocked,
})

const readingsFrom = (event: QuadSniffEvent): QuadSniffChannelReading[] =>
  event.latentChannels.map((channel) => ({
    channel: channel.channel,
    direction: { ...channel.direction },
    reach: channel.reach,
    support: channel.support,
    effectiveOffset: { ...channel.effectiveOffset },
    concentration: channel.latentConcentration,
    hit: channel.latentConcentration >= 0.1,
    integrationSamples: channel.integrationSamples,
    effectiveIntegrationSamples: quadSniffEffectiveSampleCount(event),
  }))

describe('simultaneous four-channel passive array primitive', () => {
  it('samples four physical heads without suction or remote entrainment', () => {
    const event = createEvent({
      samplingMode: 'passive-array',
      strengthScale: 1,
      plume: plumeFor((point) => point.x + 2 * point.y),
    })!

    expect(event.samplingMode).toBe('passive-array')
    expect(event.strength).toBe(0)
    expect(event.latentChannels.every(
      (channel) => channel.reach === QUAD_PASSIVE_ARRAY_RADIUS,
    )).toBe(true)
    expect(event.latentChannels.every((channel) => channel.kernel.length === 0)).toBe(true)
    expect(new Set(event.latentChannels.map(
      (channel) => channel.latentConcentration,
    )).size).toBe(4)
  })

  it('marks an obstructed passive head unsupported instead of inventing a cue', () => {
    const event = createEvent({
      samplingMode: 'passive-array',
      plume: plumeFor((point) => point.x),
      isBlocked: (point) => point.x > ORIGIN.x + 0.001,
    })!
    const front = event.latentChannels.find((channel) => channel.channel === 'front')!
    const aft = event.latentChannels.find((channel) => channel.channel === 'aft')!
    expect(front.support).toBe(0)
    expect(front.effectiveOffset).toEqual({ x: 0, y: 0 })
    expect(aft.support).toBe(1)
    expect(aft.effectiveOffset.x).toBeCloseTo(-QUAD_PASSIVE_ARRAY_RADIUS, 12)
  })
})

describe('simultaneous four-channel active suction primitive', () => {
  it('builds deterministic orthogonal body-frame geometry with caller-supplied reaches', () => {
    const reachByChannel = {
      front: 0.11,
      left: 0.09,
      aft: 0.07,
      right: 0.05,
    } as const
    const plume = plumeFor((point) => 0.2 + point.x * 0.3 + point.y * 0.1)
    const first = createEvent({
      plume,
      reachForDirection: (_direction, channel) => reachByChannel[channel],
    })
    const second = createEvent({
      plume,
      reachForDirection: (_direction, channel) => reachByChannel[channel],
    })
    expect(first).not.toBeNull()
    expect(second).toEqual(first)
    expect(first!.latentChannels.map((channel) => channel.channel)).toEqual(
      QUAD_SNIFF_CHANNEL_ORDER,
    )
    expect(first!.latentChannels.map((channel) => channel.reach)).toEqual([
      0.11,
      0.09,
      0.07,
      0.05,
    ])
    expect(new Set(
      first!.latentChannels.map((channel) => channel.latentConcentration),
    ).size).toBe(4)

    const [front, left, aft, right] = first!.latentChannels.map(
      (channel) => channel.direction,
    )
    expect(magnitude(front!)).toBeCloseTo(1, 12)
    expect(dot(front!, left!)).toBeCloseTo(0, 12)
    expect(dot(front!, aft!)).toBeCloseTo(-1, 12)
    expect(dot(left!, right!)).toBeCloseTo(-1, 12)
  })

  it('queries every inlet footprint at one common simulation time', () => {
    const sampledTimes: number[] = []
    const event = createEvent({
      time: 8.75,
      plume: plumeFor((point, time) => {
        sampledTimes.push(time)
        return point.x
      }),
    })
    expect(event).not.toBeNull()
    expect(sampledTimes.length).toBeGreaterThan(4)
    expect(new Set(sampledTimes)).toEqual(new Set([8.75]))
  })

  it('time-averages synchronized samples over an aspiration cycle', () => {
    const sampledTimes: number[] = []
    const temporalPlume = plumeFor((_point, time) => {
      sampledTimes.push(time)
      return time
    })
    const event = createEvent({
      time: 0,
      cycleSeconds: 0.6,
      strengthScale: 0,
      plume: temporalPlume,
    })!
    integrateQuadSniffEvent(event, 0.25, temporalPlume)
    integrateQuadSniffEvent(event, 0.5, temporalPlume)
    integrateQuadSniffEvent(event, 1, temporalPlume)
    integrateQuadSniffEvent(event, 2, temporalPlume)

    expect(event.latentChannels.every((channel) => channel.integrationSamples === 4)).toBe(true)
    expect(event.latentChannels[0]!.latentConcentration).toBeCloseTo(0.3, 12)
    expect(event.lastIntegratedAt).toBeCloseTo(0.6, 12)
    expect(quadSniffEffectiveSampleCount(event)).toBeGreaterThan(3)
    expect(quadSniffEffectiveSampleCount(event)).toBeLessThan(4)
    expect(new Set(sampledTimes)).toEqual(new Set([0, 0.25, 0.5, 0.6]))
  })

  it('has exactly zero paired gradient in a uniform field', () => {
    const event = createEvent({ plume: plumeFor(() => 0.42) })
    expect(event).not.toBeNull()
    const gradient = pairedQuadSniffGradient(readingsFrom(event!))
    expect(gradient.complete).toBe(true)
    expect(gradient.meanConcentration).toBeCloseTo(0.42, 12)
    expect(gradient.vector).toEqual({ x: 0, y: 0 })
    expect(gradient.direction).toEqual({ x: 0, y: 0 })
    expect(gradient.quality).toBe(0)
  })

  it('recovers the increasing direction of a linear concentration field', () => {
    const event = createEvent({
      plume: plumeFor((point) => 0.2 + point.x),
      forward: { x: 1, y: 0 },
    })
    expect(event).not.toBeNull()
    const gradient = pairedQuadSniffGradient(readingsFrom(event!))
    expect(gradient.complete).toBe(true)
    expect(gradient.vector.x).toBeGreaterThan(0)
    expect(gradient.direction.x).toBeCloseTo(1, 10)
    expect(gradient.direction.y).toBeCloseTo(0, 10)
  })

  it('rotates the inferred gradient with the four-channel array', () => {
    const axis = normalize({ x: 0.62, y: -0.37 })
    const event = createEvent({
      forward: axis,
      plume: plumeFor((point) =>
        0.7 + (point.x - ORIGIN.x) * axis.x + (point.y - ORIGIN.y) * axis.y),
    })
    expect(event).not.toBeNull()
    const gradient = pairedQuadSniffGradient(readingsFrom(event!))
    expect(dot(gradient.direction, axis)).toBeGreaterThan(0.999999)

    const directions = quadSniffChannelDirections(axis)
    expect(directions.map((item) => item.direction)).toEqual(
      event!.latentChannels.map((item) => item.direction),
    )
  })

  it('clips blocked directional footprints and falls back to the local value', () => {
    const event = createEvent({
      plume: plumeFor((point) => point.x),
      isBlocked: (point) => point.x > ORIGIN.x + 0.001,
    })
    expect(event).not.toBeNull()
    const front = event!.latentChannels.find((channel) => channel.channel === 'front')
    const aft = event!.latentChannels.find((channel) => channel.channel === 'aft')
    expect(front?.support).toBe(0)
    expect(front?.latentConcentration).toBeCloseTo(ORIGIN.x, 12)
    expect(aft?.support).toBe(1)
    expect(aft?.latentConcentration).toBeLessThan(ORIGIN.x)
  })

  it('uses retained kernel weight and centroid for partial occlusion', () => {
    const event = createEvent({
      plume: plumeFor((point) => point.x),
      isBlocked: (point) => point.x > ORIGIN.x + 0.05,
    })
    const front = event!.latentChannels.find((channel) => channel.channel === 'front')
    expect(front?.support).toBeCloseTo(0.22, 12)
    expect(front?.effectiveOffset.x).toBeCloseTo(0.038, 12)
    expect(front?.effectiveOffset.y).toBeCloseTo(0, 12)
    expect(front?.latentConcentration).toBeGreaterThan(ORIGIN.x)
    expect(front?.latentConcentration).toBeLessThan(ORIGIN.x + 0.038)
  })

  it('keeps latent channel values out of public status and frame projections', () => {
    const event = createEvent({ plume: plumeFor((point) => point.x + point.y) })
    expect(event).not.toBeNull()
    const status = quadSniffStatusAt(event!, 6.5)
    const frame = quadSniffFrameAt(event!, 7.45)
    expect(quadSniffPhaseAt(event!, 6.5)).toBe('aspirate')
    expect(frame.phase).toBe('return')
    expect(JSON.stringify(status)).not.toMatch(/latent|kernel|accumulated/i)
    expect(JSON.stringify(frame)).not.toMatch(/latent|kernel|accumulated/i)
    expect(Object.keys(frame.channels[0] ?? {}).sort()).toEqual([
      'channel',
      'direction',
      'effectiveOffset',
      'reach',
      'support',
    ])
    expect(frame.readings).toBeUndefined()
  })

  it('implements a timing-matched zero-strength sham with equal local returns', () => {
    let concentrationQueries = 0
    const event = createEvent({
      strengthScale: 0,
      plume: plumeFor((point) => {
        concentrationQueries += 1
        return point.x
      }),
    })
    expect(event).not.toBeNull()
    expect(event!.strength).toBe(0)
    expect(event!.cycleSeconds).toBe(1.2)
    expect(event!.latentChannels.every(
      (channel) => channel.latentConcentration === ORIGIN.x,
    )).toBe(true)
    expect(concentrationQueries).toBe(1)
    expect(quadSniffPhaseAt(event!, event!.startedAt + 1.19)).toBe('aspirate')
    expect(quadSniffPhaseAt(event!, event!.startedAt + 1.2)).toBe('return')
  })
})
