/** Development-only spatial prediction check. No source or world access here. */
export type Point = { x: number; y: number }
export type Four = [number, number, number, number]
export type Reading = { time: number; position: Point; heading: number; values: Four }
export type SensorTiming = { tau: number; delay: number }
const finite = (x: number) => Number.isFinite(x)
const validFour = (x: Four) => x.length === 4 && x.every(finite)
export const four = (value: number): Four => [value, value, value, value]

/** Exact first-order integration of a delayed zero-order-held input history.
 * Input supplied at t affects only t+delay onward. Readout noise is external.
 * Internal state never resets at a robot movement or observation boundary.
 */
export class DelayedFourSensor {
  private time: number
  private output: Four
  private input: Four
  private events: { time: number; values: Four }[] = []
  constructor(private timing: SensorTiming, startTime = 0,
    initialOutput: Four = four(0), initialInput: Four = four(0)) {
    if (!finite(timing.tau) || timing.tau <= 0 || !finite(timing.delay) || timing.delay < 0 ||
      !finite(startTime) || !validFour(initialOutput) || !validFour(initialInput)) throw new RangeError('Invalid sensor initialization')
    this.timing = { ...timing }; this.time = startTime
    this.output = [...initialOutput]; this.input = [...initialInput]
  }
  private integrate(until: number) {
    const attenuation = Math.exp(-(until - this.time) / this.timing.tau)
    this.output = this.output.map((v, i) => this.input[i]! + (v - this.input[i]!) * attenuation) as Four
    this.time = until
  }
  advance(time: number, input: Four): Four {
    if (!finite(time) || time < this.time || !validFour(input)) throw new RangeError('Invalid sensor input/time')
    while (this.events.length && this.events[0]!.time <= time) {
      const event = this.events.shift()!
      this.integrate(event.time); this.input = event.values
    }
    this.integrate(time)
    if (this.timing.delay === 0) this.input = [...input]
    else this.events.push({ time: time + this.timing.delay, values: [...input] })
    return [...this.output]
  }
}

/** Front, left, aft, right. Mouth spacing is not a suction radius. */
export const inletPositions = (position: Point, heading: number, spacing: number): Point[] => {
  if (!finite(position.x) || !finite(position.y) || !finite(heading) || !finite(spacing) || spacing <= 0)
    throw new RangeError('Invalid inlet geometry')
  return [0, Math.PI / 2, Math.PI, -Math.PI / 2].map(a => ({
    x: position.x + spacing / 2 * Math.cos(heading + a),
    y: position.y + spacing / 2 * Math.sin(heading + a),
  }))
}
export type SpatialFit = { origin: Point; concentration: number; gradient: Point;
  direction: Point | null; time: number; lastValues: Four; trainingResidual: number }

/** Fixed-pose least-squares plane. This is a transparent new reference estimator,
 * not M36/M40 relabelled or a source-bearing estimator. */
export const fitSpatialPlane = (readings: Reading[], spacing: number, minimumContrast: number): SpatialFit => {
  if (!readings.length || !finite(minimumContrast) || minimumContrast < 0) throw new RangeError('Invalid fit settings')
  const last = readings.at(-1)!
  inletPositions(last.position, last.heading, spacing)
  if (readings.some((r, i) => !finite(r.time) || !validFour(r.values) ||
    !finite(r.position.x) || !finite(r.position.y) || !finite(r.heading) ||
    Math.hypot(r.position.x-last.position.x, r.position.y-last.position.y) > 1e-10 ||
    Math.abs(r.heading-last.heading) > 1e-10 || (i > 0 && r.time <= readings[i-1]!.time)))
    throw new RangeError('Fit requires chronological fixed-pose readings')
  const means = four(0).map((_, i) => readings.reduce((s, r) => s + r.values[i]!, 0) / readings.length) as Four
  const concentration = means.reduce((a,b) => a+b, 0) / 4
  const gx = (means[0]-means[2])/spacing, gy = (means[1]-means[3])/spacing
  const c = Math.cos(last.heading), s = Math.sin(last.heading)
  const gradient = { x: gx*c-gy*s, y: gx*s+gy*c }
  const norm = Math.hypot(gradient.x, gradient.y)
  const direction = norm*spacing > minimumContrast ? { x: gradient.x/norm, y: gradient.y/norm } : null
  const fit = { origin: { ...last.position }, concentration, gradient, direction, time: last.time,
    lastValues: [...last.values] as Four, trainingResidual: 0 }
  const predictions = predictInlets(fit, last.position, last.heading, spacing)
  fit.trainingResidual = Math.max(...means.map((v,i) => Math.abs(v-predictions[i]!)))
  return fit
}
export const predictInlets = (fit: SpatialFit, position: Point, heading: number, spacing: number): Four =>
  inletPositions(position, heading, spacing).map(p => fit.concentration +
    fit.gradient.x*(p.x-fit.origin.x) + fit.gradient.y*(p.y-fit.origin.y)) as Four

