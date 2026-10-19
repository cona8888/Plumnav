import type { Obstacle, Vec2 } from './types'

export const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value))

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
export const scale = (value: Vec2, factor: number): Vec2 => ({
  x: value.x * factor,
  y: value.y * factor,
})
export const magnitude = (value: Vec2) => Math.hypot(value.x, value.y)
export const distance = (a: Vec2, b: Vec2) => magnitude(sub(a, b))
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y

export const normalize = (value: Vec2, fallback: Vec2 = { x: 1, y: 0 }): Vec2 => {
  const length = magnitude(value)
  return length > 1e-9 ? scale(value, 1 / length) : fallback
}

export const rotate = (value: Vec2, radians: number): Vec2 => ({
  x: value.x * Math.cos(radians) - value.y * Math.sin(radians),
  y: value.x * Math.sin(radians) + value.y * Math.cos(radians),
})

export const lerp = (a: number, b: number, amount: number) => a + (b - a) * amount
export const lerpVec = (a: Vec2, b: Vec2, amount: number): Vec2 => ({
  x: lerp(a.x, b.x, amount),
  y: lerp(a.y, b.y, amount),
})

export const pointInObstacle = (point: Vec2, obstacle: Obstacle, clearance = 0) =>
  point.x >= obstacle.x - clearance &&
  point.x <= obstacle.x + obstacle.width + clearance &&
  point.y >= obstacle.y - clearance &&
  point.y <= obstacle.y + obstacle.height + clearance

export const percentile = (values: readonly number[], quantile: number) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = clamp(quantile, 0, 1) * (sorted.length - 1)
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower] ?? 0
  return lerp(sorted[lower] ?? 0, sorted[upper] ?? 0, index - lower)
}

export const effectiveSampleSize = (weights: readonly number[]) => {
  const sumSquares = weights.reduce((sum, weight) => sum + weight * weight, 0)
  return sumSquares > 0 ? 1 / sumSquares : 0
}

export const weightedMean = (points: readonly { x: number; y: number; weight: number }[]): Vec2 => {
  const total = points.reduce((sum, point) => sum + point.weight, 0)
  if (total <= 0) return { x: 0.5, y: 0.5 }
  return points.reduce(
    (mean, point) => ({
      x: mean.x + (point.x * point.weight) / total,
      y: mean.y + (point.y * point.weight) / total,
    }),
    { x: 0, y: 0 },
  )
}

export const weightedRadius = (
  points: readonly { x: number; y: number; weight: number }[],
  center: Vec2,
) => {
  const total = points.reduce((sum, point) => sum + point.weight, 0)
  if (total <= 0) return 1
  const variance = points.reduce(
    (sum, point) => sum + point.weight * distance(point, center) ** 2,
    0,
  )
  return Math.sqrt(variance / total)
}

export const wrapAngle = (radians: number) => {
  let value = radians
  while (value > Math.PI) value -= Math.PI * 2
  while (value < -Math.PI) value += Math.PI * 2
  return value
}
