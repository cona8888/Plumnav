import { describe, expect, it, vi } from 'vitest'
import { createDefaultConfig, validateSimulationConfig } from '../config'
import { SimulationEngine } from '../engine'
import { withBoundedPoseScans, withLocalInletDesign } from '../localInletSampling'
import { GSL_REFERENCE_DESIGN } from '../physicalDesign'
import type { AlgorithmStepInput, Vec2 } from '../types'

function config(bounded: boolean) {
  const p = withLocalInletDesign({ ...createDefaultConfig('quad-sniff-refine', 'open'),
    durationSeconds: 120, checkpointSeconds: [120], stopOnNativeDeclaration: false,
    sensorNoise: 0, windNoise: 0, robotStartPositionOverride: { x: 0.5, y: 0.5 } },
    GSL_REFERENCE_DESIGN, { recoveryTimeConstantSeconds: 2, maximumTurnRateRadiansPerSecond: Math.PI / 4 })
  return bounded ? withBoundedPoseScans(p) : p
}

describe('opt-in acquisition scan budget', () => {
  it('escapes the long-scan repeat loop on a homogeneous gas field without inventing a candidate', () => {
    const run = (bounded: boolean) => {
      const engine = new SimulationEngine(config(bounded))
      vi.spyOn(engine.plume, 'concentrationAt').mockReturnValue(1)
      const origins: Vec2[] = [], phases = new Set<string>()
      while (!engine.isCompleted()) {
        const before = engine.getFrame().robot.position
        const f = engine.step()
        phases.add(f.decision.phase)
        if (f.measurement.sampleMode === 'quad-passive-return') origins.push(before)
      }
      return { frame: engine.getFrame(), origins, phases }
    }
    const original = run(false), bounded = run(true)
    expect(original.frame.metrics.pathLengthMeters).toBe(0)
    expect(bounded.frame.metrics.pathLengthMeters).toBeGreaterThan(0.09)
    expect(bounded.origins.length).toBeGreaterThanOrEqual(3)
    expect(bounded.origins[0]).toEqual(bounded.origins[1])
    expect(Math.hypot(bounded.origins[2]!.x - bounded.origins[0]!.x,
      bounded.origins[2]!.y - bounded.origins[0]!.y)).toBeGreaterThanOrEqual(0.0009 - 1e-12)
    expect(bounded.phases.has('BOUNDED PHYSICAL RELOCATION')).toBe(true)
    expect(bounded.frame.metrics.nativeDeclaration).toBe(false)
    expect(bounded.frame.metrics.quadCandidateMaxProvisionalRayCount).toBe(0)
  })
  it('keeps blocked and timed-out relocation unresolved rather than declaring no leak', () => {
    for (const blocked of [true, false]) {
      const engine = new SimulationEngine(config(true))
      engine.controller.reset({ ...engine.environment, isBlocked: () => blocked })
      const controller = engine.controller as unknown as { physicalCompletedScansAtPose: number; physicalScanPose: Vec2 }
      controller.physicalCompletedScansAtPose = 2
      controller.physicalScanPose = { x: 0.5, y: 0.5 }
      const input = (time: number): AlgorithmStepInput => ({ time, dt: 0.25, position: { x: 0.5, y: 0.5 },
        heading: 0, distance: 0, observations: [], measurement: { time, concentration: 0,
          hit: false, valid: true, sampleMode: 'passive', wind: { x: 1, y: 0 } } })
      const first = engine.controller.step(input(0))
      const last = engine.controller.step(input(20))
      expect(first.phase).toBe(blocked ? 'PHYSICAL RELOCATION BLOCKED' : 'BOUNDED PHYSICAL RELOCATION')
      expect(last.phase).toBe(blocked ? 'PHYSICAL RELOCATION BLOCKED' : 'PHYSICAL RELOCATION TIMEOUT')
      expect(last.nativeTerminated).not.toBe(true)
      expect(last.nativeAbstained).not.toBe(true)
      expect(last.direction).toEqual({ x: 0, y: 0 })
    }
  })
  it('does not operate inside an already-started confirmation circuit', () => {
    const engine = new SimulationEngine(config(true))
    const access = engine.controller as unknown as {
      confirmationStartedAt: number | null; physicalCompletedScansAtPose: number
      boundedPhysicalRelocation(input: AlgorithmStepInput): unknown
    }
    access.confirmationStartedAt = 0
    access.physicalCompletedScansAtPose = 20
    expect(access.boundedPhysicalRelocation({} as AlgorithmStepInput)).toBeNull()
  })
  it('requires a valid explicit policy and does not mutate the unbounded configuration', () => {
    const p = config(false), before = JSON.stringify(p)
    const bounded = withBoundedPoseScans(p)
    expect(JSON.stringify(p)).toBe(before)
    bounded.localInletSampling!.scanPolicy!.maximumCompletedScansPerPose = 0
    expect(() => validateSimulationConfig(bounded)).toThrow(/scan policy/)
    expect(() => withBoundedPoseScans({ ...p, robotSpeed: 0 })).toThrow(/positive mobility/)
  })
})
