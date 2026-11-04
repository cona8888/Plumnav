import { createDefaultConfig } from '../src/sim/config'
import { LocalInletChannel, withLocalInletDesign } from '../src/sim/localInletSampling'
import { GSL_REFERENCE_DESIGN, tubeTransportSeconds, type GslPhysicalDesign } from '../src/sim/physicalDesign'
import { SeededRandom } from '../src/sim/rng'
import type { LocalInletSamplingConfig, SimulationConfig } from '../src/sim/types'
import { channelReference } from './lib/channel-reference'
import { SI_HALFSPACE_REFERENCE, withSIResearchDesign } from './lib/si-research-config'

export type BenchSample = { time: number; inletPpm: number; measuredPpm: number }
const benchKeys = ['tubeLengthMetres', 'tubeInnerDiameterMetres', 'actualFlowLitresPerMinute', 'averagingSeconds'] as const
type BenchSetup = Pick<GslPhysicalDesign, (typeof benchKeys)[number]>
type Response = { riseSeconds: number; recoverySeconds: number }
type InletFit = Response & { setup: BenchSetup }
const defaultRecoverySeconds = 2 // Existing SI design's default recovery constant.
const defaultTurnRate = Math.PI / 4

export function benchSetup(design: BenchSetup): BenchSetup {
  return { tubeLengthMetres: design.tubeLengthMetres, tubeInnerDiameterMetres: design.tubeInnerDiameterMetres,
    actualFlowLitresPerMinute: design.actualFlowLitresPerMinute, averagingSeconds: design.averagingSeconds }
}

function checkTrace(samples: BenchSample[]) {
  if (samples.length < 4 || samples[0].time !== 0 || samples[0].inletPpm !== 0) {
    throw new Error('Start the trace at zero time with a clean inlet and a settled, zeroed sensor')
  }
  let rise = false
  let fall = false
  for (const [i, s] of samples.entries()) {
    if (![s.time, s.inletPpm, s.measuredPpm].every(Number.isFinite) || s.inletPpm < 0 ||
        (i > 0 && s.time <= samples[i - 1].time)) throw new Error('Invalid bench concentration or timestamp')
    if (i > 0) {
      rise ||= s.inletPpm > samples[i - 1].inletPpm
      fall ||= s.inletPpm < samples[i - 1].inletPpm
    }
  }
  if (!rise || !fall) throw new Error('Each trace must include both rising and falling inlet steps')
}

export function parseBenchCsv(contents: string): BenchSample[] {
  const [header, ...rows] = contents.trim().split(/\r?\n/)
  if (header.trim() !== 'time_s,inlet_ppm,measured_ppm') throw new Error('Expected time_s,inlet_ppm,measured_ppm')
  const samples = rows.map(row => {
    const fields = row.split(',').map(v => v.trim())
    if (fields.length !== 3 || fields.includes('')) throw new Error('Expected three numeric fields per row')
    const [time, inletPpm, measuredPpm] = fields.map(Number)
    return { time, inletPpm, measuredPpm }
  })
  checkTrace(samples)
  return samples
}

function channelSettings(design: GslPhysicalDesign) {
  return withLocalInletDesign(createDefaultConfig('quad-sniff-refine', 'open'), design, {
    recoveryTimeConstantSeconds: defaultRecoverySeconds, maximumTurnRateRadiansPerSecond: defaultTurnRate,
  }).localInletSampling!
}

function sumSquaredErrors(samples: BenchSample[], settings: LocalInletSamplingConfig, response: Response) {
  const channel = new LocalInletChannel({ ...settings, riseTimeConstantSeconds: response.riseSeconds,
    recoveryTimeConstantSeconds: response.recoverySeconds })
  let sum = 0
  for (const sample of samples) {
    sum += (channel.update(sample.time, sample.inletPpm) - sample.measuredPpm) ** 2
  }
  return sum
}

/** Fit the two time constants only. Geometry, flow, averaging and span stay fixed.
 * Search in log seconds so a rapid rise and a slow recovery have equal relative resolution. */
