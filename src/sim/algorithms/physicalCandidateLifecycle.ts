import { distance } from '../math'
import type { InspectionContract, Vec2 } from '../types'

/** A controller scheduling allowance, NOT an estimate of plume coherence time.
 * Straight open-world segments, at the slowest confirmation speed (0.46),
 * one half-turn allowance per segment, and two sample/tick margins per dwell.
 * A timeout remains possible; this is not a guaranteed navigation bound.
 */
export function inspectionAttemptBudget(position: Vec2, waypoints: Vec2[], inspection: InspectionContract,
  maxSpeed: number, maxTurnRate: number, dt: number) {
  if (![maxSpeed, maxTurnRate, dt].every(v => Number.isFinite(v) && v > 0) || !waypoints.length) {
    throw new Error('Invalid physical inspection budget')
  }
  let path = 0, previous = position
  for (const point of waypoints) { path += distance(previous, point); previous = point }
  const dwellSeconds = waypoints.length * inspection.dwellSeconds
  const travelSeconds = path / (maxSpeed * 0.46)
  const turnSeconds = waypoints.length * Math.PI / maxTurnRate
  const cadenceMarginSeconds = waypoints.length * 2 * (inspection.sampleSpacingSeconds + dt)
  return { dwellSeconds, travelSeconds, turnSeconds, cadenceMarginSeconds,
    totalSeconds: dwellSeconds + travelSeconds + turnSeconds + cadenceMarginSeconds }
}
