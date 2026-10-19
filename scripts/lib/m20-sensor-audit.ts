import { SimulationEngine } from '../../src/sim/engine'
import { createDefaultConfig } from '../../src/sim/config'
import { SeededRandom } from '../../src/sim/rng'
import { createQuadSniffEvent, integrateQuadSniffEvent, quadSniffEffectiveSampleCount, quadSniffStatusAt, type QuadSniffEvent } from '../../src/sim/quadSniff'
import type { PlumeModel } from '../../src/sim/plume'
import type { Measurement, QuadSniffStatus } from '../../src/sim/types'

export const M20_DESIGN = { samples: 40000, levels: [0, 0.5, 1.5], lags: [0.05, 0.5, 2],
  correlations: [0, 0.5, 0.9], noise: 0.025, saturation: 1.5, cycle: 0.5, dt: 0.25,
  burnIn: 400, relativeTolerance: 0.08, correlationTolerance: 0.025, biasTolerance: 0.001,
  quadSeed: 20001, centralSeed: 21001, diagnosticOnly: true } as const
const channels = ['front', 'left', 'aft', 'right'] as const
/** Research-only access to the production sensor boundary, not a controller API. */
type SensorSeam = { rng: SeededRandom; sensorState: number; quadSensorStates: Record<typeof channels[number], number>;
  senseConcentration: (value: number, mode: 'passive') => Measurement;
  senseQuadConcentration: (event: QuadSniffEvent, status: QuadSniffStatus) => Measurement }
