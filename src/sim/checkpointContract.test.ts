import { describe, expect, it } from 'vitest'
import { runBatch } from './batch'
import { createDefaultConfig, validateSimulationConfig } from './config'
import { SimulationEngine } from './engine'

const config = () => ({
  ...createDefaultConfig('coverage', 'open'),
  fixedDt: 0.2,
  durationSeconds: 1,
  checkpointSeconds: [0.2, 0.6, 1],
  targetStatus: 'absent' as const,
  sensorNoise: 0,
  windNoise: 0,
  robotStartPositionOverride: { x: 0.2, y: 0.5 },
  stopOnNativeDeclaration: false,
})

describe('checkpoint time contract', () => {
  it.each([
    ['zero', [0, 1]],
    ['negative', [-0.2, 1]],
    ['duplicate', [0.2, 0.2, 1]],
    ['equivalent floating-point tick', [0.6, 0.2 * 3, 1]],
    ['after the deadline', [0.2, 2]],
    ['first partial tick', [0.05, 1]],
    ['half a tick', [0.1, 1]],
    ['three quarters of a tick', [0.15, 1]],
    ['later partial tick', [0.7, 1]],
  ])('rejects a %s checkpoint instead of inventing or omitting a snapshot', (_label, checkpoints) => {
    expect(() => validateSimulationConfig({ ...config(), checkpointSeconds: checkpoints as number[] }))
      .toThrow(/checkpointSeconds/)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects nonfinite checkpoint %s', checkpoint => {
    expect(() => new SimulationEngine({ ...config(), checkpointSeconds: [checkpoint] })).toThrow(/checkpointSeconds/)
  })

  it('preserves valid requested ordering and an explicitly empty schedule', () => {
    const requested = { ...config(), checkpointSeconds: [1, 0.6, 0.2] }
    expect(validateSimulationConfig(requested)).toBe(requested)
    expect(requested.checkpointSeconds).toEqual([1, 0.6, 0.2])
    const final = new SimulationEngine({ ...config(), checkpointSeconds: [] }).runToCompletion()
    expect(final.completed).toBe(true)
    expect(final.checkpoints).toEqual({})
  })

  it.each([
    { dt: 0.2, checkpoint: 0.6, ticks: 3, duration: 1.05 },
    { dt: 0.3, checkpoint: 0.9, ticks: 3, duration: 1.1 },
    { dt: 0.1, checkpoint: 10, ticks: 100, duration: 10.05 },
  ])('records $checkpoint s on tick $ticks at dt=$dt, and the exact partial final interval', ({ dt, checkpoint, ticks, duration }) => {
    const c = { ...config(), fixedDt: dt, durationSeconds: duration, checkpointSeconds: [checkpoint, duration] }
    const engine = new SimulationEngine(c)
    const controlIntervals: number[] = []
    engine.controller.step = input => {
      controlIntervals.push(input.dt)
      return { direction: { x: 1, y: 0 }, estimate: null, confidence: 0, phase: 'CONSTANT SPEED FIXTURE' }
    }
    for (let tick = 0; tick < ticks; tick++) engine.step()
    const atCheckpoint = engine.getFrame()
    expect(atCheckpoint.time).toBeCloseTo(checkpoint, 12)
    expect(atCheckpoint.checkpoints[checkpoint]).toBeDefined()
    expect(atCheckpoint.checkpoints[checkpoint]!.elapsedSeconds).toBe(checkpoint)
    expect(atCheckpoint.checkpoints[checkpoint]!.passiveSamples).toBe(ticks)
    expect(atCheckpoint.checkpoints[checkpoint]!.pathLengthMeters)
      .toBeCloseTo(c.robotSpeed * c.domainMeters * checkpoint, 10)

    const final = engine.runToCompletion()
    expect(final.time).toBe(duration)
    expect(final.checkpoints[duration]!.elapsedSeconds).toBe(duration)
    expect(final.checkpoints[duration]!.pathLengthMeters)
      .toBeCloseTo(c.robotSpeed * c.domainMeters * duration, 10)
    expect(controlIntervals.reduce((sum, interval) => sum + interval, 0)).toBeCloseTo(duration, 12)
    expect(controlIntervals.at(-1)).toBeCloseTo(duration % dt, 12)
    expect(final.metrics.passiveSamples).toBe(Math.ceil(duration / dt))
  })

  it('finishes a decimal-grid final checkpoint without an extra measurement or control command', () => {
    const engine = new SimulationEngine({ ...config(), fixedDt: 0.3, durationSeconds: 0.9, checkpointSeconds: [0.9] })
    const final = engine.runToCompletion()
    expect(final.time).toBe(0.9)
    expect(final.metrics.passiveSamples).toBe(3)
    expect(final.checkpoints[0.9]!.passiveSamples).toBe(3)
  })

  it('returns each accepted batch checkpoint including an off-grid final deadline', async () => {
    const c = { ...config(), durationSeconds: 1.05, checkpointSeconds: [0.2, 0.6, 1.05] }
    const batch = await runBatch(c, ['coverage'], ['open'], 1)
    expect(batch.results.map(result => result.checkpointSeconds)).toEqual(c.checkpointSeconds)
    for (const result of batch.results) {
      expect(result.metrics.elapsedSeconds).toBe(result.checkpointSeconds)
      expect(result.metrics.pathLengthMeters).toBeLessThanOrEqual(c.robotSpeed * c.domainMeters * result.checkpointSeconds + 1e-9)
    }
    await expect(runBatch({ ...c, checkpointSeconds: [0, 1.05, 2] }, ['coverage'], ['open'], 1))
      .rejects.toThrow(/checkpointSeconds/)
  })
})
