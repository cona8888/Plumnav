import { activeSniffKernel, type ActiveSniffKernelSample } from './activeSniff'
import { clamp, magnitude, normalize, rotate, scale, add } from './math'
import type { PlumeModel } from './plume'
import type {
  QuadSniffChannelGeometry,
  QuadSniffChannelId,
  QuadSniffChannelReading,
  QuadSniffCommand,
  QuadSniffFrame,
  QuadSniffPhase,
  QuadSamplingMode,
  QuadSniffStatus,
  Vec2,
} from './types'

export const QUAD_SNIFF_CHANNEL_ORDER = [
  'front',
  'left',
  'aft',
  'right',
] as const satisfies readonly QuadSniffChannelId[]

const CHANNEL_ANGLE: Record<QuadSniffChannelId, number> = {
  front: 0,
  // Plan coordinates increase downward on the canvas, so a negative
  // mathematical quarter-turn is body-left in the displayed plan view.
  left: -Math.PI / 2,
  aft: Math.PI,
  right: Math.PI / 2,
}

const MAX_ENTRAINMENT = 0.67
const ZERO: Vec2 = { x: 0, y: 0 }

/**
 * Center-to-head distance for the matched passive comparator. The value is
 * normalized by domain side length and deliberately differs from active
 * capture reach: it is physical array geometry, not a suction footprint.
 */
export const QUAD_PASSIVE_ARRAY_RADIUS = 0.0125

export type QuadSniffLatentChannel = QuadSniffChannelGeometry & {
  /** Engine-private pre-sensor value; never copy this into status or frames. */
  latentConcentration: number
  /** Engine-private trapezoidal integral used to model aspiration averaging. */
  concentrationIntegral: number
  lastInstantaneousConcentration: number
  integrationSamples: number
  kernel: ActiveSniffKernelSample[]
}

/**
 * Engine-private state for one simultaneous four-channel aspiration cycle.
 * Public helpers below explicitly project this object to types without latent
 * channel values.
 */
export type QuadSniffEvent = {
  scanId: number
  origin: Vec2
  forward: Vec2
  strength: number
  samplingMode: QuadSamplingMode
  cycleSeconds: number
  startedAt: number
  lastIntegratedAt: number
  integrationIntervals: number[]
  latentChannels: QuadSniffLatentChannel[]
}

export type QuadSniffGradient = {
  /** Paired, dimensionless gradient in world/plan coordinates. */
  vector: Vec2
  direction: Vec2
  magnitude: number
  /** Magnitude mapped to [0, 1]; descriptive, not a calibrated probability. */
  quality: number
  meanConcentration: number
  complete: boolean
}

export const quadSniffChannelDirections = (
  forward: Vec2,
): Array<{ channel: QuadSniffChannelId; direction: Vec2 }> => {
  const unitForward = normalize(forward)
  return QUAD_SNIFF_CHANNEL_ORDER.map((channel) => ({
    channel,
    direction: normalize(rotate(unitForward, CHANNEL_ANGLE[channel])),
  }))
}

const safeConcentration = (value: number) =>
  Number.isFinite(value) ? Math.max(0, value) : 0

const copyGeometry = (
  channel: QuadSniffChannelGeometry,
): QuadSniffChannelGeometry => ({
  channel: channel.channel,
  direction: { ...channel.direction },
  reach: channel.reach,
  support: channel.support,
  effectiveOffset: { ...channel.effectiveOffset },
})

/**
 * Captures the four directional footprints at exactly `time`. The operation is
 * a non-depleting near-surface observation proxy: it does not modify the plume.
 * A caller supplies each bearing's terrain-correct horizontal reach.
 */
