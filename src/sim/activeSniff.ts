import { add, clamp, magnitude, normalize, scale } from './math'
import type { PlumeModel } from './plume'
import type {
  ActiveSniffCommand,
  ActiveSniffFrame,
  ActiveSniffPhase,
  ActiveSniffStatus,
  Vec2,
} from './types'

/**
 * Engine-private state for one pulse-return intervention.
 *
 * `latentReturn` is deliberately never exposed through AlgorithmEnvironment or
 * SimulationFrame. Controllers receive only the delayed, sensor-filtered scalar
 * returned by the engine.
 */
export type ActiveSniffEvent = {
  probeId: number
  origin: Vec2
  direction: Vec2
  strength: number
  reach: number
  cycleSeconds: number
  startedAt: number
  latentReturn: number
}

export type ActiveSniffKernelSample = {
  point: Vec2
  /** Normalized weight among the retained samples. */
  weight: number
  /** Weight in the original unclipped footprint; nominal weights sum to one. */
  nominalWeight: number
}

const pointIsReachable = (
  origin: Vec2,
  point: Vec2,
  isBlocked: (point: Vec2, clearance?: number) => boolean,
) => {
  if (isBlocked(point, 0.002)) return false
  const travel = Math.hypot(point.x - origin.x, point.y - origin.y)
  const probes = Math.max(2, Math.ceil(travel / 0.006))
  for (let index = 1; index <= probes; index += 1) {
    const amount = index / probes
    const probe = {
      x: origin.x + (point.x - origin.x) * amount,
      y: origin.y + (point.y - origin.y) * amount,
    }
    if (isBlocked(probe, 0.002)) return false
  }
  return true
}

/**
 * Obstacle-clipped near-surface sampling footprint used by the first prototype.
 * This is an observation proxy for entrainment by an air pulse, not a CFD jet or
 * a model of odor desorbing from a surface.
 */
export const activeSniffKernel = (
  origin: Vec2,
  direction: Vec2,
  reach: number,
  isBlocked: (point: Vec2, clearance?: number) => boolean,
): ActiveSniffKernelSample[] => {
  const forward = normalize(direction, { x: 1, y: 0 })
  const lateral = { x: -forward.y, y: forward.x }
  const radial = [
    { fraction: 0.38, weight: 0.22 },
    { fraction: 0.68, weight: 0.46 },
    { fraction: 1, weight: 0.32 },
  ]
  const lateralOffsets = [
    { fraction: -0.18, weight: 0.24 },
    { fraction: 0, weight: 0.52 },
    { fraction: 0.18, weight: 0.24 },
  ]
  const samples: ActiveSniffKernelSample[] = []

  for (const along of radial) {
    for (const across of lateralOffsets) {
      const point = add(
        add(origin, scale(forward, reach * along.fraction)),
        scale(lateral, reach * across.fraction),
      )
      if (!pointIsReachable(origin, point, isBlocked)) continue
      const nominalWeight = along.weight * across.weight
      samples.push({ point, weight: nominalWeight, nominalWeight })
    }
  }

  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0)
  if (totalWeight <= 0) return []
  return samples.map((sample) => ({
    ...sample,
    nominalWeight: sample.weight,
    weight: sample.weight / totalWeight,
  }))
}

export const createActiveSniffEvent = ({
  command,
  origin,
  time,
  strengthScale,
  reach,
  cycleSeconds,
  plume,
  isBlocked,
}: {
  command: ActiveSniffCommand
  origin: Vec2
  time: number
  strengthScale: number
  reach: number
  cycleSeconds: number
  plume: PlumeModel
  isBlocked: (point: Vec2, clearance?: number) => boolean
}): ActiveSniffEvent | null => {
  if (!Number.isFinite(command.probeId) || magnitude(command.direction) <= 1e-9) return null
  const direction = normalize(command.direction)
  const strength = clamp(strengthScale * clamp(command.strength ?? 1, 0, 1), 0, 1)
  const localConcentration = plume.concentrationAt(origin, time)
  const kernel = activeSniffKernel(origin, direction, reach, isBlocked)
  const entrainedConcentration = kernel.length > 0
    ? kernel.reduce(
        (sum, sample) => sum + sample.weight * plume.concentrationAt(sample.point, time),
        0,
      )
    : localConcentration
  // Zero pulse strength must be a true no-intervention control; otherwise the
  // controller could obtain directional information at zero recorded energy.
  const entrainment = 0.67 * strength

  return {
    probeId: Math.trunc(command.probeId),
    origin: { ...origin },
    direction,
    strength,
    reach,
    cycleSeconds,
    startedAt: time,
    latentReturn:
      (1 - entrainment) * localConcentration + entrainment * entrainedConcentration,
  }
}

export const activeSniffPhaseAt = (
  event: ActiveSniffEvent,
  time: number,
): ActiveSniffPhase => {
  const progress = clamp((time - event.startedAt) / event.cycleSeconds, 0, 1)
  if (progress <= 1 / 3) return 'exhale'
  if (progress < 1) return 'settle'
  return 'return'
}

export const activeSniffStatusAt = (
  event: ActiveSniffEvent,
  time: number,
): ActiveSniffStatus => ({
  probeId: event.probeId,
  phase: activeSniffPhaseAt(event, time),
  direction: { ...event.direction },
  strength: event.strength,
  progress: clamp((time - event.startedAt) / event.cycleSeconds, 0, 1),
})

export const activeSniffFrameAt = (
  event: ActiveSniffEvent,
  time: number,
): ActiveSniffFrame => ({
  ...activeSniffStatusAt(event, time),
  origin: { ...event.origin },
  reach: event.reach,
  startedAt: event.startedAt,
})
