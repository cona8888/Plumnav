import { clamp } from './math'
import {
  FilamentPlume,
  segmentIntersectsObstacle,
  type PlumeGridSnapshot,
  type PlumeModel,
  type PlumePuff,
} from './plume'
import type { GridMassBudget, GridTransportVersion, Scenario, Vec2 } from './types'
import {
  terrainGasDrift,
  terrainNearSurfaceLossRate,
} from './terrain'

export type { GridMassBudget, GridTransportVersion } from './types'

/** Controls the cost/accuracy trade-off of the numerical plume. */
export type GridPlumeOptions = {
  /** Omitted historical options retain the original, nonconservative solver. */
  transportVersion?: GridTransportVersion
  /** Number of finite-volume cells along each side of the unit-square domain. */
  resolution?: number
  /** Requested fixed solver step. It is reduced automatically for diffusion stability. */
  stepSeconds?: number
  /** First-order dilution/loss time constant. */
  decaySeconds?: number
  /** Dimensionless reference-equivalent source strength per second. */
  sourceRate?: number
}

export type GridPlumeSnapshot = PlumeGridSnapshot & {
  transportVersion: GridTransportVersion
  /** Null means that this historical solver has no conservative budget. */
  massBudget: GridMassBudget | null
}

type GridField = Float32Array | Float64Array

type CumulativeBudget = Omit<GridMassBudget,
  'time' | 'initialMass' | 'initialClippingLossMass' | 'currentMass' | 'balanceResidual'>

type GridState = {
  field: GridField
  budget: CumulativeBudget | null
}

