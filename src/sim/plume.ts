import { add, clamp, distance, dot, magnitude, normalize, rotate, scale, sub } from './math'
import { deterministicNoise } from './rng'
import {
  terrainGasDrift,
  terrainNearSurfaceLossRate,
} from './terrain'
import type { Obstacle, Scenario, Vec2 } from './types'

export type PlumePuff = {
  position: Vec2
  sigma: number
  intensity: number
  age: number
}

export type PlumeGridSnapshot = {
  width: number
  height: number
  time: number
  stepSeconds: number
  values: number[]
  blocked: boolean[]
}

export interface PlumeModel {
  readonly scenario: Scenario
  readonly seed: number
  windAt(point: Vec2, time: number): Vec2
  /** Gas transport velocity; unlike windAt(), this may include buoyancy drift. */
  transportAt(point: Vec2, time: number): Vec2
  puffsAt(time: number): PlumePuff[]
  concentrationAt(
    point: Vec2,
    time: number,
    preparedPuffs?: readonly PlumePuff[],
  ): number
  expectedHitRate(candidateSource: Vec2, samplePoint: Vec2, time: number): number
  gridAt?(time: number): PlumeGridSnapshot
  totalMassAt?(time: number): number
}

const EMISSION_INTERVAL = 0.72
const MAX_PUFF_AGE = 48

/** Exact closed-segment/AABB intersection using the slab formulation. */
export const segmentIntersectsObstacle = (a: Vec2, b: Vec2, obstacle: Obstacle) => {
  let minimumTime = 0
  let maximumTime = 1
  const axes = [
    [a.x, b.x - a.x, obstacle.x, obstacle.x + obstacle.width],
    [a.y, b.y - a.y, obstacle.y, obstacle.y + obstacle.height],
  ] as const

  for (const [origin, delta, minimum, maximum] of axes) {
    if (Math.abs(delta) <= 1e-12) {
      if (origin < minimum || origin > maximum) return false
      continue
    }
    let entry = (minimum - origin) / delta
    let exit = (maximum - origin) / delta
    if (entry > exit) [entry, exit] = [exit, entry]
    minimumTime = Math.max(minimumTime, entry)
    maximumTime = Math.min(maximumTime, exit)
    if (minimumTime > maximumTime) return false
  }
  return true
}

export class FilamentPlume implements PlumeModel {
  constructor(
    readonly scenario: Scenario,
    readonly seed: number,
  ) {}

  private gustWave(point: Vec2, time: number) {
    const secondaryWeight = this.scenario.turbulence * 0.65
    const primary = Math.sin(time * 0.31 + this.seed * 0.11)
    const secondary = Math.sin(time * 0.073 + point.y * 7.1)
    // Normalising the blend keeps the displayed gust setting a true upper
    // bound on local speed modulation, independent of turbulence.
    return (primary + secondaryWeight * secondary) / (1 + secondaryWeight)
  }

  windAt(point: Vec2, time: number): Vec2 {
    const base = this.scenario.baseWind
    const baseMagnitude = magnitude(base)
    const meander =
      Math.sin(time * 0.12 + point.x * 8.3 + this.seed * 0.017) *
      this.scenario.turbulence *
      0.24
    const gust = 1 + this.gustWave(point, time) * this.scenario.gustStrength
    const undisturbedWind = scale(rotate(base, meander), gust)
    let wind = undisturbedWind

    if (this.scenario.kind === 'obstructed') {
      let attenuation = 1
      let deflection: Vec2 = { x: 0, y: 0 }
      for (const obstacle of this.scenario.obstacles) {
        const center = {
          x: obstacle.x + obstacle.width / 2,
          y: obstacle.y + obstacle.height / 2,
        }
        const offset = sub(point, center)
        const radius = Math.max(obstacle.width, obstacle.height) * 0.78
        const proximity = clamp(1 - distance(point, center) / Math.max(radius, 1e-6))
        if (proximity <= 0) continue
        const tangent = normalize({ x: -offset.y, y: offset.x })
        const side = point.y >= center.y ? -1 : 1
        attenuation *= 1 - proximity * 0.48
        deflection = add(
          deflection,
          scale(tangent, side * baseMagnitude * proximity * 0.95),
        )
      }
      wind = add(scale(undisturbedWind, attenuation), deflection)
    }

    return wind
  }

