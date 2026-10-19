export class SeededRandom {
  private state: number
  private spareNormal: number | null = null

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9
  }

  next() {
    let value = (this.state += 0x6d2b79f5)
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }

  range(min: number, max: number) {
    return min + (max - min) * this.next()
  }

  integer(min: number, maxExclusive: number) {
    return Math.floor(this.range(min, maxExclusive))
  }

  normal(mean = 0, standardDeviation = 1) {
    if (this.spareNormal !== null) {
      const result = this.spareNormal
      this.spareNormal = null
      return mean + result * standardDeviation
    }
    const u = Math.max(1e-12, this.next())
    const v = this.next()
    const magnitude = Math.sqrt(-2 * Math.log(u))
    const first = magnitude * Math.cos(2 * Math.PI * v)
    this.spareNormal = magnitude * Math.sin(2 * Math.PI * v)
    return mean + first * standardDeviation
  }

  fork(label: number) {
    return new SeededRandom(hashNumbers(this.state, label))
  }
}

export const hashNumbers = (...values: number[]) => {
  let hash = 2166136261 >>> 0
  for (const value of values) {
    const scaled = Math.round(value * 1_000_003)
    hash ^= scaled
    hash = Math.imul(hash, 16777619)
    hash ^= hash >>> 13
  }
  return hash >>> 0
}

export const deterministicNoise = (...values: number[]) => {
  const hash = hashNumbers(...values)
  return (hash / 4294967295) * 2 - 1
}
