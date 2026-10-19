import { add, distance, normalize, rotate, scale, sub } from '../math'
import type { AlgorithmEnvironment, Vec2 } from '../types'

export const PHYSICAL_VIEWPOINT_SPEED = 0.9

/** Scheduling-only intervention. Preserve the caller's ray separation gate.
 * Choose the shortest nominal separated step, then hold its target until arrival.
 * Time allowances are engineering limits, not plume-coherence predictions.
 */
export function selectPhysicalAcquisitionTarget(environment: AlgorithmEnvironment, position: Vec2,
  cue: Vec2, rayOrigins: Vec2[], separation: number, side: number, dt: number) {
  const inspection = environment.inspectionContract
  const lifecycle = environment.candidateLifecycle
  if (!inspection || !lifecycle || environment.maxSpeed <= 0) return null
  const arrival = inspection.arrivalRadiusNormalized
  const step = Math.max(separation + 2 * arrival, environment.activeSniffReach * 2)
  const directions = [side * Math.PI / 3, -side * Math.PI / 3, 0,
    side * Math.PI / 2, -side * Math.PI / 2, Math.PI]
  for (const angle of directions) {
    const target = add(position, scale(rotate(normalize(cue, { x: -1, y: 0 }), angle), step))
    if (rayOrigins.some(origin => distance(target, origin) < separation + arrival)) continue
    if (Array.from({ length: 17 }, (_, i) => add(position, scale(sub(target, position), i / 16)))
      .some(point => environment.isBlocked(point))) continue
    const travelAllowance = step / (environment.maxSpeed * PHYSICAL_VIEWPOINT_SPEED) +
      Math.PI / lifecycle.maximumTurnRateRadiansPerSecond + 2 * dt
    return { target, arrivalRadius: arrival, travelAllowance,
      returnAllowance: travelAllowance + environment.activeSniffCycleSeconds + dt }
  }
  return null
}