export const createQuadSniffEvent = ({
  command,
  origin,
  time,
  strengthScale,
  samplingMode = 'active-suction',
  passiveArrayRadius = QUAD_PASSIVE_ARRAY_RADIUS,
  cycleSeconds,
  reachForDirection,
  plume,
  isBlocked,
}: {
  command: QuadSniffCommand
  origin: Vec2
  time: number
  strengthScale: number
  samplingMode?: QuadSamplingMode
  passiveArrayRadius?: number
  cycleSeconds: number
  reachForDirection: (direction: Vec2, channel: QuadSniffChannelId) => number
  plume: PlumeModel
  isBlocked: (point: Vec2, clearance?: number) => boolean
}): QuadSniffEvent | null => {
  if (
    !Number.isFinite(command.scanId) ||
    !Number.isFinite(time) ||
    !Number.isFinite(cycleSeconds) ||
    cycleSeconds <= 0 ||
    magnitude(command.forward) <= 1e-9
  ) {
    return null
  }

  const forward = normalize(command.forward)
  const requestedStrength = command.strength === undefined
    ? 1
    : safeConcentration(command.strength)
  const strength = clamp(
    samplingMode === 'passive-array'
      ? 0
      : safeConcentration(strengthScale) * clamp(requestedStrength, 0, 1),
    0,
    1,
  )
  const localConcentration = safeConcentration(plume.concentrationAt(origin, time))
  const latentChannels = quadSniffChannelDirections(forward).map(
    ({ channel, direction }): QuadSniffLatentChannel => {
      const requestedReach = samplingMode === 'passive-array'
        ? passiveArrayRadius
        : reachForDirection(direction, channel)
      const reach = Number.isFinite(requestedReach) ? Math.max(0, requestedReach) : 0
      const passiveHead = add(origin, scale(direction, reach))
      const passiveHeadAvailable = reach > 0 && !isBlocked(passiveHead, 0.002)
      const kernel = samplingMode === 'active-suction' && reach > 0
        ? activeSniffKernel(origin, direction, reach, isBlocked)
        : []
      const support = samplingMode === 'passive-array'
        ? passiveHeadAvailable ? 1 : 0
        : clamp(
            kernel.reduce((sum, sample) => sum + sample.nominalWeight, 0),
            0,
            1,
          )
      const effectiveOffset = samplingMode === 'passive-array'
        ? passiveHeadAvailable ? scale(direction, reach) : ZERO
        : kernel.reduce(
            (sum, sample) => add(sum, scale({
              x: sample.point.x - origin.x,
              y: sample.point.y - origin.y,
            }, sample.weight)),
            ZERO,
          )
      // A zero-strength event is the timing-matched sham: preserve its full
      // geometry and cycle, but do not obtain remote directional information.
      const entrainedConcentration = strength > 0 && kernel.length > 0
        ? kernel.reduce(
            (sum, sample) =>
              sum +
              sample.weight * safeConcentration(plume.concentrationAt(sample.point, time)),
            0,
          )
        : localConcentration

      const initialConcentration = samplingMode === 'passive-array'
        ? passiveHeadAvailable
          ? safeConcentration(plume.concentrationAt(passiveHead, time))
          : localConcentration
        : (1 - MAX_ENTRAINMENT * strength * support) * localConcentration +
          MAX_ENTRAINMENT * strength * support * entrainedConcentration

      return {
        channel,
        direction,
        reach,
        support,
        effectiveOffset,
        latentConcentration: initialConcentration,
        concentrationIntegral: 0,
        lastInstantaneousConcentration: initialConcentration,
        integrationSamples: 1,
        kernel,
      }
    },
  )

  return {
    scanId: Math.trunc(command.scanId),
    origin: { ...origin },
    forward,
    strength,
    samplingMode,
    cycleSeconds,
    startedAt: time,
    lastIntegratedAt: time,
    integrationIntervals: [],
    latentChannels,
  }
}

/** Effective independent-sample count for duration-weighted trapezoidal data. */
export const quadSniffEffectiveSampleCount = (event: QuadSniffEvent) => {
  const intervals = event.integrationIntervals.filter((value) => value > 1e-12)
  if (intervals.length === 0) return 1
  const weights: number[] = [intervals[0]! / 2]
  for (let index = 1; index < intervals.length; index += 1) {
    weights.push((intervals[index - 1]! + intervals[index]!) / 2)
  }
  weights.push(intervals[intervals.length - 1]! / 2)
  const duration = intervals.reduce((sum, value) => sum + value, 0)
  const squaredWeights = weights.reduce((sum, value) => sum + value * value, 0)
  return squaredWeights > 0 ? duration * duration / squaredWeights : 1
}

/**
 * Adds one simultaneous four-channel sample to an in-progress aspiration.
 * The event keeps only an engine-private running mean. This reduced-order
 * model represents temporal collection, not tubing flow or pump CFD.
 */
