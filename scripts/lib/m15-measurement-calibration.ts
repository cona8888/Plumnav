import { createQuadSniffEvent, integrateQuadSniffEvent, quadSniffEffectiveSampleCount, quadSniffStatusAt, type QuadSniffEvent } from '../../src/sim/quadSniff'
import { SeededRandom, hashNumbers } from '../../src/sim/rng'
import type { PlumeModel } from '../../src/sim/plume'
import { designInverse, evaluateMultiView, MULTIVIEW_POLICY, quadMomentRows, type LocalCentralSample, type LocalQuadSample } from './multiview-source-evidence'
import { exactField, M15_CALIBRATION as c, type CalibrationJob } from './m15-manufactured-fields'

const clampSensor = (v: number) => Math.min(c.saturation, Math.max(0, v))
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0)
const dot = (a: number[], b: number[]) => sum(a.map((v, i) => v * b[i]!))
export const openCalibrationMap = () => false
export type CalibrationObservations = { job: CalibrationJob; central: LocalCentralSample[]; scans: LocalQuadSample[];
  budget: { horizon: number; cycles: number; samplingSeconds: number; turningSeconds: number; pathLength: number } }

/** Forward observations use the actual kernel/integrator, never inverse rows.
 * Only concentrationAt is read by these two forward helpers. */
export const simulateCalibration = (job: CalibrationJob): CalibrationObservations => {
  const plume = { concentrationAt: (p: { x: number; y: number }, t: number) => exactField(job.field, p, t).concentration } as PlumeModel
  const rng = new SeededRandom(hashNumbers(job.seed, 9173))
  const central: LocalCentralSample[] = []; const scans: LocalQuadSample[] = []
  let event: QuadSniffEvent | null = null; let slot = 0; let centralState = 0
  const states = [0, 0, 0, 0]
  const centralAlpha = job.delivery === 'sensor' ? 1 - Math.exp(-c.dt / c.sensorLag) : 1
  const channelAlpha = job.delivery === 'sensor' ? 1 - Math.exp(-c.cycleSeconds / c.sensorLag) : 1
  const createEvent = (time: number, index: number) => {
    const angle = c.bearing + (job.policy === 'sniff-turn' && index % 2 ? Math.PI / 4 : 0)
    return createQuadSniffEvent({ command: { scanId: index + 1, forward: { x: Math.cos(angle), y: Math.sin(angle) } },
      origin: job.anchor, time, strengthScale: c.strength, samplingMode: job.sensing, passiveArrayRadius: job.reach,
      cycleSeconds: c.cycleSeconds, reachForDirection: () => job.reach, plume, isBlocked: openCalibrationMap })!
  }
  for (let tick = 0; tick < c.durationSeconds / c.dt; tick++) {
    const time = tick * c.dt
    if (event) {
      integrateQuadSniffEvent(event, time, plume)
      if (time >= event.startedAt + c.cycleSeconds) {
        const midpoint = job.delivery === 'midpoint' ? createEvent(event.startedAt + c.cycleSeconds / 2, slot - 1) : event
        const n = quadSniffEffectiveSampleCount(event)
        const readings = event.latentChannels.map((channel, i) => {
          const target = Math.max(0, midpoint.latentChannels[i]!.latentConcentration + rng.normal(0, job.noise / Math.sqrt(n)))
          states[i]! += (target - states[i]!) * channelAlpha
          const concentration = clampSensor(states[i]!)
          const { channel: id, direction, reach, support, effectiveOffset, integrationSamples } = channel
          return { channel: id, direction, reach, support, effectiveOffset, integrationSamples,
            effectiveIntegrationSamples: n, concentration, hit: concentration >= 0.1, saturated: concentration >= c.saturation - 1e-9 }
        })
        scans.push({ time, position: { ...job.anchor }, cycleSeconds: c.cycleSeconds,
          quad: { ...quadSniffStatusAt(event, time), readings } })
        event = null
      }
    } else {
      const truth = exactField(job.field, job.anchor, time).concentration
      for (let i = 0; i < 4; i++) states[i]! += (Math.max(0, truth) - states[i]!) * centralAlpha
      centralState += (Math.max(0, truth + rng.normal(0, job.noise)) - centralState) * centralAlpha
      central.push({ time, position: { ...job.anchor }, concentration: clampSensor(centralState) })
    }
    // The engine senses wind after concentration or during blanking. Preserve
    // its RNG cadence even though this controlled experiment has exact wind.
    rng.normal(0, 0); rng.normal(0, 0)
    if (!event && slot < c.scans && time === c.firstScan + c.interval * slot) { event = createEvent(time, slot); slot++ }
  }
  if (slot !== 12 || scans.length !== 12 || scans.some((s, i) => s.time !== c.firstScan + c.interval * i + c.cycleSeconds)) throw new Error('Calibration schedule failed')
  return { job, central, scans, budget: { horizon: 40, cycles: 12, samplingSeconds: 9,
    turningSeconds: job.policy === 'sniff-turn' ? 5.5 : 0, pathLength: 0 } }
}

