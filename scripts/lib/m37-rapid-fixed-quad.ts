import { makeM24Sensor, m24Passive, m24Scan } from './m24-time-aware'
import { runM30, type M30ViewAcquisition } from './m30-move-resense'
import { summarizeM32Run } from './m32-contrast-aware-development'
import { m35FreshViews } from './m35-staged-repeated-sniff'
import { m36QuadraticDecision } from './m36-quadratic-temporal'

type Sensor = ReturnType<typeof makeM24Sensor>
const previousFraction = new WeakMap<Sensor, number>()
const chooseFraction = (observed: number) => observed >= 1.35 ? 0.25 : observed >= 0.95 ? 0.5 : 1
const applyFraction = (sensor: Sensor, fraction: number) => {
  const ratio = fraction / (previousFraction.get(sensor) ?? 1)
  for (const channel of Object.keys(sensor.quadSensorStates)) sensor.quadSensorStates[channel] *= ratio
  previousFraction.set(sensor, fraction)
}
export const m37RapidFreshViews: M30ViewAcquisition = (sensor, field, body, origin) => {
  const passive = m24Passive(sensor, field, 12.5, 2, origin)
  const fraction = chooseFraction(passive?.concentration ?? 0)
  applyFraction(sensor, fraction)
  return [0, 1, 2, 3, 4, 5, 6, 7].map((slot) => {
    const start = 13 + 0.5 * slot
    return { heading: body, time: start + 0.5, intakeFraction: fraction,
      values: m24Scan(sensor, field, start, body, origin, fraction) }
  })
}

export const M37_DESIGN = { calibrationSeedBase: 78000, episodeSeedBase: 18000000,
  postMoveCycles: 8, cycleSeconds: 0.5, headingChanges: 0, resenseDecisionTime: 17,
  secondActionEndTime: 18, developmentOnly: true, heldOutConfirmationRequired: true } as const
export const runM37 = () => {
  const seeds = { calibrationSeedBase: M37_DESIGN.calibrationSeedBase, episodeSeedBase: M37_DESIGN.episodeSeedBase }
  const slowTiming = { resenseDecisionTime: 20.5, secondActionEndTime: 21.5 }
  const rapidTiming = { resenseDecisionTime: M37_DESIGN.resenseDecisionTime, secondActionEndTime: M37_DESIGN.secondActionEndTime }
  const legacy = runM30({}, seeds)
  const rotatingQuadratic = runM30({}, { ...seeds, ...slowTiming, freshAcquisition: m35FreshViews,
    freshDecision: m36QuadraticDecision })
  const rapidFixedQuadratic = runM30({}, { ...seeds, ...rapidTiming, freshAcquisition: m37RapidFreshViews,
    freshDecision: m36QuadraticDecision })
  return { complete: true, design: M37_DESIGN, legacy: summarizeM32Run(legacy),
    rotatingQuadratic: summarizeM32Run(rotatingQuadratic), rapidFixedQuadratic: summarizeM32Run(rapidFixedQuadratic) }
}
