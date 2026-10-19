import { clamp } from './math'
import {
  FilamentPlume,
  segmentIntersectsObstacle,
  type PlumeGridSnapshot,
  type PlumeModel,
  type PlumePuff,
} from './plume'
import type { Scenario, Vec2 } from './types'
import {
  terrainGasDrift,
  terrainNearSurfaceLossRate,
} from './terrain'

/** Controls the cost/accuracy trade-off of the numerical plume. */
export type GridPlumeOptions = {
  /** Number of finite-volume cells along each side of the unit-square domain. */
  resolution?: number
  /** Requested fixed solver step. It is reduced automatically for diffusion stability. */
  stepSeconds?: number
  /** First-order dilution/loss time constant. */
  decaySeconds?: number
  /** Dimensionless reference-equivalent source strength per second. */
  sourceRate?: number
}

export type GridPlumeSnapshot = PlumeGridSnapshot

type PreparedField = {
  time: number
  lower: Float32Array
  upper: Float32Array
  blend: number
}

const DEFAULT_RESOLUTION = 48
const DEFAULT_STEP_SECONDS = 0.15
const DEFAULT_DECAY_SECONDS = 22
const DEFAULT_SOURCE_RATE = 1.8
const CHECKPOINT_STRIDE = 40
// Keep the historical 48-cell source footprint's integrated scale while
// making that budget independent of the current discretization. The factor
// is the integral of the old 3-sigma-truncated Gaussian at the default grid.
const REFERENCE_SOURCE_SIGMA = Math.max((1 / DEFAULT_RESOLUTION) * 0.72, 0.012)
const REFERENCE_SOURCE_MASS =
  2 * Math.PI * REFERENCE_SOURCE_SIGMA ** 2 * (1 - Math.exp(-4.5))
export const GRID_TARGET_ADVECTIVE_COURANT = 0.9
const OBSTRUCTED_DEFLECTION_ALLOWANCE = 1.9

/**
 * Deterministic 2-D numerical advection-diffusion plume.
 *
 * Advection uses a semi-Lagrangian backtrace. Diffusion uses an explicit
 * five-point finite-volume stencil with no-flux solid and domain boundaries.
 * The source and first-order dilution terms are applied after transport.
 * Canonical fixed-time states make results independent of query order.
 */
export class GridPlume implements PlumeModel {
  readonly resolution: number
  readonly stepSeconds: number
  /** Conservative design estimate used to bound semi-Lagrangian backtrace length. */
  readonly transportSpeedEnvelope: number
  /** Estimated cells crossed per substep at the transport-speed envelope. */
  readonly advectiveCourantEstimate: number

  private readonly cellSize: number
  private readonly decaySeconds: number
  private readonly sourceRate: number
  private readonly nearSurfaceLossRate: number
  private readonly blockedMask: Uint8Array
  /** Cell-centred source density; its area-weighted sum is the reference budget. */
  private readonly sourceKernel: Float32Array
  private readonly analyticalPlume: FilamentPlume
  private readonly checkpoints = new Map<number, Float32Array>()

  private latestTick = 0
  private latestField: Float32Array
  private prepared: PreparedField | null = null

