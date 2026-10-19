import type { SimulationFrame } from './types'

export const snapshotSimulationFrame = (frame: SimulationFrame): SimulationFrame =>
  structuredClone(frame)

export const appendReplayFrame = (
  history: readonly SimulationFrame[],
  frame: SimulationFrame,
  intervalSeconds = 1,
): SimulationFrame[] => {
  const last = history[history.length - 1]
  const shouldRecord =
    !last ||
    frame.completed ||
    frame.time - last.time >= intervalSeconds - 1e-9
  if (!shouldRecord || (last?.time === frame.time && last.completed === frame.completed)) {
    return history as SimulationFrame[]
  }
  return [...history, snapshotSimulationFrame(frame)]
}