export function calibrateInlet(training: BenchSample[], design = GSL_REFERENCE_DESIGN): InletFit {
  checkTrace(training)
  const settings = channelSettings(design)
  const lo = Math.log(0.1)
  const hi = Math.log(60)
  let centreRise = (lo + hi) / 2
  let centreRecovery = centreRise
  let radius = (hi - lo) / 2
  let best = Infinity
  for (let pass = 0; pass < 5; pass++) {
    const step = radius / 4
    const gridRise = centreRise
    const gridRecovery = centreRecovery
    for (let i = -4; i <= 4; i++) {
      for (let j = -4; j <= 4; j++) {
        const r = Math.max(lo, Math.min(hi, gridRise + i * step))
        const f = Math.max(lo, Math.min(hi, gridRecovery + j * step))
        const error = sumSquaredErrors(training, settings, { riseSeconds: Math.exp(r), recoverySeconds: Math.exp(f) })
        if (error < best) {
          best = error
          centreRise = r
          centreRecovery = f
        }
      }
    }
    radius = step
  }
  if (!Number.isFinite(best) || [centreRise, centreRecovery].some(v => v <= lo + 1e-9 || v >= hi - 1e-9)) {
    throw new Error('Fit reached the 0.1–60 s search limit or failed; check the trace and model')
  }
  return { riseSeconds: Math.exp(centreRise), recoverySeconds: Math.exp(centreRecovery), setup: benchSetup(design) }
}

export function scoreResponse(trace: BenchSample[], response: Response, design = GSL_REFERENCE_DESIGN) {
  checkTrace(trace)
  return Math.sqrt(sumSquaredErrors(trace, channelSettings(design), response) / trace.length)
}

/** Rebuild inspection settling/dwell with the fit, preserving the SI instrument contract. */
export function withCalibratedSIInlet(base: SimulationConfig, fit: InletFit, design: GslPhysicalDesign,
  atmosphere = SI_HALFSPACE_REFERENCE, maximumTurnRateRadiansPerSecond = defaultTurnRate) {
  if (benchKeys.some(key => fit.setup[key] !== design[key])) throw new Error('Bench and mission inlet setups differ')
  return withSIResearchDesign(base, { ...design, sensorTimeConstantSeconds: fit.riseSeconds }, atmosphere,
    { recoveryTimeConstantSeconds: fit.recoverySeconds, maximumTurnRateRadiansPerSecond })
}

// Manufactured observations from an independent event-split RK4 integrator.
// The product model has the same transfer-function family. This tests recovery
// of known parameters with noise; it cannot establish hardware model adequacy.
export function syntheticBenchTraces() {
  const design = GSL_REFERENCE_DESIGN
  const delay = tubeTransportSeconds(design.tubeLengthMetres, design.tubeInnerDiameterMetres, design.actualFlowLitresPerMinute)
  const makeTrace = (changes: [number, number][], end: number, seed: number) => {
    let concentration = 0
    const steps = new Map(changes)
    const input = Array.from({ length: end + 1 }, (_, time) => {
      concentration = steps.get(time) ?? concentration
      return { time, value: concentration }
    })
    const ideal = channelReference(input, { delay, rise: 1.75, recovery: 3.5, average: design.averagingSeconds }, 0.02)
    const rng = new SeededRandom(seed)
    return input.map((s, i) => ({ time: s.time, inletPpm: s.value, measuredPpm: ideal[i] + rng.normal(0, 0.002) }))
  }
  return {
    training: makeTrace([[5, 0.8], [27, 0], [52, 1.2], [74, 0]], 99, 2011),
    holdout: makeTrace([[7, 0.35], [17, 0], [38, 0.95], [43, 0.58], [56, 0], [78, 0.48], [83, 0]], 107, 4057),
  }
}

export function runBenchCalibration(training: BenchSample[], holdout: BenchSample[], design = GSL_REFERENCE_DESIGN) {
  if (JSON.stringify(training) === JSON.stringify(holdout)) throw new Error('Training and holdout must be separate records')
  const fit = calibrateInlet(training, design)
  const baseline = { riseSeconds: design.sensorTimeConstantSeconds, recoverySeconds: defaultRecoverySeconds }
  return { fit, baseline, trainingSamples: training.length, holdoutSamples: holdout.length,
    trainingRmsePpm: scoreResponse(training, fit, design), holdoutRmsePpm: scoreResponse(holdout, fit, design),
    baselineHoldoutRmsePpm: scoreResponse(holdout, baseline, design) }
}