  constructor(
    readonly scenario: Scenario,
    readonly seed: number,
    options: GridPlumeOptions = {},
  ) {
    const resolution = options.resolution ?? DEFAULT_RESOLUTION
    const requestedStep = options.stepSeconds ?? DEFAULT_STEP_SECONDS
    const decaySeconds = options.decaySeconds ?? DEFAULT_DECAY_SECONDS
    const sourceRate = scenario.targetStatus === 'emitting'
      ? options.sourceRate ?? DEFAULT_SOURCE_RATE * scenario.emissionRateScale
      : 0

    if (!Number.isInteger(resolution) || resolution < 16 || resolution > 256) {
      throw new RangeError('Grid plume resolution must be an integer in [16, 256]')
    }
    if (!Number.isFinite(requestedStep) || requestedStep <= 0 || requestedStep > 1) {
      throw new RangeError('Grid plume stepSeconds must be in (0, 1]')
    }
    if (!Number.isFinite(decaySeconds) || decaySeconds <= 0) {
      throw new RangeError('Grid plume decaySeconds must be positive')
    }
    if (!Number.isFinite(sourceRate) || sourceRate < 0) {
      throw new RangeError('Grid plume sourceRate must be non-negative')
    }
    if (!Number.isFinite(scenario.diffusivity) || scenario.diffusivity < 0) {
      throw new RangeError('Scenario diffusivity must be finite and non-negative')
    }

    this.resolution = resolution
    this.cellSize = 1 / resolution
    this.nearSurfaceLossRate = terrainNearSurfaceLossRate(scenario)
    // The 2-D five-point explicit diffusion stencil is positivity preserving
    // for D*dt/dx^2 <= 1/4. A 0.22 target leaves useful floating-point margin.
    const diffusionLimit =
      scenario.diffusivity > 0
        ? (0.22 * this.cellSize * this.cellSize) / scenario.diffusivity
        : requestedStep
    const ambientSpeed = Math.hypot(scenario.baseWind.x, scenario.baseWind.y)
    const terrainDrift = terrainGasDrift(scenario)
    const terrainDriftSpeed = Math.hypot(terrainDrift.x, terrainDrift.y)
    // The analytical obstacle field can add tangential deflection to the
    // gusted ambient flow. Two overlapping near-wake contributions form a
    // conservative design allowance for the non-overlapping process layouts.
    // This is an accuracy cap; semi-Lagrangian advection is stable above it,
    // but long backtraces become unnecessarily diffusive.
    this.transportSpeedEnvelope =
      ambientSpeed * (
        1 + scenario.gustStrength +
        (scenario.obstacles.length > 0 ? OBSTRUCTED_DEFLECTION_ALLOWANCE : 0)
      ) + terrainDriftSpeed
    const advectionAccuracyLimit = this.transportSpeedEnvelope > 1e-12
      ? GRID_TARGET_ADVECTIVE_COURANT * this.cellSize / this.transportSpeedEnvelope
      : requestedStep
    this.stepSeconds = Math.min(requestedStep, diffusionLimit, advectionAccuracyLimit)
    this.advectiveCourantEstimate =
      this.transportSpeedEnvelope * this.stepSeconds / this.cellSize
    this.decaySeconds = decaySeconds
    this.sourceRate = sourceRate
    this.blockedMask = this.createBlockedMask()
    this.sourceKernel = this.createSourceKernel()
    this.analyticalPlume = new FilamentPlume(scenario, seed)
    this.latestField = this.createInitialField()
    this.checkpoints.set(0, this.latestField.slice())
  }

  /** The configured, deterministic wind field shared with the fast plume. */
  windAt(point: Vec2, time: number) {
    return this.analyticalPlume.windAt(point, time)
  }

  /** Gas transport includes terrain drift while windAt remains anemometer air speed. */
  transportAt(point: Vec2, time: number) {
    return this.analyticalPlume.transportAt(point, time)
  }

  /** Analytical inverse observation model used by localization controllers. */
  expectedHitRate(candidateSource: Vec2, samplePoint: Vec2, time: number) {
    return this.analyticalPlume.expectedHitRate(candidateSource, samplePoint, time)
  }

  /** Compatibility hook for the shared plume interface; grid rendering uses gridAt(). */
  puffsAt(_time: number): PlumePuff[] {
    return []
  }

  concentrationAt(
    point: Vec2,
    time: number,
    _preparedPuffs?: readonly PlumePuff[],
  ) {
    if (!Number.isFinite(time) || time < 0) {
      throw new RangeError('Grid plume query time must be finite and non-negative')
    }
    if (!this.inDomain(point) || this.isBlockedPoint(point)) return 0
    const field = this.prepareField(time)
    const lower = this.sample(field.lower, point)
    if (field.blend <= 1e-12) return clamp(lower, 0, 1)
    const upper = this.sample(field.upper, point)
    return clamp(lower + (upper - lower) * field.blend, 0, 1)
  }

  /** Efficiently samples several sensor locations from one prepared time state. */
  concentrationsAt(points: readonly Vec2[], time: number) {
    if (!Number.isFinite(time) || time < 0) {
      throw new RangeError('Grid plume query time must be finite and non-negative')
    }
    const field = this.prepareField(time)
    return points.map((point) => {
      if (!this.inDomain(point) || this.isBlockedPoint(point)) return 0
      const lower = this.sample(field.lower, point)
      const upper = field.blend <= 1e-12 ? lower : this.sample(field.upper, point)
      return clamp(lower + (upper - lower) * field.blend, 0, 1)
    })
  }

  /** Serializable field for canvas/heat-map rendering. */
  gridAt(time: number): GridPlumeSnapshot {
    if (!Number.isFinite(time) || time < 0) {
      throw new RangeError('Grid plume query time must be finite and non-negative')
    }
    const field = this.prepareField(time)
    const values = new Array<number>(field.lower.length)
    for (let index = 0; index < values.length; index += 1) {
      values[index] = this.blockedMask[index]
        ? 0
        : clamp(
            field.lower[index]! +
              (field.upper[index]! - field.lower[index]!) * field.blend,
            0,
            1,
          )
    }
    return {
      width: this.resolution,
      height: this.resolution,
      time,
      stepSeconds: this.stepSeconds,
      values,
      blocked: Array.from(this.blockedMask, Boolean),
    }
  }

