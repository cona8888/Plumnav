import { distance } from '../math'
import type { Observation, Vec2 } from '../types'

export type SourceConfirmation = {
  estimate: Vec2
  peakConcentration: number
  localSamples: number
  candidateSeparation: number
}

/**
 * Independent, observation-only terminal check shared by the Bayesian methods.
 *
 * A contracted binary-contact posterior is not enough for the simulator's
 * strict 1% declaration. The robot must also have physically sampled a sharp,
 * high concentration peak close to its candidate. This uses filtered sensor
 * output and robot pose only; neither plume truth nor source coordinates cross
 * the controller boundary.
 */
export const confirmSourceFromConcentration = (
  observations: readonly Observation[],
  candidate: Vec2,
): SourceConfirmation | null => {
  let peak: Observation | undefined
  for (const observation of observations) {
    if (!peak || observation.concentration > peak.concentration) peak = observation
  }
  if (!peak || peak.concentration < 0.8) return null

  const candidateSeparation = distance(peak.position, candidate)
  if (candidateSeparation > 0.045) return null

  const localSamples = observations.filter(
    (observation) =>
      distance(observation.position, peak.position) <= 0.035 &&
      observation.concentration >= peak.concentration * 0.52,
  ).length
  if (localSamples < 3) return null

  return {
    estimate: { ...peak.position },
    peakConcentration: peak.concentration,
    localSamples,
    candidateSeparation,
  }
}
