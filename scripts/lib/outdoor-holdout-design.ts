import {DESIGN} from './outdoor-detectability'
import type {TraceSpec} from './outdoor-detectability'

export const HOLDOUT = {
  version: 'outdoor-detectability-holdout-v1', worlds: [1000, 1127],
  witnessWorlds: [1000, 1042, 1085, 1127], primaryHistories: 512, totalHistories: 544,
  independentWorlds: 128, primaryOutcomes: 36864,
  primaryContrast: {noisePpm: 0.2, fastRiseSeconds: 0.5, slowRiseSeconds: 5,
    wind: 0.5, speed: 1, rateKgPerSecond: 1e-4, k: 5, direction: 'fast-minus-slow'},
  bootstrap: {seed: 2230922, resamples: 10000, generator: 'numpy-PCG64',
    intervalQuantiles: [0.0125, 0.9875], endpoints: ['alarm-fraction', 'restricted-time-seconds'],
    interpretation: 'Nominal Bonferroni-adjusted 97.5% percentile intervals for two endpoints; bootstrap coverage is approximate.'},
  targets: {pod: 0.9, falseAlarm: 0.05, interval: 'pointwise-Wilson-95-not-simultaneous'},
  sourceProbeOffsetsMetres: [[0, 0], [0.25, 0], [1, 0], [0, 0.25]],
  sourceProbeTimesSeconds: [0.125, 600.125], workers: 4, maxRuntimeSeconds: 3600,
  physicalValidation: false, paidLaunchAuthorized: false,
} as const

export function holdoutSpecs(mode: 'smoke' | 'campaign'): TraceSpec[] {
  if (mode !== 'smoke' && mode !== 'campaign') throw Error('Unknown holdout mode')
  const worlds = mode === 'smoke' ? [0] : Array.from({length: 128}, (_, i) => i + 1000)
  return worlds.flatMap(world => DESIGN.windSpeeds.flatMap(wind => DESIGN.robotSpeeds.flatMap(speed =>
    (mode === 'campaign' && HOLDOUT.witnessWorlds.includes(world as 1000 | 1042 | 1085 | 1127) ? [0, 1, 2] : [0])
      .map(resolution => ({world, wind, speed, resolution})))))
}
