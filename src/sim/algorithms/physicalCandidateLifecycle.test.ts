import { describe, expect, it, vi } from 'vitest'
import { createDefaultConfig, validateSimulationConfig } from '../config'
import { SimulationEngine } from '../engine'
import { withBoundedPoseScans, withLocalInletDesign } from '../localInletSampling'
import { GSL_REFERENCE_DESIGN } from '../physicalDesign'
import type { AlgorithmStepInput, Vec2 } from '../types'
import { inspectionAttemptBudget } from './physicalCandidateLifecycle'

const center = { x: 0.5, y: 0.5 }
function fixture(duration = 300, enabled = true) {
  const config = withBoundedPoseScans(withLocalInletDesign({ ...createDefaultConfig('quad-sniff-refine', 'open'),
    durationSeconds: duration, checkpointSeconds: [duration], stopOnNativeDeclaration: true,
    sensorNoise: 0.001, windNoise: 0, robotStartPositionOverride: center }, GSL_REFERENCE_DESIGN,
  { recoveryTimeConstantSeconds: 2, maximumTurnRateRadiansPerSecond: Math.PI / 4 }))
  config.localInletSampling!.gradientEstimator = 'relative-geometry-v1'
  if (enabled) config.localInletSampling!.candidateLifecycle = 'bounded-inspection-v1'
  const engine = new SimulationEngine(config)
  // Test-only seeded navigation prior isolates confirmation from acquisition.
  // No source truth is passed by the production controller or engine.
  Object.assign(engine.controller, {
    everPassiveHit: true, lastPassiveHitTime: 0, lastScanAt: 0, nextScanAt: 1000,
    gradientRays: [
      { time: 0, origin: { x: 0.45, y: 0.5 }, direction: { x: 1, y: 0 }, weight: 1 },
      { time: 0, origin: { x: 0.5, y: 0.45 }, direction: { x: 0, y: 1 }, weight: 1 },
      { time: 0, origin: { x: 0.55, y: 0.5 }, direction: { x: -1, y: 0 }, weight: 1 }],
    rayEstimate: { point: center, residual: 0, geometryQuality: 1, forwardFraction: 1,
      poseSpan: 0.1, quality: 1, rayCount: 3 },
    estimateHistory: [-4, -2, 0].map(time => ({ time, point: center })),
  })
  const access = engine.controller as unknown as {
    inspectionPrior: { deadline: number; ray: { point: Vec2 } } | null
    inspectionOutcome: string; gradientRays: unknown[]; rayEstimate: unknown
    confirmationIndex: number; confirmationSamples: unknown[]
    beginPhysicalInspection(input: AlgorithmStepInput): unknown
    expireGradientRays(time: number): void
  }
  const input = (time: number): AlgorithmStepInput => ({ time, dt: 0.25, position: center,
    heading: 0, observations: [], distance: 0,
    measurement: { time, valid: false, concentration: 0, hit: false, sampleMode: 'passive', wind: { x: 1, y: 0 } } })
  return { engine, access, config, input }
}

describe('bounded physical candidate inspection', () => {
  it('expires raw rays without erasing the bounded navigation prior', () => {
    const { access, input } = fixture()
    access.beginPhysicalInspection(input(0))
    expect(access.inspectionPrior).not.toBeNull()
    access.expireGradientRays(76)
    expect(access.gradientRays).toHaveLength(0)
    expect(access.rayEstimate).toBeNull()
    expect(access.inspectionPrior!.ray.point).toEqual(center)
    expect(access.confirmationSamples).toHaveLength(0)
  })
  it('times out invalid measurements and clears the prior instead of renewing it', () => {
    const { engine, access, input } = fixture()
    engine.controller.step(input(0))
    const deadline = access.inspectionPrior!.deadline
    const d = engine.controller.step(input(deadline + 0.25))
    expect(access.inspectionPrior).toBeNull()
    expect(access.inspectionOutcome).toBe('timed-out')
    expect(access.gradientRays).toHaveLength(0)
    expect(d.nativeTerminated).not.toBe(true)
    expect(d.nativeAbstained).not.toBe(true)
  })
  it('refuses an attempt that does not fit, without claiming no leak', () => {
    const { engine, access, input } = fixture(120)
    const d = engine.controller.step(input(0))
    expect(d.phase).toBe('INSUFFICIENT PHYSICAL INSPECTION BUDGET')
    expect(d.nativeTerminated).not.toBe(true)
    expect(d.nativeAbstained).not.toBe(true)
    expect(access.inspectionPrior).toBeNull()
  })
  it('rejects blocked waypoints without silently skipping confirmation', () => {
    const { engine, access, input } = fixture()
    Object.assign(engine.controller, { environment: { ...engine.environment, isBlocked: () => true } })
    const d = engine.controller.step(input(0))
    expect(d.phase).toBe('PHYSICAL INSPECTION BLOCKED; REACQUIRE')
    expect(access.inspectionPrior).toBeNull()
    expect(access.gradientRays).toHaveLength(0)
  })
  it.each(['peak', 'uniform', 'blank', 'weak'] as const)('runs actual motion and channels on a seeded %s field', field => {
    const { engine, access, config } = fixture()
    vi.spyOn(engine.plume, 'concentrationAt').mockImplementation(p => {
      const r = Math.hypot(p.x - center.x, p.y - center.y) * config.domainMeters
      return field === 'blank' ? 0 : field === 'uniform' ? 0.5 :
        0.01 + (field === 'weak' ? 0.0001 : 1) * Math.exp(-r * r / (2 * 0.06 ** 2))
    })
    const phases = new Set<string>()
    while (!engine.isCompleted()) phases.add(engine.step().decision.phase)
    const frame = engine.getFrame()
    expect(frame.metrics.nativeDeclaration).toBe(field === 'peak')
    if (field === 'peak') {
      expect(access.inspectionOutcome).toBe('confirmed')
      expect(frame.time).toBeGreaterThan(75)
      expect(access.gradientRays).toHaveLength(0)
      expect(frame.metrics.pathLengthMeters).toBeGreaterThan(0.4)
    } else expect(phases.has('CANDIDATE CONFIRMATION DWELL')).toBe(true)
  })
  it('requires explicit valid configuration and a finite scheduling budget', () => {
    const { config } = fixture()
    expect(() => validateSimulationConfig({ ...config, scenarioKind: 'obstructed' })).toThrow(/Bounded inspection/)
    expect(() => inspectionAttemptBudget(center, [center], config.localInletSampling!.inspection, 0, 1, 0.25)).toThrow()
  })
  it('will not freeze an unstable or stale candidate history', () => {
    for (const times of [[0], [-90, -88, -86]]) {
      const { engine, access, input } = fixture()
      Object.assign(engine.controller, { estimateHistory: times.map(time => ({ time, point: center })) })
      engine.controller.step(input(0))
      expect(access.inspectionPrior).toBeNull()
    }
  })
  it('does not alias raw geometry into the prior and resets all lifecycle state', () => {
    const { engine, access, input } = fixture()
    access.beginPhysicalInspection(input(0))
    ;(access.rayEstimate as { point: Vec2 }).point = { x: 0.1, y: 0.1 }
    expect(access.inspectionPrior!.ray.point).toEqual(center)
    engine.controller.reset(engine.environment)
    expect(access.inspectionPrior).toBeNull()
    expect(access.inspectionOutcome).toBe('not-started')
  })
})
