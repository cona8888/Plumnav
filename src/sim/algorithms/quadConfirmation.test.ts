import { describe, expect, it } from 'vitest'
import { SimulationEngine } from '../engine'
import { createDefaultConfig } from '../config'
import { QuadSoilSniffController } from './quadSoilSniff'
import type { AlgorithmStepInput, QuadSniffChannelReading, Vec2 } from '../types'

const candidate = { x: 0.4, y: 0.4 }
const setup = (scheduling: 'frozen' | 'priority-dwell') => {
  const engine = new SimulationEngine(createDefaultConfig('quad-sniff', 'open'))
  const controller = new QuadSoilSniffController('active-suction', 'geometry-conditioned', scheduling)
  controller.reset({ ...engine.environment, activeSniffEnabled: false })
  // Synthetic known state isolates scheduling, not source inference accuracy.
  Object.assign(controller, {
    everPassiveHit: true, lastPassiveHitTime: 10, pendingScanId: 1,
    gradientRays: [
      { time: 9, origin: candidate, direction: { x: 1, y: 0 }, weight: 0.9 },
      { time: 9, origin: { x: 0.35, y: 0.4 }, direction: { x: 1, y: 0 }, weight: 0.7 },
      { time: 9, origin: { x: 0.4, y: 0.35 }, direction: { x: 0, y: 1 }, weight: 0.7 },
    ],
    rayEstimate: { point: candidate, residual: 0.005, geometryQuality: 0.8,
      forwardFraction: 1, poseSpan: 0.1, quality: 0.8, rayCount: 3 },
  })
  return controller
}
const passive = (time: number, position = candidate): AlgorithmStepInput => ({
  time, dt: 0.25, position, heading: 0, distance: 0.1, observations: [],
  measurement: { time, concentration: 0.5, hit: true, valid: true, sampleMode: 'passive', wind: { x: 0.1, y: 0 } },
})
const scanReturn = (): AlgorithmStepInput => {
  const readings: QuadSniffChannelReading[] = (['front', 'left', 'aft', 'right'] as const).map((channel, i) => {
    const a = -i * Math.PI / 2
    const direction = { x: Math.cos(a), y: Math.sin(a) }
    return { channel, direction, reach: 0.06, support: 1, effectiveOffset: { x: direction.x * 0.04, y: direction.y * 0.04 },
      concentration: [0.65, 0.45, 0.25, 0.45][i]!, hit: true, saturated: false,
      integrationSamples: 4, effectiveIntegrationSamples: 4 }
  })
  return { ...passive(10), measurement: { ...passive(10).measurement, sampleMode: 'quad-return',
    quadSniff: { scanId: 1, phase: 'return', forward: { x: 1, y: 0 }, strength: 0.78,
      samplingMode: 'active-suction', progress: 1, channels: [], readings } } }
}

describe('M12 confirmation scheduling regression', () => {
  it('preserves the M10 burst but makes M12 dwell after the identical valid return', () => {
    const oldDecision = setup('frozen').step(scanReturn())
    const newDecision = setup('priority-dwell').step(scanReturn())
    expect(oldDecision.phase).toBe('QUADRATURE GRADIENT ADVANCE')
    expect(newDecision.phase).toBe('CANDIDATE CONFIRMATION DWELL')
    expect(newDecision.direction).toEqual({ x: 0, y: 0 })
    expect(newDecision.speedScale).toBe(0)
    expect(newDecision.nativeTerminated).not.toBe(true)
  })

  it('advances the waypoint after an uninterrupted dwell despite a live gradient burst', () => {
    const controller = setup('priority-dwell')
    controller.step(scanReturn())
    expect(controller.step(passive(11.25)).phase).toBe('CANDIDATE CONFIRMATION DWELL')
    expect(controller.step(passive(11.5)).phase).toBe('CANDIDATE CONFIRMATION APPROACH')
    expect((controller as unknown as { confirmationIndex: number }).confirmationIndex).toBe(1)
  })

  it('can finish all nine waypoints and reject unsupported confirmation without declaring', () => {
    const controller = setup('priority-dwell')
    controller.step(scanReturn())
    const state = controller as unknown as {
      confirmationIndex: number; confirmationWaypoints: Vec2[]; confirmationCompletedAt: number | null;
      lastFailedConfirmationAt: number; gradientRays: unknown[];
    }
    let time = 10
    for (let i = 0; i < 9; i++) {
      const target = state.confirmationWaypoints[i]!
      controller.step(passive(time, target))
      time += 1.5
      const decision = controller.step(passive(time, target))
      expect(decision.nativeTerminated).not.toBe(true)
      time += 0.25
    }
    expect(state.confirmationCompletedAt).not.toBeNull()
    const after = controller.step(passive(time))
    expect(after.nativeTerminated).not.toBe(true)
    expect(state.gradientRays).toHaveLength(1)
    expect(state.lastFailedConfirmationAt).toBe(time)
    expect(state.confirmationCompletedAt).toBeNull()
  })
})
