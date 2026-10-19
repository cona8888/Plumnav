import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config'
import { SimulationEngine } from './engine'
import { appendReplayFrame, snapshotSimulationFrame } from './replay'

describe('run replay snapshots', () => {
  it('records immutable frames at the selected cadence', () => {
    const engine = new SimulationEngine(createDefaultConfig('coverage', 'open'))
    const initial = snapshotSimulationFrame(engine.getFrame())
    let history = [initial]

    engine.step()
    const quarterSecond = engine.getFrame()
    expect(appendReplayFrame(history, quarterSecond)).toBe(history)

    for (let index = 0; index < 3; index += 1) engine.step()
    const oneSecond = engine.getFrame()
    history = appendReplayFrame(history, oneSecond)
    expect(history).toHaveLength(2)
    expect(history[1]?.time).toBe(1)

    const recordedPathLength = history[1]?.robot.path.length
    engine.step()
    expect(history[1]?.robot.path).toHaveLength(recordedPathLength ?? 0)
  })

  it('records a completion frame even inside the normal interval', () => {
    const engine = new SimulationEngine({
      ...createDefaultConfig('coverage', 'open'),
      durationSeconds: 0.25,
      checkpointSeconds: [0.25],
    })
    const history = [snapshotSimulationFrame(engine.getFrame())]
    engine.step()
    const completed = appendReplayFrame(history, engine.getFrame())
    expect(completed).toHaveLength(2)
    expect(completed[1]?.completed).toBe(true)
  })
})
