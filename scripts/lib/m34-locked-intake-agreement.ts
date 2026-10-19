import { contrastAwareTimeDecision, makeM24Sensor, m24Passive, m24Scan, timeAwareDecision } from './m24-time-aware'
import { M30_DESIGN, runM30, type M30Decision, type M30ViewAcquisition } from './m30-move-resense'
import { summarizeM32Run } from './m32-contrast-aware-development'
import { m33FreshViews, m33InitialViews } from './m33-adaptive-sniff-development'

type Sensor = ReturnType<typeof makeM24Sensor>
const previousFraction = new WeakMap<Sensor, number>()
const chooseFraction = (observed: number) => observed >= 1.35 ? 0.25 : observed >= 0.95 ? 0.5 : 1
const applyFraction = (sensor: Sensor, fraction: number) => {
  const ratio = fraction / (previousFraction.get(sensor) ?? 1)
  for (const channel of Object.keys(sensor.quadSensorStates)) sensor.quadSensorStates[channel] *= ratio
  previousFraction.set(sensor, fraction)
}
const lockedViews = (startTime: number, warmup: number): M30ViewAcquisition => (sensor, field, body, origin) => {
  const passive = m24Passive(sensor, field, startTime - warmup * 0.25, warmup, origin)
  const fraction = chooseFraction(passive?.concentration ?? 0)
  applyFraction(sensor, fraction)
  return [0, 1, 2, 3].map((slot) => {
    const start = startTime + slot
    if (slot) m24Passive(sensor, field, start - 0.5, 2, origin)
    const heading = body + slot * Math.PI / 2
    return { heading, time: start + 0.5, values: m24Scan(sensor, field, start, heading, origin, fraction) }
  })
}
const angleDifference = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y))
export const m34AgreementDecision: M30Decision = (views, calibration, now, responseSeconds) => {
  const conservative = timeAwareDecision(views, calibration, now, responseSeconds)
  const contrast = contrastAwareTimeDecision(views, calibration, now, responseSeconds)
  if (!conservative.direction || !contrast.direction || angleDifference(conservative.direction, contrast.direction) > Math.PI / 8) {
    return { direction: null, reason: 'estimator-disagreement', fittedRate: null, maximumResidual: null,
      action: { kind: 'explore', direction: contrast.action.direction, plannedDistance: 0.01,
        plannedDuration: 1, executedDistance: 0 } }
  }
  return { ...contrast, reason: 'locked-intake-agreement' }
}

export const m34InitialViews = lockedViews(8, 32)
export const m34FreshViews = lockedViews(M30_DESIGN.resenseStartTime, 2)
export const M34_DESIGN = { calibrationSeedBase: 72000, episodeSeedBase: 12000000,
  intakeFractions: [1, 0.5, 0.25], intakeThresholds: [0.95, 1.35], maximumAgreementRadians: Math.PI / 8,
  fractionLockedPerAcquisition: true, developmentOnly: true, heldOutConfirmationRequired: true } as const

export const runM34 = () => {
  const seeds = { calibrationSeedBase: M34_DESIGN.calibrationSeedBase, episodeSeedBase: M34_DESIGN.episodeSeedBase }
  const legacy = runM30({}, seeds)
  const switching = runM30({}, { ...seeds, decision: contrastAwareTimeDecision,
    initialAcquisition: m33InitialViews, freshAcquisition: m33FreshViews })
  const lockedAgreement = runM30({}, { ...seeds, decision: m34AgreementDecision,
    initialAcquisition: m34InitialViews, freshAcquisition: m34FreshViews })
  return { complete: true, design: M34_DESIGN, legacy: summarizeM32Run(legacy),
    switching: summarizeM32Run(switching), lockedAgreement: summarizeM32Run(lockedAgreement) }
}
