import { percentile } from './math'

export type CurtainPosition = { eastMetres: number; northMetres: number }
export type CurtainSample = CurtainPosition & { methanePpm: number }
/** Components point towards the direction of transport in a local geographic east/north frame. */
export type CurtainWind = { eastMetresPerSecond: number; northMetresPerSecond: number; angularSpreadDegrees: number }
export type CurtainBearing =
  | { status: 'abstain'; sourcePoint: null; reason: string }
  | { status: 'bearing'; sourcePoint: null; crossing: CurtainPosition; upwindBearingDegrees: number;
      windSpreadDegrees: number; crosswindWidthMetres: number; contrastThresholdPpm: number }

/** One survey plane can constrain the transverse location of a plume, but not source range. */
export function estimateCurtainBearing(samples: readonly CurtainSample[], wind: CurtainWind,
  minimumEnhancementPpm = 0.05): CurtainBearing {
  const abstain = (reason: string): CurtainBearing => ({ status: 'abstain', sourcePoint: null, reason })
  if (!Number.isFinite(minimumEnhancementPpm) || minimumEnhancementPpm <= 0) throw new RangeError('Positive methane contrast floor required')
  if (![wind.eastMetresPerSecond, wind.northMetresPerSecond, wind.angularSpreadDegrees].every(Number.isFinite) ||
      wind.angularSpreadDegrees < 0 || wind.angularSpreadDegrees > 180) throw new RangeError('Invalid horizontal wind or angular spread')
  const speed = Math.hypot(wind.eastMetresPerSecond, wind.northMetresPerSecond)
  if (speed < 0.3 || wind.angularSpreadDegrees >= 45) return abstain('weak or variable wind')
  const east = wind.eastMetresPerSecond / speed, north = wind.northMetresPerSecond / speed
  const points = samples.map(s => {
    if (![s.eastMetres, s.northMetres, s.methanePpm].every(Number.isFinite)) throw new RangeError('Invalid curtain reading')
    return { along: s.eastMetres * east + s.northMetres * north,
      across: s.eastMetres * north - s.northMetres * east, signal: s.methanePpm }
  })
  const bins = Array.from({ length: 12 }, () => [] as typeof points)
  if (points.length < 2 * bins.length) return abstain('too few observations')
  const across = points.map(p => p.across), along = points.map(p => p.along)
  // Use spreads resistant to an isolated off-plane position for the geometry check.
  const span = percentile(across, 0.9) - percentile(across, 0.1)
  if (span < 4 || percentile(along, 0.9) - percentile(along, 0.1) > 0.75 * span) return abstain('insufficient crosswind traverse')
  let low = Infinity, high = -Infinity
  for (const x of across) { low = Math.min(low, x); high = Math.max(high, x) }
  const width = (high - low) / bins.length
  for (const p of points) bins[Math.min(bins.length - 1, Math.floor((p.across - low) / width))]!.push(p)
  if (bins.some(b => b.length < 2)) return abstain('gaps in crosswind sampling')
  // Equal-width bins give each part of the traverse equal lateral support.
  const profile = bins.map(b => percentile(b.map(p => p.signal), 0.75))
  const flanks = [...profile.slice(0, 2), ...profile.slice(-2)]
  const background = percentile(flanks, 0.5)
  const mad = percentile(flanks.map(v => Math.abs(v - background)), 0.5)
  const threshold = Math.max(minimumEnhancementPpm, 3 * 1.4826 * mad)
  const enhanced = profile.flatMap((v, i) => v > background + threshold ? [i] : [])
  if (enhanced.length < 2) return abstain('insufficient sustained methane contrast')
  const first = enhanced[0]!, last = enhanced[enhanced.length - 1]!
  if (first < 2 || last >= bins.length - 2 || last - first + 1 !== enhanced.length) return abstain('unbracketed or multiple enhancements')
  let sum = 0, crossingAcross = 0, crossingAlong = 0
  for (const i of enhanced) {
    const weight = profile[i]! - background
    sum += weight
    crossingAcross += weight * percentile(bins[i]!.map(p => p.across), 0.5)
    crossingAlong += weight * percentile(bins[i]!.map(p => p.along), 0.5)
  }
  return { status: 'bearing', sourcePoint: null,
    crossing: { eastMetres: (crossingAlong * east + crossingAcross * north) / sum,
      northMetres: (crossingAlong * north - crossingAcross * east) / sum },
    upwindBearingDegrees: (Math.atan2(-east, -north) * 180 / Math.PI + 360) % 360,
    windSpreadDegrees: wind.angularSpreadDegrees,
    crosswindWidthMetres: enhanced.length * width, contrastThresholdPpm: threshold }
}