export const calibrationInput = (observations: CalibrationObservations, time: number, window: number) => ({
  anchor: observations.job.anchor, time,
  central: observations.central.filter((s) => s.time >= time - window && s.time <= time),
  scans: observations.scans.filter((s) => s.time >= time - window && s.time <= time),
  wind: c.wind, diffusivity: c.diffusivity, sensorNoise: observations.job.noise,
  sensorSaturation: c.saturation, isBlocked: openCalibrationMap,
})
/** Unthresholded error diagnostic only. Never used to accept a source. */
export const diagnoseFit = (input: ReturnType<typeof calibrationInput>) => {
  const h = MULTIVIEW_POLICY.spatialScale; const tau = MULTIVIEW_POLICY.temporalScaleSeconds
  const central = input.central.filter((s) => s.concentration >= 0 && s.concentration < c.saturation)
  const rows = central.map((s) => ({ x: [1, 0, 0, 0, 0, 0, (s.time - input.time) / tau], y: s.concentration }))
  for (const s of input.scans) for (const r of quadMomentRows(s, input.anchor, input.time, openCalibrationMap)) {
    if (r.concentration < c.saturation) rows.push({ x: r.x, y: r.concentration })
  }
  const d = designInverse(rows.map((r) => r.x))
  const ops = [[1, 0, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 1, 0, 1, 0], [0, 0, 0, 0, 0, 0, 1]]
  if (!ops.every(d.estimable)) return null
  const b = d.inv.map((row) => sum(rows.map((r) => dot(row, r.x) * r.y)))
  const gradient = { x: b[1]! / h, y: b[2]! / h }
  const laplacian = (b[3]! + b[5]!) / h ** 2; const temporal = b[6]! / tau
  return { center: b[0]!, gradient, laplacian, temporal,
    residual: temporal + dot([c.wind.x, c.wind.y], [gradient.x, gradient.y]) - c.diffusivity * laplacian,
    condition: d.condition, fitRms: Math.sqrt(sum(rows.map((r) => (r.y - dot(r.x, b)) ** 2)) / rows.length) }
}
export const analyzeCalibration = (observations: CalibrationObservations) => c.windows.map((window) => {
  const records = observations.scans.map((scan) => {
    const input = calibrationInput(observations, scan.time, window)
    const evidence = evaluateMultiView(input); const fit = diagnoseFit(input)
    const truth = exactField(observations.job.field, observations.job.anchor, scan.time)
    if (evidence.nominalResidual !== null && (!fit || Math.abs(fit.residual - evidence.nominalResidual) > 1e-8)) throw new Error('Diagnostic fit differs from frozen scorer')
    return { time: scan.time, evidence, fit, truth }
  })
  const final = records.slice(-6)
  const valid = final.filter((r): r is typeof r & { fit: NonNullable<typeof r.fit> } => r.fit !== null)
  const rms = (values: number[]) => values.length ? Math.sqrt(sum(values.map((v) => v * v)) / values.length) : null
  const error = (key: 'laplacian' | 'temporal' | 'residual') => rms(valid.map((r) => r.fit[key] - r.truth[key]))
  return { window, records, summary: {
    finalCount: final.length, identifiable: final.filter((r) => r.evidence.operatorIdentifiable).length,
    usable: final.filter((r) => r.evidence.usable).length, positive: final.filter((r) => r.evidence.positive).length,
    rawFits: valid.length, residualRmse: error('residual'), laplacianRmse: error('laplacian'), temporalRmse: error('temporal'),
    gradientRmse: rms(valid.map((r) => Math.hypot(r.fit.gradient.x - r.truth.gradient.x, r.fit.gradient.y - r.truth.gradient.y))),
    residualBias: valid.length ? sum(valid.map((r) => r.fit.residual - r.truth.residual)) / valid.length : null,
    reasons: Object.fromEntries([...new Set(final.map((r) => r.evidence.reason))].map((reason) => [reason, final.filter((r) => r.evidence.reason === reason).length])),
  } }
})