  totalMassAt(time: number) {
    const snapshot = this.gridAt(time)
    return snapshot.values.reduce((total, value) => total + value, 0) *
      this.cellSize ** 2
  }

  private prepareField(time: number): PreparedField {
    if (this.prepared?.time === time) return this.prepared

    const exactTick = time / this.stepSeconds
    const lowerTick = Math.floor(exactTick + 1e-10)
    const blend = clamp(exactTick - lowerTick, 0, 1)
    const upperTick = blend <= 1e-10 ? lowerTick : lowerTick + 1
    const lower = this.stateAtTick(lowerTick)
    const upper = upperTick === lowerTick ? lower : this.stateAtTick(upperTick)
    this.prepared = { time, lower, upper, blend }
    return this.prepared
  }

  private stateAtTick(targetTick: number) {
    if (targetTick === this.latestTick) return this.latestField
    if (targetTick > this.latestTick) {
      this.latestField = this.evolve(
        this.latestField,
        this.latestTick,
        targetTick,
        true,
      )
      this.latestTick = targetTick
      return this.latestField
    }

    let checkpointTick = 0
    let checkpoint = this.checkpoints.get(0) as Float32Array
    for (const [tick, field] of this.checkpoints) {
      if (tick <= targetTick && tick >= checkpointTick) {
        checkpointTick = tick
        checkpoint = field
      }
    }
    return this.evolve(checkpoint, checkpointTick, targetTick, false)
  }

  private evolve(
    initial: Float32Array,
    fromTick: number,
    targetTick: number,
    retainCheckpoints: boolean,
  ) {
    if (fromTick === targetTick) return initial
    let current = initial.slice()
    let advected = new Float32Array(current.length)
    let next = new Float32Array(current.length)

    for (let tick = fromTick; tick < targetTick; tick += 1) {
      this.advect(current, advected, tick * this.stepSeconds)
      this.diffuseEmitAndDecay(
        advected,
        next,
        (tick + 0.5) * this.stepSeconds,
      )
      const reusable = current
      current = next
      next = reusable
      if (retainCheckpoints && (tick + 1) % CHECKPOINT_STRIDE === 0) {
        this.checkpoints.set(tick + 1, current.slice())
      }
    }
    return current
  }