type PreparedField = {
  time: number
  lower: GridState
  upper: GridState
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
 * The versioned conservative solver uses shared upwind face fluxes, zero
 * solid-face flux, zero exterior inflow concentration and measured outflow.
 * It solves conservative scalar transport in a prescribed velocity field;
 * it does not solve incompressible airflow. The legacy version retains the
 * historical semi-Lagrangian backtrace, including its nonconservation.
 * Diffusion has no-flux solid/domain boundaries. Source and loss follow
 * transport. Canonical states make fields and budgets query-order independent.
 */
export class GridPlume implements PlumeModel {
  readonly transportVersion: GridTransportVersion
  readonly resolution: number
  readonly stepSeconds: number
  /** Design speed estimate; the conservative version also checks actual face CFL. */
  readonly transportSpeedEnvelope: number
  /** Estimated cells crossed per substep at the transport-speed envelope. */
  readonly advectiveCourantEstimate: number

  private readonly cellSize: number
  private readonly decaySeconds: number
  private readonly sourceRate: number
  private readonly nearSurfaceLossRate: number
  private readonly blockedMask: Uint8Array
  /** Cell-centred source density; its area-weighted sum is the reference budget. */
  private readonly sourceKernel: GridField
  private readonly analyticalPlume: FilamentPlume
  private readonly checkpoints = new Map<number, GridState>()
  private readonly verticalFaces: Uint8Array
  private readonly horizontalFaces: Uint8Array
  private readonly initialMass: number
  private readonly initialClippingLossMass: number

  private latestTick = 0
  private latestState: GridState
  private prepared: PreparedField | null = null

  constructor(
    readonly scenario: Scenario,
    readonly seed: number,
    options: GridPlumeOptions = {},
  ) {
    const transportVersion = options.transportVersion ?? 'legacy-semi-lagrangian-v1'
    if (transportVersion !== 'legacy-semi-lagrangian-v1' &&
        transportVersion !== 'conservative-upwind-v1') {
      throw new RangeError('Unknown grid plume transportVersion')
    }
    this.transportVersion = transportVersion
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
    if (transportVersion === 'conservative-upwind-v1' &&
        (!Number.isFinite(this.stepSeconds) || this.stepSeconds <= 0)) {
      throw new RangeError('Grid effective stepSeconds must be finite and positive')
    }
    this.advectiveCourantEstimate =
      this.transportSpeedEnvelope * this.stepSeconds / this.cellSize
    this.decaySeconds = decaySeconds
    this.sourceRate = sourceRate
    this.blockedMask = this.createBlockedMask()
    this.sourceKernel = this.createSourceKernel()
    this.analyticalPlume = new FilamentPlume(scenario, seed)
    const faces = this.createFluidFaces()
    this.verticalFaces = faces.vertical
    this.horizontalFaces = faces.horizontal
    const initialField = this.createInitialField()
    this.initialMass = this.fieldMass(initialField)
    this.initialClippingLossMass = Array.from(this.sourceKernel).reduce(
      (total, density) => total + Math.max(0,
        density * 0.35 * (this.sourceRate / DEFAULT_SOURCE_RATE) - 1),
      0,
    ) * this.cellSize ** 2
    if (transportVersion === 'conservative-upwind-v1' &&
        !Number.isFinite(this.initialClippingLossMass)) {
      throw new RangeError('Grid initial clipping budget must be finite')
    }
    this.latestState = {
      field: initialField,
      budget: transportVersion === 'conservative-upwind-v1' ? {
        injectedMass: 0,
        decayLossMass: 0,
        boundaryOutflowMass: 0,
        upperClippingLossMass: 0,
        lowerClippingGainMass: 0,
        maximumAdvectiveCourant: 0,
        advectionSubsteps: 0,
      } : null,
    }
    this.checkpoints.set(0, this.copyState(this.latestState))
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
    const lower = this.sample(field.lower.field, point)
    if (field.blend <= 1e-12) return clamp(lower, 0, 1)
    const upper = this.sample(field.upper.field, point)
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
      const lower = this.sample(field.lower.field, point)
      const upper = field.blend <= 1e-12 ? lower : this.sample(field.upper.field, point)
      return clamp(lower + (upper - lower) * field.blend, 0, 1)
    })
  }

  /** Serializable field for canvas/heat-map rendering. */
  gridAt(time: number): GridPlumeSnapshot {
    if (!Number.isFinite(time) || time < 0) {
      throw new RangeError('Grid plume query time must be finite and non-negative')
    }
    const field = this.prepareField(time)
    const values = new Array<number>(field.lower.field.length)
    for (let index = 0; index < values.length; index += 1) {
      values[index] = this.blockedMask[index]
        ? 0
        : clamp(
            field.lower.field[index]! +
              (field.upper.field[index]! - field.lower.field[index]!) * field.blend,
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
      transportVersion: this.transportVersion,
      massBudget: this.preparedBudget(field,
        values.reduce((total, value) => total + value, 0) * this.cellSize ** 2),
    }
  }

  /** Explicit source/sink accounting, unavailable for the legacy transport. */
  massBudgetAt(time: number): GridMassBudget | null {
    return this.gridAt(time).massBudget
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
    if (this.transportVersion === 'conservative-upwind-v1' &&
        (!Number.isSafeInteger(lowerTick) || !Number.isSafeInteger(upperTick))) {
      throw new RangeError('Grid query ticks must be finite safe integers')
    }
    const lower = this.stateAtTick(lowerTick)
    const upper = upperTick === lowerTick ? lower : this.stateAtTick(upperTick)
    this.prepared = { time, lower, upper, blend }
    return this.prepared
  }

  private createField(length = this.resolution * this.resolution): GridField {
    return this.transportVersion === 'conservative-upwind-v1'
      ? new Float64Array(length)
      : new Float32Array(length)
  }

  private fieldMass(field: GridField) {
    let total = 0
    for (const value of field) total += value
    return total * this.cellSize ** 2
  }

  private copyState(state: GridState): GridState {
    return {
      field: state.field.slice(),
      budget: state.budget === null ? null : { ...state.budget },
    }
  }

  private preparedBudget(field: PreparedField, currentMass: number): GridMassBudget | null {
    const lower = field.lower.budget
    const upper = field.upper.budget
    if (lower === null || upper === null) return null
    const interpolate = (key: keyof CumulativeBudget) =>
      lower[key] + (upper[key] - lower[key]) * field.blend
    const injectedMass = interpolate('injectedMass')
    const decayLossMass = interpolate('decayLossMass')
    const boundaryOutflowMass = interpolate('boundaryOutflowMass')
    const upperClippingLossMass = interpolate('upperClippingLossMass')
    const lowerClippingGainMass = interpolate('lowerClippingGainMass')
    return {
      time: field.time,
      initialMass: this.initialMass,
      initialClippingLossMass: this.initialClippingLossMass,
      currentMass,
      injectedMass,
      decayLossMass,
      boundaryOutflowMass,
      upperClippingLossMass,
      lowerClippingGainMass,
      balanceResidual: currentMass - (this.initialMass + injectedMass -
        decayLossMass - boundaryOutflowMass - upperClippingLossMass + lowerClippingGainMass),
      maximumAdvectiveCourant: upper.maximumAdvectiveCourant,
      advectionSubsteps: upper.advectionSubsteps,
    }
  }

  private stateAtTick(targetTick: number): GridState {
    if (targetTick === this.latestTick) return this.latestState
    if (targetTick > this.latestTick) {
      this.latestState = this.evolve(
        this.latestState,
        this.latestTick,
        targetTick,
        true,
      )
      this.latestTick = targetTick
      return this.latestState
    }

    let checkpointTick = 0
    let checkpoint = this.checkpoints.get(0)!
    for (const [tick, state] of this.checkpoints) {
      if (tick <= targetTick && tick >= checkpointTick) {
        checkpointTick = tick
        checkpoint = state
      }
    }
    return this.evolve(checkpoint, checkpointTick, targetTick, false)
  }

  private evolve(
    initial: GridState,
    fromTick: number,
    targetTick: number,
    retainCheckpoints: boolean,
  ): GridState {
    if (fromTick === targetTick) return initial
    let current: GridField = initial.field.slice()
    const advected = this.createField(current.length)
    let next = this.createField(current.length)
    const budget = initial.budget === null ? null : { ...initial.budget }

    for (let tick = fromTick; tick < targetTick; tick += 1) {
      if (budget === null) {
        this.advect(current, advected, tick * this.stepSeconds)
      } else {
        this.advectConservative(current, advected, tick * this.stepSeconds, budget)
      }
      this.diffuseEmitAndDecay(
        advected,
        next,
        (tick + 0.5) * this.stepSeconds,
        budget,
      )
      const reusable = current
      current = next
      next = reusable
      if (retainCheckpoints && (tick + 1) % CHECKPOINT_STRIDE === 0) {
        this.checkpoints.set(tick + 1, this.copyState({ field: current, budget }))
      }
    }
    return { field: current, budget }
  }

  private advect(input: GridField, output: GridField, time: number) {
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

  /**
   * Donor-cell finite-volume transport. Each interior face is applied once
   * with opposite signs to its two cells. A solid face has exactly zero flux;
   * exterior inflow has C=0, and exterior outflow enters the loss budget.
   * Velocities are frozen at the canonical midpoint during CFL subcycling.
   */
  private advectConservative(
    input: GridField,
    output: GridField,
    time: number,
    budget: CumulativeBudget,
  ) {
    const n = this.resolution
    const dx = this.cellSize
    const dt = this.stepSeconds
    const midpoint = time + dt * 0.5
    const vertical = new Float64Array(n * (n + 1))
    const horizontal = new Float64Array(n * (n + 1))
    const outgoing = new Float64Array(n * n)

    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x <= n; x += 1) {
        const face = y * (n + 1) + x
        if (!this.verticalFaces[face]) continue
        const velocity = this.transportAt({ x: x * dx, y: (y + 0.5) * dx }, midpoint).x
        if (!Number.isFinite(velocity)) throw new RangeError('Grid face velocity must be finite')
        vertical[face] = velocity
        if (velocity > 0 && x > 0) outgoing[y * n + x - 1]! += velocity
        if (velocity < 0 && x < n) outgoing[y * n + x]! -= velocity
      }
    }
    for (let y = 0; y <= n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const face = y * n + x
        if (!this.horizontalFaces[face]) continue
        const velocity = this.transportAt({ x: (x + 0.5) * dx, y: y * dx }, midpoint).y
        if (!Number.isFinite(velocity)) throw new RangeError('Grid face velocity must be finite')
        horizontal[face] = velocity
        if (velocity > 0 && y > 0) outgoing[(y - 1) * n + x]! += velocity
        if (velocity < 0 && y < n) outgoing[y * n + x]! -= velocity
      }
    }

    // For multidimensional positivity the SUM of outgoing face speeds matters.
    // Measuring it also covers obstacle-field or user-field speeds above the
    // constructor's design estimate. A design envelope alone is not a proof.
    const maximumOutgoing = outgoing.reduce((maximum, value) => Math.max(maximum, value), 0)
    const canonicalCourant = maximumOutgoing * dt / dx
    if (!Number.isFinite(canonicalCourant)) {
      throw new RangeError('Grid advective Courant number must be finite')
    }
    const substeps = Math.max(1, Math.ceil(canonicalCourant / GRID_TARGET_ADVECTIVE_COURANT))
    if (!Number.isSafeInteger(substeps)) {
      throw new RangeError('Grid advection substeps must be a finite safe integer')
    }
    const substepSeconds = dt / substeps
    const scale = substepSeconds / dx
    const area = dx * dx
    budget.maximumAdvectiveCourant = Math.max(
      budget.maximumAdvectiveCourant, canonicalCourant / substeps,
    )
    budget.advectionSubsteps += substeps
    let current = input
    let next = output
    const temporary = substeps > 1 ? new Float64Array(input.length) : null

    for (let step = 0; step < substeps; step += 1) {
      next.set(current)
      let outflow = 0
      for (let y = 0; y < n; y += 1) {
        for (let x = 0; x <= n; x += 1) {
          const velocity = vertical[y * (n + 1) + x]!
          if (velocity === 0) continue
          const left = x > 0 ? y * n + x - 1 : -1
          const right = x < n ? y * n + x : -1
          const donor = velocity > 0 ? left : right
          if (donor < 0) continue // Exterior inflow contains zero scalar.
          const transferred = velocity * scale * current[donor]!
          if (left >= 0) next[left]! -= transferred
          if (right >= 0) next[right]! += transferred
          if (left < 0 || right < 0) outflow += Math.abs(transferred) * area
        }
      }
      for (let y = 0; y <= n; y += 1) {
        for (let x = 0; x < n; x += 1) {
          const velocity = horizontal[y * n + x]!
          if (velocity === 0) continue
          const up = y > 0 ? (y - 1) * n + x : -1
          const down = y < n ? y * n + x : -1
          const donor = velocity > 0 ? up : down
          if (donor < 0) continue
          const transferred = velocity * scale * current[donor]!
          if (up >= 0) next[up]! -= transferred
          if (down >= 0) next[down]! += transferred
          if (up < 0 || down < 0) outflow += Math.abs(transferred) * area
        }
      }
      budget.boundaryOutflowMass += outflow
      if (step + 1 < substeps) {
        current = next
        next = next === output ? temporary! : output
      }
    }
    if (next !== output) output.set(next)
  }

  private diffuseEmitAndDecay(
    input: GridField,
    output: GridField,
    time: number,
    budget: CumulativeBudget | null,
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
    if (budget !== null && !Number.isFinite(injected)) {
      throw new RangeError('Grid source forcing must be finite')
    }

    output.fill(0)
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const index = y * n + x
        if (this.blockedMask[index]) continue
        const center = input[index]!
        const left = budget !== null && !this.verticalFaces[y * (n + 1) + x]
          ? center : this.fluidNeighbor(input, x - 1, y, center)
        const right = budget !== null && !this.verticalFaces[y * (n + 1) + x + 1]
          ? center : this.fluidNeighbor(input, x + 1, y, center)
        const up = budget !== null && !this.horizontalFaces[y * n + x]
          ? center : this.fluidNeighbor(input, x, y - 1, center)
        const down = budget !== null && !this.horizontalFaces[(y + 1) * n + x]
          ? center : this.fluidNeighbor(input, x, y + 1, center)
        const diffused = center + alpha * (left + right + up + down - 4 * center)
        let value = diffused * loss

        // The kernel is a cell-centred density, normalized over the available
        // fluid cells. Consequently sum(value * cell area) increases by the
        // fixed reference source budget (up to the final concentration clamp),
        // regardless of resolution or whether the source is near a boundary.
        const added = injected * this.sourceKernel[index]!
        value += added
        if (budget !== null && !Number.isFinite(value)) {
          throw new RangeError('Grid concentration update must be finite')
        }
        output[index] = clamp(value, 0, 1)
        if (budget !== null) {
          const area = this.cellSize ** 2
          budget.injectedMass += added * area
          budget.decayLossMass += diffused * (1 - loss) * area
          budget.upperClippingLossMass += Math.max(0, value - 1) * area
          budget.lowerClippingGainMass += Math.max(0, -value) * area
        }
      }
    }
    if (budget !== null && !Object.values(budget).every(Number.isFinite)) {
      throw new RangeError('Grid cumulative mass budget must remain finite')
    }
  }

  private sample(field: GridField, point: Vec2) {
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
      // A thin solid may separate two fluid cell centres. Public interpolation
      // must respect that separation just as conservative transport does.
      if (this.transportVersion === 'conservative-upwind-v1' &&
          this.segmentHitsObstacle(point, this.cellCenter(sample.x, sample.y))) continue
      value += field[index]! * sample.weight
      totalWeight += sample.weight
    }
    return totalWeight > 1e-12 ? value / totalWeight : 0
  }

  private fluidNeighbor(
    field: GridField,
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

  /** Symmetric face masks also close thin solids crossed between cell centres. */
  private createFluidFaces() {
    const n = this.resolution
    const vertical = new Uint8Array(n * (n + 1))
    const horizontal = new Uint8Array(n * (n + 1))
    if (this.transportVersion === 'legacy-semi-lagrangian-v1') return { vertical, horizontal }
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x <= n; x += 1) {
        if ((x > 0 && this.blockedMask[y * n + x - 1]) ||
            (x < n && this.blockedMask[y * n + x])) continue
        const a = x > 0 ? this.cellCenter(x - 1, y) : { x: 0, y: (y + 0.5) * this.cellSize }
        const b = x < n ? this.cellCenter(x, y) : { x: 1, y: (y + 0.5) * this.cellSize }
        if (!this.segmentHitsObstacle(a, b)) vertical[y * (n + 1) + x] = 1
      }
    }
    for (let y = 0; y <= n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        if ((y > 0 && this.blockedMask[(y - 1) * n + x]) ||
            (y < n && this.blockedMask[y * n + x])) continue
        const a = y > 0 ? this.cellCenter(x, y - 1) : { x: (x + 0.5) * this.cellSize, y: 0 }
        const b = y < n ? this.cellCenter(x, y) : { x: (x + 0.5) * this.cellSize, y: 1 }
        if (!this.segmentHitsObstacle(a, b)) horizontal[y * n + x] = 1
      }
    }
    return { vertical, horizontal }
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
    const field = this.createField()
    for (let y = 0; y < this.resolution; y += 1) {
      for (let x = 0; x < this.resolution; x += 1) {
        const index = y * this.resolution + x
        if (this.blockedMask[index]) continue
        const value = this.sourceKernel[index]! *
          0.35 *
          (this.sourceRate / DEFAULT_SOURCE_RATE)
        if (this.transportVersion === 'conservative-upwind-v1' && !Number.isFinite(value)) {
          throw new RangeError('Grid initial concentration must be finite')
        }
        field[index] = clamp(value, 0, 1)
      }
    }
    return field
  }

  private createSourceKernel() {
    const kernel = this.createField()
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
