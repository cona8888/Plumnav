export type DirectionView = { heading: number; values: number[] }
export type DirectionCalibration = { slopes: number[]; offsets: number[]; rawVariance: number; correctedVariance: number }
export type DirectionRule = 'raw' | 'calibrated' | 'rotation-consistent'
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length
const contrast = (v: number[]) => [v[0]! - v[2]!, v[3]! - v[1]!]
export const correctDirectionReadings = (v: number[], c: DirectionCalibration) => v.map((x, i) => (x - c.offsets[i]!) / c.slopes[i]!)
export const fitDirectionCalibration = (low: number[][], high: number[][]): DirectionCalibration => {
  if (low.length < 2 || high.length < 2 || [...low, ...high].some((v) => v.length !== 4 || !v.every(Number.isFinite))) throw new Error('Invalid reference readings')
  const lm = [0, 1, 2, 3].map((i) => mean(low.map((v) => v[i]!)))
  const hm = [0, 1, 2, 3].map((i) => mean(high.map((v) => v[i]!)))
  const slopes = hm.map((x, i) => (x - lm[i]!) / 0.5)
  const offsets = lm.map((x, i) => x - 0.25 * slopes[i]!)
  const c = { slopes, offsets, rawVariance: 0, correctedVariance: 0 }
  const variance = (correct: boolean) => [low, high].reduce((total, group) => {
    const pairs = group.map((v) => contrast(correct ? correctDirectionReadings(v, c) : v))
    return total + [0, 1].reduce((s, j) => { const m = mean(pairs.map((v) => v[j]!));
      return s + pairs.reduce((v, p) => v + (p[j]! - m) ** 2, 0) }, 0)
  }, 0) / (low.length + high.length - 2)
  c.rawVariance = variance(false); c.correctedVariance = variance(true)
  return c
}
export const directionDecision = (views: DirectionView[], calibration: DirectionCalibration, rule: DirectionRule) => {
  const abstain = (reason: string) => ({ direction: null as { x: number; y: number } | null, reason })
  if (views.length !== 4 || views.some((v) => !Number.isFinite(v.heading) || v.values.length !== 4 || v.values.some((x) => !Number.isFinite(x) || x <= 0.075 || x >= 1.425))) return abstain('boundary-or-incomplete')
  if (calibration.slopes.length !== 4 || calibration.offsets.length !== 4 || !calibration.offsets.every(Number.isFinite) || calibration.slopes.some((s) => !Number.isFinite(s) || s < 0.25 || s > 2)) return abstain('invalid-calibration')
  const variance = rule === 'raw' ? calibration.rawVariance : calibration.correctedVariance
  if (!Number.isFinite(variance) || variance < 0) return abstain('invalid-variance')
  const threshold = 3 * Math.sqrt(variance)
  const vectors = views.map((v) => {
    const [x, y] = contrast(rule === 'raw' ? v.values : correctDirectionReadings(v.values, calibration)) as [number, number]
    return { x: x * Math.cos(v.heading) - y * Math.sin(v.heading), y: x * Math.sin(v.heading) + y * Math.cos(v.heading) }
  })
  const x = mean(vectors.map((v) => v.x)); const y = mean(vectors.map((v) => v.y)); const norm = Math.hypot(x, y)
  if (!(norm > Math.max(threshold, 1e-12))) return abstain('weak-contrast')
  if (rule === 'rotation-consistent' && vectors.some((v) => {
    const n = Math.hypot(v.x, v.y)
    return n <= threshold || (v.x * x + v.y * y) / (n * norm) < Math.SQRT1_2
  })) return abstain('inconsistent-rotation')
  return { direction: { x: x / norm, y: y / norm }, reason: 'direction-only' }
}