  private advect(input: Float32Array, output: Float32Array, time: number) {
    const n = this.resolution
    const dt = this.stepSeconds
    output.fill(0)
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const index = y * n + x
        if (this.blockedMask[index]) continue
        const destination = this.cellCenter(x, y)
        const wind = this.transportAt(destination, time + dt * 0.5)
        const departure = {
          x: destination.x - wind.x * dt,
          y: destination.y - wind.y * dt,
        }
        if (!this.inDomain(departure)) continue
        // Backtraces that cross a solid face retain the cell value: a compact
        // no-through-flow treatment that avoids transporting gas through walls.
        output[index] = this.segmentHitsObstacle(destination, departure)
          ? input[index]!
          : this.sample(input, departure)
      }
    }
  }

  private diffuseEmitAndDecay(
    input: Float32Array,
    output: Float32Array,
    time: number,
  ) {
    const n = this.resolution
    const alpha =
      (this.scenario.diffusivity * this.stepSeconds) /
      (this.cellSize * this.cellSize)
    const loss = Math.exp(
      -this.stepSeconds * (1 / this.decaySeconds + this.nearSurfaceLossRate),
    )
    const sourceWave =
      1 +
      this.scenario.intermittency *
        (0.42 * Math.sin(time * 0.91 + this.seed * 0.017) +
          0.24 * Math.sin(time * 0.233 + this.seed * 0.071))
    const injected = this.sourceRate * this.stepSeconds * Math.max(0.15, sourceWave)

    output.fill(0)
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const index = y * n + x
        if (this.blockedMask[index]) continue
        const center = input[index]!
        const left = this.fluidNeighbor(input, x - 1, y, center)
        const right = this.fluidNeighbor(input, x + 1, y, center)
        const up = this.fluidNeighbor(input, x, y - 1, center)
        const down = this.fluidNeighbor(input, x, y + 1, center)
        let value = (center + alpha * (left + right + up + down - 4 * center)) * loss

        // The kernel is a cell-centred density, normalized over the available
        // fluid cells. Consequently sum(value * cell area) increases by the
        // fixed reference source budget (up to the final concentration clamp),
        // regardless of resolution or whether the source is near a boundary.
        value += injected * this.sourceKernel[index]!
        output[index] = clamp(value, 0, 1)
      }
    }
  }

  private sample(field: Float32Array, point: Vec2) {
    const n = this.resolution
    const gridX = point.x * n - 0.5
    const gridY = point.y * n - 0.5
    const x0 = Math.floor(gridX)
    const y0 = Math.floor(gridY)
    const tx = gridX - x0
    const ty = gridY - y0
    const samples = [
      { x: x0, y: y0, weight: (1 - tx) * (1 - ty) },
      { x: x0 + 1, y: y0, weight: tx * (1 - ty) },
      { x: x0, y: y0 + 1, weight: (1 - tx) * ty },
      { x: x0 + 1, y: y0 + 1, weight: tx * ty },
    ]
    let value = 0
    let totalWeight = 0
    for (const sample of samples) {
      if (sample.x < 0 || sample.x >= n || sample.y < 0 || sample.y >= n) continue
      const index = sample.y * n + sample.x
      if (this.blockedMask[index]) continue
      value += field[index]! * sample.weight
      totalWeight += sample.weight
    }
    return totalWeight > 1e-12 ? value / totalWeight : 0
  }

  private fluidNeighbor(
    field: Float32Array,
    x: number,
    y: number,
    fallback: number,
  ) {
    if (x < 0 || x >= this.resolution || y < 0 || y >= this.resolution) {
      return fallback
    }
    const index = y * this.resolution + x
    return this.blockedMask[index] ? fallback : field[index]!
  }

  private createBlockedMask() {
    const mask = new Uint8Array(this.resolution * this.resolution)
    for (let y = 0; y < this.resolution; y += 1) {
      for (let x = 0; x < this.resolution; x += 1) {
        const point = this.cellCenter(x, y)
        if (this.isBlockedPoint(point)) mask[y * this.resolution + x] = 1
      }
    }
    return mask
  }

  private createInitialField() {
    const field = new Float32Array(this.resolution * this.resolution)
    for (let y = 0; y < this.resolution; y += 1) {
      for (let x = 0; x < this.resolution; x += 1) {
        const index = y * this.resolution + x
        if (this.blockedMask[index]) continue
        field[index] = clamp(
          this.sourceKernel[index]! *
            0.35 *
            (this.sourceRate / DEFAULT_SOURCE_RATE),
          0,
          1,
        )
      }
    }
    return field
  }

  private createSourceKernel() {
    const kernel = new Float32Array(this.resolution * this.resolution)
    const source = this.scenario.source
    if (source === null) return kernel
    const sigma = Math.max(this.cellSize * 0.72, 0.012)
    const radiusSquared = (sigma * 3) ** 2
    let normalization = 0
    for (let y = 0; y < this.resolution; y += 1) {
      for (let x = 0; x < this.resolution; x += 1) {
        const index = y * this.resolution + x
        if (this.blockedMask[index]) continue
        const point = this.cellCenter(x, y)
        const dx = point.x - source.x
        const dy = point.y - source.y
        const radius = dx * dx + dy * dy
        if (radius > radiusSquared) continue
        const weight = Math.exp(-radius / (2 * sigma * sigma))
        kernel[index] = weight
        normalization += weight
      }
    }

    // A valid scenario normally leaves at least one fluid cell in the source
    // footprint. Keep a deterministic nearest-cell fallback for very narrow
    // obstacle gaps, so forcing is never silently dropped.
    if (normalization <= 1e-12) {
      let nearest = -1
      let nearestDistance = Number.POSITIVE_INFINITY
      for (let y = 0; y < this.resolution; y += 1) {
        for (let x = 0; x < this.resolution; x += 1) {
          const index = y * this.resolution + x
          if (this.blockedMask[index]) continue
          const point = this.cellCenter(x, y)
          const distance =
            (point.x - source.x) ** 2 +
            (point.y - source.y) ** 2
          if (distance < nearestDistance) {
            nearest = index
            nearestDistance = distance
          }
        }
      }
      if (nearest >= 0) {
        kernel[nearest] = 1
        normalization = 1
      }
    }

    const cellArea = this.cellSize * this.cellSize
    if (normalization > 1e-12) {
      for (let index = 0; index < kernel.length; index += 1) {
        kernel[index] =
          (kernel[index]! * REFERENCE_SOURCE_MASS) /
          (normalization * cellArea)
      }
    }
    return kernel
  }

  private segmentHitsObstacle(a: Vec2, b: Vec2) {
    return this.scenario.obstacles.some((obstacle) =>
      segmentIntersectsObstacle(a, b, obstacle),
    )
  }

  private isBlockedPoint(point: Vec2) {
    return this.scenario.obstacles.some(
      (obstacle) =>
        point.x >= obstacle.x &&
        point.x <= obstacle.x + obstacle.width &&
        point.y >= obstacle.y &&
        point.y <= obstacle.y + obstacle.height,
    )
  }

  private inDomain(point: Vec2) {
    return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
  }

  private cellCenter(x: number, y: number): Vec2 {
    return {
      x: (x + 0.5) * this.cellSize,
      y: (y + 0.5) * this.cellSize,
    }
  }
}