  transportAt(point: Vec2, time: number): Vec2 {
    const wind = this.windAt(point, time)
    const drift = terrainGasDrift(this.scenario)
    if (drift.x === 0 && drift.y === 0) return wind
    return add(wind, drift)
  }

  puffsAt(time: number): PlumePuff[] {
    const source = this.scenario.source
    if (this.scenario.targetStatus !== 'emitting' || source === null) return []
    const lastIndex = Math.floor(time / EMISSION_INTERVAL)
    const firstIndex = Math.max(0, Math.ceil((time - MAX_PUFF_AGE) / EMISSION_INTERVAL))
    const puffs: PlumePuff[] = []
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const emittedAt = index * EMISSION_INTERVAL
      const age = time - emittedAt
      if (age < 0 || age > MAX_PUFF_AGE) continue

      const crossBias = deterministicNoise(this.seed, index, 31)
      const alongBias = deterministicNoise(this.seed, index, 37)
      const baseWind = this.scenario.baseWind
      const slopeDrift = terrainGasDrift(this.scenario)
      const baseTransport = add(baseWind, slopeDrift)
      const windDirection = normalize(baseTransport, normalize(baseWind))
      const crossDirection = { x: -windDirection.y, y: windDirection.x }
      // Midpoint sampling approximates the time-integrated gust transport
      // while retaining the same bounded amplitude contract as windAt().
      const advectiveGust =
        1 +
        this.gustWave(source, emittedAt + age * 0.5) *
          this.scenario.gustStrength
      const meander =
        Math.sin(index * 1.71 + age * 0.22 + this.seed * 0.013) *
        (0.008 + this.scenario.turbulence * 0.016) *
        Math.sqrt(Math.max(age, 0))
      let position = add(
        source,
        add(
          add(
            scale(baseWind, age * (0.92 + alongBias * 0.08) * advectiveGust),
            scale(slopeDrift, age),
          ),
          scale(crossDirection, meander + crossBias * 0.006 * Math.sqrt(age + 0.2)),
        ),
      )

      if (this.scenario.kind === 'obstructed') {
        const advectedPosition = position
        let wakeDisplacement: Vec2 = { x: 0, y: 0 }
        for (const obstacle of this.scenario.obstacles) {
          const center = {
            x: obstacle.x + obstacle.width / 2,
            y: obstacle.y + obstacle.height / 2,
          }
          const sourceOffset = sub(source, center)
          const puffOffset = sub(advectedPosition, center)
          const alongWake = dot(puffOffset, windDirection)
          const lateralWake = dot(puffOffset, crossDirection)
          const crossHalfExtent =
            Math.abs(crossDirection.x) * obstacle.width * 0.5 +
            Math.abs(crossDirection.y) * obstacle.height * 0.5
          const sourceIsUpwind = dot(sourceOffset, windDirection) < 0
          const nearWake =
            sourceIsUpwind &&
            alongWake > 0 &&
            alongWake < 0.24 &&
            Math.abs(lateralWake) < crossHalfExtent + 0.08
          if (!nearWake) continue
          const wakeStrength = clamp(1 - alongWake / 0.24)
          const passAbove = deterministicNoise(this.seed, index, obstacle.x * 1000) > 0
          wakeDisplacement = add(
            wakeDisplacement,
            scale(
              crossDirection,
              (passAbove ? -1 : 1) *
                wakeStrength *
                (crossHalfExtent * 0.42 + 0.015),
            ),
          )
        }
        position = add(advectedPosition, wakeDisplacement)
      }

      const sigma = 0.009 + Math.sqrt(2 * this.scenario.diffusivity * (age + 0.5))
      const referenceSigma =
        0.009 +
        Math.sqrt(2 * this.scenario.referenceDiffusivity * (age + 0.5))
      const diffusionMassCorrection = (referenceSigma / sigma) ** 2
      const intermittencyWave =
        1 +
        deterministicNoise(this.seed, index, 43) * this.scenario.intermittency * 0.62
      // A filament loses mass through dilution as it travels downwind. The
      // stronger near-field contrast is essential for concentration-seeking
      // methods and avoids treating the whole plume centreline as a source.
      const intensity =
        (Math.max(0.08, intermittencyWave) *
          Math.exp(-age / 18) *
          Math.exp(-terrainNearSurfaceLossRate(this.scenario) * age) *
          diffusionMassCorrection *
          this.scenario.emissionRateScale) /
        (1 + age * 0.09)
      puffs.push({ position, sigma, intensity, age })
    }
    return puffs
  }

  totalMassAt(time: number) {
    return this.puffsAt(time).reduce(
      (total, puff) => total + 2 * Math.PI * puff.sigma ** 2 * puff.intensity,
      0,
    )
  }

  concentrationAt(point: Vec2, time: number, preparedPuffs?: readonly PlumePuff[]) {
    const source = this.scenario.source
    if (this.scenario.targetStatus !== 'emitting' || source === null) return 0
    let mass = 0
    for (const puff of preparedPuffs ?? this.puffsAt(time)) {
      const radius = distance(point, puff.position)
      if (radius > puff.sigma * 3.4) continue
      const gaussian = Math.exp(-(radius * radius) / (2 * puff.sigma * puff.sigma))
      mass += gaussian * puff.intensity
    }

    let attenuation = 1
    if (this.scenario.kind === 'obstructed') {
      for (const obstacle of this.scenario.obstacles) {
        if (segmentIntersectsObstacle(source, point, obstacle)) attenuation *= 0.72
      }
    }
    const sourceDistance = distance(point, source)
    const nearSource =
      Math.exp(-(sourceDistance * sourceDistance) / (2 * 0.018 ** 2)) *
      1.9 *
      this.scenario.emissionRateScale
    return clamp(1 - Math.exp(-(mass * attenuation + nearSource) * 0.72), 0, 1.25)
  }

  expectedHitRate(candidateSource: Vec2, samplePoint: Vec2, time: number) {
    const transport = this.transportAt(samplePoint, time)
    const downwind = normalize(transport, normalize(this.scenario.baseWind))
    const relative = sub(samplePoint, candidateSource)
    const along = dot(relative, downwind)
    const cross = Math.abs(dot(relative, { x: -downwind.y, y: downwind.x }))
    if (along < -0.018) return 0.0015

    const effectiveAlong = Math.max(0.008, along)
    const travelTime = effectiveAlong / Math.max(0.005, magnitude(transport))
    const diffusiveSpread =
      0.009 + Math.sqrt(2 * this.scenario.diffusivity * (travelTime + 0.5))
    const turbulentSpread =
      effectiveAlong * (0.012 + this.scenario.turbulence * 0.025)
    const spread = diffusiveSpread + turbulentSpread
    const lateral = Math.exp(-(cross * cross) / (2 * spread * spread))
    const decay = Math.exp(-effectiveAlong / 0.82) / Math.sqrt(effectiveAlong + 0.035)
    const nearSurfaceRetention = Math.exp(
      -terrainNearSurfaceLossRate(this.scenario) * travelTime,
    )
    let rate = 0.004 + 1.45 * lateral * decay * nearSurfaceRetention

    if (this.scenario.kind === 'obstructed') {
      for (const obstacle of this.scenario.obstacles) {
        if (segmentIntersectsObstacle(candidateSource, samplePoint, obstacle)) rate *= 0.56
      }
    }
    return clamp(rate * this.scenario.emissionRateScale, 0.0015, 4.5)
  }
}
