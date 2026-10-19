import { describe, expect, it } from 'vitest'
import type { DirectionCalibration } from './lib/m21-direction'
import type { TimedView } from './lib/m22-recovery'
import { makeM24Sensor, m24Scan } from './lib/m24-time-aware'
import { M21_NUISANCES } from './lib/m21-direction-study'
import { runM30 } from './lib/m30-move-resense'
import { m37RapidFreshViews } from './lib/m37-rapid-fixed-quad'
import { executeM38ActionFrom } from './lib/m38-feasibility-first-executor'
import { m40ContactDecision } from './lib/m40-contact-controller'
import { m40LatentCycle } from './lib/m40-sampling-audit'
import type { Measurement } from '../src/sim/types'

const calibration: DirectionCalibration = { slopes: [1, 1, 1, 1], offsets: [0, 0, 0, 0],
  rawVariance: 0.0004, correctedVariance: 0.0004 }
const history = (values: number[], fraction = 1): TimedView[] => Array.from({ length: 8 }, (_, i) => ({
  time: 13.5 + i * 0.5, heading: 0, values: [...values], intakeFraction: fraction,
}))
const decide = (views: TimedView[]) => m40ContactDecision(views, calibration, 17, 0.05)

describe('M40 evidence and action semantics', () => {
  it('searches after valid readings below detection without producing a location', () => {
    const result = decide(history([0, 0, 0, 0]))
    expect(result.state).toBe('no-local-contact')
    expect(result.evidence).toBe('below-detection')
    expect(result.nextStep).toBe('search')
    expect(result.direction).toBeNull()
    expect(result.action.plannedDistance).toBe(0.01)
  })
  it('repositions for uniform positive gas without inventing a gradient', () => {
    const result = decide(history([0.5, 0.5, 0.5, 0.5]))
    expect(result.state).toBe('contact-unresolved')
    expect(result.evidence).toBe('gas-detected')
    expect(result.nextStep).toBe('reposition-and-resniff')
    expect(result.direction).toBeNull()
    expect(result.action.direction.y).toBeCloseTo(1)
  })
  it('follows a consistent directional signal', () => {
    const result = decide(history([0.8, 0.5, 0.2, 0.5]))
    expect(result.state).toBe('directional-contact')
    expect(result.direction!.x).toBeCloseTo(1)
    expect(result.direction!.y).toBeCloseTo(0)
    expect(result.nextStep).toBe('follow')
  })
  it('accounts for known dilution when interpreting local contact', () => {
    expect(decide(history([0.04, 0.04, 0.04, 0.04])).state).toBe('no-local-contact')
    expect(decide(history([0.04, 0.04, 0.04, 0.04], 0.25)).evidence).toBe('gas-detected')
  })
  it('holds to resniff an isolated positive reading', () => {
    const views = history([0, 0, 0, 0]); views[7]!.values[0] = 0.2
    const result = decide(views)
    expect(result.evidence).toBe('uncertain')
    expect(result.state).toBe('contact-unresolved')
    expect(result.action.plannedDistance).toBe(0)
  })
  it('recognizes saturation as gas contact without inferring direction', () => {
    const result = decide(history([1.5, 1.5, 1.5, 1.5]))
    expect(result.evidence).toBe('gas-detected')
    expect(result.direction).toBeNull()
  })
  it.each(['stale', 'nan-heading', 'irregular-time', 'bad-fraction', 'missing-channel'])(
    'never claims absence from %s readings', (problem) => {
      const views = history([0, 0, 0, 0])
      if (problem === 'stale') views.forEach((view) => { view.time -= 5 })
      if (problem === 'nan-heading') views[3]!.heading = NaN
      if (problem === 'irregular-time') views[3]!.time += 0.1
      if (problem === 'bad-fraction') views[3]!.intakeFraction = 0
      if (problem === 'missing-channel') views[3]!.values.pop()
      const result = decide(views)
      expect(result.state).toBeNull()
      expect(result.evidence).toBe('invalid')
      expect(result.action.plannedDistance).toBe(0)
    })
  it('does not interpret an unsupported slow sensor or invalid calibration as absence', () => {
    expect(m40ContactDecision(history([0, 0, 0, 0]), calibration, 17, 2).state).toBeNull()
    expect(m40ContactDecision(history([0, 0, 0, 0]), { ...calibration, slopes: [0, 1, 1, 1] }, 17, 0.05).state).toBeNull()
  })
})

describe('M40 sampling and execution integration', () => {
  it('matches the actual M24 pre-sensor time-integrated acquisition at several headings/intakes', () => {
    const field = (p: { x: number; y: number }, time: number) => Math.max(0,
      0.5 + 4 * Math.cos(time) * (p.x - 0.5) + 4 * Math.sin(time) * (p.y - 0.5))
    const origin = { x: 0.7, y: 0.2 }
    for (const fraction of [1, 0.5, 0.25]) for (const heading of [0, 0.7, Math.PI]) {
      const sensor = makeM24Sensor(M21_NUISANCES[0]!, 1)
      sensor.senseQuadConcentration = (event) => ({ quadSniff: { readings:
        event.latentChannels.map((channel) => ({ concentration: channel.latentConcentration })) } }) as Measurement
      const actual = m24Scan(sensor, field, 13, heading, origin, fraction)
      const reference = m40LatentCycle(field, origin, heading, 13.5).map((value) => value * fraction)
      actual.forEach((value, i) => expect(value).toBeCloseTo(reference[i]!, 12))
    }
  })
  it('does not confuse endpoint gradient strength with the mixed suction signal', () => {
    const values = m40LatentCycle((p) => 0.5 + 4 * (p.x - 0.5), { x: 0.5, y: 0.5 }, 0, 0.5)
    const difference = values[0]! - values[2]!
    expect(difference).toBeGreaterThan(0)
    expect(difference).toBeLessThan(2 * 4 * 0.0975)
  })
  it('executes a stationary reacquisition for stale data without the zero-vector fallback moving the robot', () => {
    const run = runM30({ nuisances: 1, dynamics: 1, angles: 1, trials: 1, calibrationReplicates: 1, maps: 1 },
      { freshAcquisition: m37RapidFreshViews, freshDecision: m40ContactDecision,
        actionExecutor: executeM38ActionFrom, honorNonDirectionalActions: true,
        resenseDecisionTime: 17, secondActionEndTime: 18 })
    const stale = run.aggregates.find((row) => row.arm === 'stale-replay-sham')!
    expect(stale.distance).toBe(0)
    expect(stale.accepted).toBe(0)
    expect(stale.collisions).toBe(0)
    expect(run.aggregates.find((row) => row.arm === 'fresh-resense')!.distance).toBeGreaterThan(0)
  })
})
