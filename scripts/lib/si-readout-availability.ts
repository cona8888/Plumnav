import type {Measurement} from '../../src/sim/types'

export const READOUT_AVAILABILITY_VERSION = 'stationary-scan-readout-v1' as const
export type ReadoutAvailability = 'original-withheld' | 'live-passive'

/** A data-availability intervention, not a new gas sample or response filter.
 * The continuously running instrument already acquired these four channels.
 * The raw scan clock remains authoritative for motion, draining and completion.
 */
export function exposeScanReadout(raw:Measurement, availability:ReadoutAvailability):Measurement {
  if (!['original-withheld', 'live-passive'].includes(availability)) throw Error('Unknown readout availability')
  if (availability === 'original-withheld' || raw.sampleMode !== 'blanked' || !Number.isInteger(raw.time)) return raw
  if (!raw.quadSniff || raw.quadSniff.phase !== 'aspirate' || raw.quadSniff.samplingMode !== 'passive-array') {
    throw Error('Live scan readout requires an unfinished independent passive-array event')
  }
  if (raw.valid || raw.localInletReadings?.length !== 4 ||
      new Set(raw.localInletReadings.map(r => r.channel)).size !== 4 ||
      raw.localInletReadings.some(r => !Number.isFinite(r.concentration)) || !Number.isFinite(raw.concentration)) {
    throw Error('Malformed raw scan measurement')
  }
  // Keep the passive scalar trigger unchanged. The return still uses the frozen
  // four-channel return trigger, mode and matching scan ID, exactly once.
  return {...raw, valid:true, hit:raw.concentration >= .115, sampleMode:'passive'}
}

export function scanBlocksMotion(raw:Measurement, accepted:boolean):boolean {
  return raw.sampleMode === 'blanked' || accepted
}

export function scanCanDrain(raw:Measurement):boolean {
  return raw.sampleMode !== 'blanked'
}
