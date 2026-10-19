import { contrastAwareTimeDecision, makeM24Sensor, m24Passive, m24Scan } from './m24-time-aware'
import { M30_DESIGN, runM30, type M30ViewAcquisition } from './m30-move-resense'
import { summarizeM32Run } from './m32-contrast-aware-development'

type Sensor = ReturnType<typeof makeM24Sensor>
const previousFraction = new WeakMap<Sensor, number>()
const chooseFraction = (observed: number) => observed >= 1.35 ? 0.25 : observed >= 0.95 ? 0.5 : 1
const applyFraction = (sensor: Sensor, fraction: number) => {
  const previous = previousFraction.get(sensor) ?? 1
  const ratio = fraction / previous
  for (const channel of Object.keys(sensor.quadSensorStates)) sensor.quadSensorStates[channel] *= ratio
  previousFraction.set(sensor, fraction)
}
const adaptiveViews = (startTime: number, warmup: number): M30ViewAcquisition => (sensor, field, body, origin) => {
  const views = [0, 1, 2, 3].map((slot) => {
    const start = startTime + slot
    const passive = m24Passive(sensor, field, slot === 0 ? start - warmup * 0.25 : start - 0.5, slot === 0 ? warmup : 2, origin)
    const fraction = chooseFraction(passive?.concentration ?? 0)
    applyFraction(sensor, fraction)
    const heading = body + slot * Math.PI / 2
    return { heading, time: start + 0.5, values: m24Scan(sensor, field, start, heading, origin, fraction) }
  })
  return views
}

export const m33InitialViews = adaptiveViews(8, 32)
export const m33FreshViews = adaptiveViews(M30_DESIGN.resenseStartTime, 2)
export const M33_DESIGN = { calibrationSeedBase: 70000, episodeSeedBase: 10000000,
  fractions: [1, 0.5, 0.25], thresholds: [0.95, 1.35], developmentOnly: true,
  reducedOrderAcquisition: true, heldOutConfirmationRequired: true } as const

export const runM33 = () => {
  const seeds = { calibrationSeedBase: M33_DESIGN.calibrationSeedBase, episodeSeedBase: M33_DESIGN.episodeSeedBase }
  const legacy = runM30({}, seeds)
  const contrastOnly = runM30({}, { ...seeds, decision: contrastAwareTimeDecision })
  const adaptive = runM30({}, { ...seeds, decision: contrastAwareTimeDecision,
    initialAcquisition: m33InitialViews, freshAcquisition: m33FreshViews })
  return { complete: true, design: M33_DESIGN, legacy: summarizeM32Run(legacy),
    contrastOnly: summarizeM32Run(contrastOnly), adaptive: summarizeM32Run(adaptive) }
}
