import { makeM24Sensor, m24Passive, m24Scan } from './m24-time-aware'
import { M30_DESIGN, runM30, type M30Decision, type M30ViewAcquisition } from './m30-move-resense'
import { summarizeM32Run } from './m32-contrast-aware-development'
import { m34AgreementDecision, m34FreshViews } from './m34-locked-intake-agreement'

type Sensor = ReturnType<typeof makeM24Sensor>
const previousFraction = new WeakMap<Sensor, number>()
const chooseFraction = (observed: number) => observed >= 1.35 ? 0.25 : observed >= 0.95 ? 0.5 : 1
const applyFraction = (sensor: Sensor, fraction: number) => {
  const ratio = fraction / (previousFraction.get(sensor) ?? 1)
  for (const channel of Object.keys(sensor.quadSensorStates)) sensor.quadSensorStates[channel] *= ratio
  previousFraction.set(sensor, fraction)
}
export const m35FreshViews: M30ViewAcquisition = (sensor, field, body, origin) => {
  const passive = m24Passive(sensor, field, M30_DESIGN.resenseStartTime - 0.5, 2, origin)
  const fraction = chooseFraction(passive?.concentration ?? 0)
  applyFraction(sensor, fraction)
  return [0, 1, 2, 3, 4, 5, 6, 7].map((slot) => {
    const start = M30_DESIGN.resenseStartTime + slot
    if (slot) m24Passive(sensor, field, start - 0.5, 2, origin)
    const heading = body + slot * Math.PI / 2
    return { heading, time: start + 0.5, values: m24Scan(sensor, field, start, heading, origin, fraction) }
  })
}
const rotate = (v: { x: number; y: number }, angle: number) => ({
  x: v.x * Math.cos(angle) - v.y * Math.sin(angle),
  y: v.x * Math.sin(angle) + v.y * Math.cos(angle),
})
const angleDifference = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y))
export const m35RepeatedDecision: M30Decision = (views, calibration, now, responseSeconds) => {
  const abstain = () => ({ direction: null, reason: 'repeat-inconsistent', fittedRate: null, maximumResidual: null,
    action: { kind: 'explore' as const, direction: { x: Math.cos((views.at(-1)?.heading ?? 0) + Math.PI / 2),
      y: Math.sin((views.at(-1)?.heading ?? 0) + Math.PI / 2) }, plannedDistance: 0.01,
      plannedDuration: 1, executedDistance: 0 } })
  if (views.length !== 8) return abstain()
  const firstViews = views.slice(0, 4), secondViews = views.slice(4)
  const firstTime = firstViews[3]!.time, secondTime = secondViews[3]!.time
  if (Math.abs(now - secondTime) > 1e-9) return abstain()
  const first = m34AgreementDecision(firstViews, calibration, firstTime, responseSeconds)
  const second = m34AgreementDecision(secondViews, calibration, secondTime, responseSeconds)
  if (!first.direction || !second.direction || first.fittedRate === null || second.fittedRate === null) return abstain()
  const propagated = rotate(first.direction, 0.5 * (first.fittedRate + second.fittedRate) * (secondTime - firstTime))
  if (angleDifference(propagated, second.direction) > Math.PI / 8) return abstain()
  return { ...second, reason: 'repeated-sniff-consistent' }
}

export const M35_DESIGN = { calibrationSeedBase: 74000, episodeSeedBase: 14000000,
  firstStage: 'legacy', repeatedFreshCycles: 8, resenseDecisionTime: 20.5, secondActionEndTime: 21.5,
  maximumPropagationErrorRadians: Math.PI / 8, developmentOnly: true, heldOutConfirmationRequired: true } as const

export const runM35 = () => {
  const seeds = { calibrationSeedBase: M35_DESIGN.calibrationSeedBase, episodeSeedBase: M35_DESIGN.episodeSeedBase }
  const legacy = runM30({}, seeds)
  const stagedSingle = runM30({}, { ...seeds, freshDecision: m34AgreementDecision, freshAcquisition: m34FreshViews })
  const stagedRepeated = runM30({}, { ...seeds, freshDecision: m35RepeatedDecision, freshAcquisition: m35FreshViews,
    resenseDecisionTime: M35_DESIGN.resenseDecisionTime, secondActionEndTime: M35_DESIGN.secondActionEndTime })
  return { complete: true, design: M35_DESIGN, legacy: summarizeM32Run(legacy),
    stagedSingle: summarizeM32Run(stagedSingle), stagedRepeated: summarizeM32Run(stagedRepeated) }
}