export const integrateQuadSniffEvent = (
  event: QuadSniffEvent,
  time: number,
  plume: PlumeModel,
) => {
  if (!Number.isFinite(time)) return
  const integrationTime = Math.min(
    time,
    event.startedAt + event.cycleSeconds,
  )
  if (integrationTime <= event.lastIntegratedAt + 1e-10) return
  const interval = integrationTime - event.lastIntegratedAt
  const localConcentration = safeConcentration(
    plume.concentrationAt(event.origin, integrationTime),
  )
  for (const channel of event.latentChannels) {
    const entrainedConcentration = event.strength > 0 && channel.kernel.length > 0
      ? channel.kernel.reduce(
          (sum, sample) =>
            sum + sample.weight * safeConcentration(
              plume.concentrationAt(sample.point, integrationTime),
            ),
          0,
        )
      : localConcentration
    const entrainment = MAX_ENTRAINMENT * event.strength * channel.support
    const passiveHead = add(event.origin, channel.effectiveOffset)
    const instantaneous = event.samplingMode === 'passive-array'
      ? channel.support > 0
        ? safeConcentration(plume.concentrationAt(passiveHead, integrationTime))
        : localConcentration
      : (1 - entrainment) * localConcentration +
        entrainment * entrainedConcentration
    channel.concentrationIntegral +=
      (channel.lastInstantaneousConcentration + instantaneous) * interval / 2
    channel.lastInstantaneousConcentration = instantaneous
    channel.integrationSamples += 1
    channel.latentConcentration =
      channel.concentrationIntegral /
      Math.max(1e-12, integrationTime - event.startedAt)
  }
  event.integrationIntervals.push(interval)
  event.lastIntegratedAt = integrationTime
}

export const quadSniffPhaseAt = (
  event: QuadSniffEvent,
  time: number,
): QuadSniffPhase =>
  time - event.startedAt >= event.cycleSeconds ? 'return' : 'aspirate'

export const quadSniffStatusAt = (
  event: QuadSniffEvent,
  time: number,
): QuadSniffStatus => ({
  scanId: event.scanId,
  phase: quadSniffPhaseAt(event, time),
  forward: { ...event.forward },
  strength: event.strength,
  samplingMode: event.samplingMode,
  progress: clamp((time - event.startedAt) / event.cycleSeconds, 0, 1),
  channels: event.latentChannels.map(copyGeometry),
})

export const quadSniffFrameAt = (
  event: QuadSniffEvent,
  time: number,
): QuadSniffFrame => ({
  ...quadSniffStatusAt(event, time),
  origin: { ...event.origin },
  startedAt: event.startedAt,
  cycleSeconds: event.cycleSeconds,
})

const readingFor = (
  readings: readonly QuadSniffChannelReading[],
  channel: QuadSniffChannelId,
) => readings.find((reading) => reading.channel === channel)

const readingValue = (reading: QuadSniffChannelReading | undefined) =>
  safeConcentration(reading?.concentration ?? 0)

/**
 * Forms a common-mode-resistant local gradient from simultaneous opposing
 * pairs. The pair denominators include `noiseFloor` so vanishing signals cannot
 * generate an arbitrarily confident direction.
 */
export const pairedQuadSniffGradient = (
  readings: readonly QuadSniffChannelReading[],
  noiseFloor = 0.03,
): QuadSniffGradient => {
  const front = readingFor(readings, 'front')
  const left = readingFor(readings, 'left')
  const aft = readingFor(readings, 'aft')
  const right = readingFor(readings, 'right')
  const complete = Boolean(front && left && aft && right)
  const values = [front, left, aft, right].map(readingValue)
  const meanConcentration = values.reduce((sum, value) => sum + value, 0) / 4

  if (!complete) {
    return {
      vector: ZERO,
      direction: ZERO,
      magnitude: 0,
      quality: 0,
      meanConcentration,
      complete: false,
    }
  }

  const floor = Number.isFinite(noiseFloor) ? Math.max(1e-9, noiseFloor) : 0.03
  const frontValue = values[0]!
  const leftValue = values[1]!
  const aftValue = values[2]!
  const rightValue = values[3]!
  const axialContrast =
    (frontValue - aftValue) / (frontValue + aftValue + floor)
  const lateralContrast =
    (leftValue - rightValue) / (leftValue + rightValue + floor)
  const vector = add(
    scale(front!.direction, axialContrast),
    scale(left!.direction, lateralContrast),
  )
  const gradientMagnitude = magnitude(vector)

  return {
    vector,
    direction: normalize(vector, ZERO),
    magnitude: gradientMagnitude,
    quality: clamp(gradientMagnitude / Math.SQRT2, 0, 1),
    meanConcentration,
    complete: true,
  }
}