export type CheckResult = { accepted: boolean; reason: string; maximumError: number | null;
  threshold: number; observedMean: Four | null; predictedMean: Four | null }
/** Engineering tolerance, not a statistical confidence interval or proof. */
export const assessSpatialPrediction = (fit: SpatialFit, observed: Reading[], predicted: Reading[], threshold: number): CheckResult => {
  if (!finite(threshold) || threshold <= 0) throw new RangeError('Invalid prediction tolerance')
  const empty = (reason: string): CheckResult => ({ accepted: false, reason, maximumError: null,
    threshold, observedMean: null, predictedMean: null })
  if (!fit.direction) return empty('no-directional-contrast')
  if (fit.trainingResidual > threshold) return empty('initial-model-mismatch')
  if (!observed.length || observed.length !== predicted.length) return empty('invalid-check-history')
  if (observed.some((r,i) => !finite(r.time) || r.time <= fit.time ||
    !validFour(r.values) || !validFour(predicted[i]!.values) || r.time !== predicted[i]!.time ||
    (i>0 && r.time<=observed[i-1]!.time) || !finite(r.heading) || r.heading !== predicted[i]!.heading ||
    !finite(r.position.x) || !finite(r.position.y) || r.position.x !== predicted[i]!.position.x ||
    r.position.y !== predicted[i]!.position.y)) return empty('invalid-check-history')
  const mean = (rs: Reading[]) => four(0).map((_,i) => rs.reduce((s,r)=>s+r.values[i]!,0)/rs.length) as Four
  const observedMean = mean(observed), predictedMean = mean(predicted)
  const maximumError = Math.max(...observedMean.map((v,i)=>Math.abs(v-predictedMean[i]!)))
  return { accepted: maximumError <= threshold,
    reason: maximumError <= threshold ? 'prediction-consistent' : 'prediction-mismatch',
    maximumError, threshold, observedMean, predictedMean }
}

/** Offline diagnostic inputs only; unavailable true plume scales never enter a decision. */
export const spatialRegimeRatios = (p: { spacing: number; footprint: number; feature: number;
  tau: number; delay: number; speed: number; dwell: number; correlationTime: number; sampleInterval: number }) => {
  if ([p.spacing,p.feature,p.tau,p.dwell,p.correlationTime,p.sampleInterval].some(v=>!finite(v)||v<=0) ||
    [p.footprint,p.delay,p.speed].some(v=>!finite(v)||v<0)) throw new RangeError('Invalid regime scales')
  return { spacingToFeature: p.spacing/p.feature, footprintToFeature: p.footprint/p.feature,
    memoryToCorrelation: (p.tau+p.delay)/p.correlationTime,
    motionMemoryToFeature: p.speed*(p.tau+p.delay)/p.feature,
    dwellToCorrelation: p.dwell/p.correlationTime, samplingToCorrelation: p.sampleInterval/p.correlationTime }
}