const engineFor = (lag: number, rho: number, seed: number, noise = 0.025, crossTalk = 0, gain = 0) => {
  const engine = new SimulationEngine({ ...createDefaultConfig('quad-sniff', 'open'), sensorLag: lag,
    sensorNoise: noise, sensorSaturation: 1.5, fixedDt: 0.25, windNoise: 0,
    sensorFalsePositiveRate: 0, sensorFalseNegativeRate: 0, quadChannelNoiseCorrelation: rho,
    quadChannelCrossTalk: crossTalk, quadChannelGainMismatch: gain, quadChannelLagMismatch: 0,
    stopOnNativeDeclaration: false })
  const seam = engine as unknown as SensorSeam
  seam.rng = new SeededRandom(seed)
  return seam
}
const eventFor = (levels: readonly number[]) => {
  const plume = { concentrationAt: () => 0.5 } as unknown as PlumeModel
  const event = createQuadSniffEvent({ command: { scanId: 1, forward: { x: 1, y: 0 } },
    origin: { x: 0.5, y: 0.5 }, time: 0, strengthScale: 0.78, samplingMode: 'active-suction',
    passiveArrayRadius: 0.0125, cycleSeconds: 0.5, reachForDirection: () => 0.0975,
    plume, isBlocked: () => false })!
  integrateQuadSniffEvent(event, 0.25, plume); integrateQuadSniffEvent(event, 0.5, plume)
  event.latentChannels.forEach((c, i) => { c.latentConcentration = levels[i]! })
  if (Math.abs(quadSniffEffectiveSampleCount(event) - 8 / 3) > 1e-12) throw new Error('Integration calibration changed')
  return event
}
const resetQuad = (engine: SensorSeam, value: number) => {
  for (const c of channels) engine.quadSensorStates[c] = value
}
export const quadWitness = (level: number, lag: number, rho: number, seed: number, samples: number = M20_DESIGN.samples) => {
  const engine = engineFor(lag, rho, seed); const event = eventFor(channels.map(() => level))
  const status = quadSniffStatusAt(event, 0.5)
  const sums = [0, 0, 0, 0]; const products = Array.from({ length: 4 }, () => [0, 0, 0, 0])
  let zero = 0; let saturated = 0; let contrastSum = 0; let contrastSquares = 0
  for (let k = 0; k < samples; k++) {
    resetQuad(engine, level)
    const values = engine.senseQuadConcentration(event, status).quadSniff!.readings!.map((r) => r.concentration)
    for (let i = 0; i < 4; i++) {
      const v = values[i]!; sums[i]! += v
      zero += Number(v === 0); saturated += Number(v === 1.5)
      for (let j = 0; j < 4; j++) products[i]![j]! += v * values[j]!
    }
    const contrast = values[0]! - values[2]!
    contrastSum += contrast; contrastSquares += contrast * contrast
  }
  const means = sums.map((s) => s / samples)
  const covariance = products.map((row, i) => row.map((v, j) => v / samples - means[i]! * means[j]!))
  const alpha = 1 - Math.exp(-0.5 / lag); const variance = alpha ** 2 * 0.025 ** 2 / (8 / 3)
  return { level, lag, rho, seed, samples, means, covariance,
    contrastMean: contrastSum / samples, contrastVariance: contrastSquares / samples - (contrastSum / samples) ** 2,
    zeroFraction: zero / (4 * samples), saturatedFraction: saturated / (4 * samples),
    interiorPrediction: { variance, covariance: rho * variance, contrastVariance: 2 * variance * (1 - rho) },
    zeroMeanPrediction: alpha * 0.025 / Math.sqrt(2 * Math.PI * (8 / 3)) }
}
export const centralWitness = (lag: number, seed: number, samples: number = M20_DESIGN.samples) => {
  const engine = engineFor(lag, 0, seed); engine.sensorState = 0.5
  let previous = 0; let sum = 0; let squares = 0; let pairs = 0; let first = 0
  for (let k = -M20_DESIGN.burnIn; k < samples; k++) {
    const value = engine.senseConcentration(0.5, 'passive').concentration - 0.5
    if (k >= 0) { sum += value; squares += value * value; if (k > 0) pairs += value * previous; else first = value }
    previous = value
  }
  const mean = sum / samples; const variance = squares / samples - mean ** 2
  const covariance = pairs / (samples - 1) - ((sum - first) / (samples - 1)) * ((sum - previous) / (samples - 1))
  const alpha = 1 - Math.exp(-0.25 / lag)
  return { lag, seed, samples, mean, variance, correlation: covariance / variance,
    predictedVariance: 0.025 ** 2 * alpha / (2 - alpha), predictedCorrelation: 1 - alpha,
    oneUpdateStepBiasFromZeroToHalf: -0.5 * (1 - alpha) }
}
export const biasWitnesses = () => {
  const alpha = 1 - Math.exp(-10)
  const run = (levels: number[], crossTalk: number, gain: number) => {
    const engine = engineFor(0.05, 0, 22001, 0, crossTalk, gain); resetQuad(engine, 0.5)
    const event = eventFor(levels)
    const readings = engine.senseQuadConcentration(event, quadSniffStatusAt(event, 0.5)).quadSniff!.readings!
    return readings[0]!.concentration - readings[2]!.concentration
  }
  return { crossTalk: [0, 0.35, 1].map((value) => ({ value, contrast: run([0.52, 0.5, 0.48, 0.5], value, 0), expected: alpha * (1 - value) * 0.04 })),
    gainMismatch: { value: 0.2, falseContrast: run([0.5, 0.5, 0.5, 0.5], 0, 0.2), expected: alpha * 0.05 } }
}
export const runM20 = () => {
  const quad = []; let index = 0
  for (const level of M20_DESIGN.levels) for (const lag of M20_DESIGN.lags) for (const rho of M20_DESIGN.correlations)
    quad.push(quadWitness(level, lag, rho, M20_DESIGN.quadSeed + index++))
  return { complete: true, design: M20_DESIGN, quad,
    central: M20_DESIGN.lags.map((lag, i) => centralWitness(lag, M20_DESIGN.centralSeed + i)), biases: biasWitnesses(),
    plumeTrajectories: 0, algorithmPromoted: false }
}
