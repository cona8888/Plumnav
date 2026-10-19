import { correctDirectionReadings, type DirectionCalibration } from './m21-direction'
import type { TimedView } from './m22-recovery'
import { m36QuadraticDecision } from './m36-quadratic-temporal'
import type { Vec2 } from '../../src/sim/types'

export const M40_CONTACT_DESIGN = {
  detectionLevel: 0.075, minimumContactCycles: 3, requiredCycles: 8,
  maximumLastAge: 0.25, maximumResponseSeconds: 0.75,
  developmentOnly: true,
} as const
export type M40ContactState = 'no-local-contact' | 'contact-unresolved' | 'directional-contact'
export type M40Decision = ReturnType<typeof m36QuadraticDecision> & {
  state: M40ContactState | null;
  evidence: 'below-detection' | 'gas-detected' | 'uncertain' | 'invalid';
  nextStep: 'search' | 'reposition-and-resniff' | 'follow' | 'hold-and-resniff';
  contactCycles: number;
}

// Controller inputs contain measurements and calibration only. Neither source
// presence nor the synthetic field/oracle is accessible here.
export const m40ContactDecision = (views: TimedView[], calibration: DirectionCalibration,
  now: number, responseSeconds: number): M40Decision => {
  const lastHeading = views.at(-1)?.heading
  const heading = Number.isFinite(lastHeading) ? lastHeading! : 0
  const abstain = (state: M40ContactState | null, evidence: M40Decision['evidence'],
    nextStep: M40Decision['nextStep'], reason: string, contactCycles = 0): M40Decision => {
    const bearing = heading + (nextStep === 'search' ? 0 : Math.PI / 2)
    const hold = nextStep === 'hold-and-resniff'
    return { direction: null as Vec2 | null, fittedRate: null, maximumResidual: null,
      state, evidence, nextStep, contactCycles, reason,
      action: { kind: 'explore', direction: { x: Math.cos(bearing), y: Math.sin(bearing) },
        plannedDistance: hold ? 0 : 0.01, plannedDuration: 1, executedDistance: 0 } }
  }
  if (views.length !== M40_CONTACT_DESIGN.requiredCycles || !Number.isFinite(now) ||
    views.some((view, i) => !Number.isFinite(view.heading) || !Number.isFinite(view.time) || view.time > now ||
      view.values.length !== 4 || view.values.some((value) => !Number.isFinite(value) || value < 0 || value > 1.5) ||
      !Number.isFinite(view.intakeFraction ?? 1) || (view.intakeFraction ?? 1) < 0.05 || (view.intakeFraction ?? 1) > 1 ||
      (i > 0 && Math.abs(view.time - views[i - 1]!.time - 0.5) > 1e-8)) ||
    now - views.at(-1)!.time > M40_CONTACT_DESIGN.maximumLastAge)
    return abstain(null, 'invalid', 'hold-and-resniff', 'invalid-or-stale-history')
  if (calibration.slopes.length !== 4 || calibration.offsets.length !== 4 ||
    calibration.slopes.some((value) => !Number.isFinite(value) || value < 0.25 || value > 2) ||
    calibration.offsets.some((value) => !Number.isFinite(value)) ||
    !Number.isFinite(calibration.correctedVariance) || calibration.correctedVariance < 0)
    return abstain(null, 'invalid', 'hold-and-resniff', 'invalid-calibration')
  if (!Number.isFinite(responseSeconds) || responseSeconds <= 0 || responseSeconds > M40_CONTACT_DESIGN.maximumResponseSeconds)
    return abstain(null, 'invalid', 'hold-and-resniff', 'sensor-bandwidth')
  const contactCycles = views.filter((view) => {
    const fraction = view.intakeFraction ?? 1
    const corrected = correctDirectionReadings(view.values, calibration)
    // Dilution is a commanded, measured sampling setting. Saturation is positive
    // contact evidence even when its true concentration cannot be reconstructed.
    return view.values.some((value) => value >= 1.425) ||
      corrected.some((value) => value / fraction > M40_CONTACT_DESIGN.detectionLevel)
  }).length
  if (contactCycles === 0)
    return abstain('no-local-contact', 'below-detection', 'search', 'no-local-gas-detected')
  if (contactCycles < M40_CONTACT_DESIGN.minimumContactCycles)
    return abstain('contact-unresolved', 'uncertain', 'hold-and-resniff', 'intermittent-contact', contactCycles)
  const direction = m36QuadraticDecision(views, calibration, now, responseSeconds)
  if (direction.direction)
    return { ...direction, state: 'directional-contact', evidence: 'gas-detected', nextStep: 'follow', contactCycles }
  return abstain('contact-unresolved', 'gas-detected', 'reposition-and-resniff', direction.reason, contactCycles)
}
