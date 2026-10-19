import { correctDirectionReadings, type DirectionCalibration } from './m21-direction'
import { runM30, type M30Decision } from './m30-move-resense'
import { summarizeM32Run } from './m32-contrast-aware-development'
import { m35FreshViews, m35RepeatedDecision } from './m35-staged-repeated-sniff'
import type { Vec2 } from '../../src/sim/types'
import type { TimedView } from './m22-recovery'

const wrap = (value: number) => Math.atan2(Math.sin(value), Math.cos(value))
const abstain = (views: TimedView[], reason: string) => ({ direction: null as Vec2 | null, reason,
  fittedRate: null as number | null, maximumResidual: null as number | null,
  action: { kind: 'explore' as const, direction: { x: Math.cos((views.at(-1)?.heading ?? 0) + Math.PI / 2),
    y: Math.sin((views.at(-1)?.heading ?? 0) + Math.PI / 2) }, plannedDistance: 0.01,
    plannedDuration: 1, executedDistance: 0 } })
export const m36QuadraticDecision: M30Decision = (views, calibration: DirectionCalibration, now, responseSeconds) => {
  if (!Number.isFinite(responseSeconds) || responseSeconds <= 0 || responseSeconds > 0.75) return abstain(views, 'sensor-bandwidth')
  if (views.length !== 8 || !Number.isFinite(now) || views.some((view, i) => !Number.isFinite(view.time) || view.time > now ||
    view.values.length !== 4 || view.values.some((value) => !Number.isFinite(value)) || (i > 0 && view.time <= views[i - 1]!.time)) ||
    now - views[7]!.time > 0.25) return abstain(views, 'invalid-or-stale-history')
  if (calibration.slopes.length !== 4 || calibration.offsets.length !== 4 ||
    calibration.slopes.some((value) => !Number.isFinite(value) || value < 0.25 || value > 2) ||
    calibration.offsets.some((value) => !Number.isFinite(value)) ||
    !Number.isFinite(calibration.correctedVariance) || calibration.correctedVariance < 0) return abstain(views, 'invalid-calibration')
  const threshold = 3 * Math.sqrt(calibration.correctedVariance)
  const rows = views.map((view) => {
    const corrected = correctDirectionReadings(view.values, calibration)
    const bx = corrected[0]! - corrected[2]!, by = corrected[3]! - corrected[1]!
    const x = bx * Math.cos(view.heading) - by * Math.sin(view.heading)
    const y = bx * Math.sin(view.heading) + by * Math.cos(view.heading)
    const low = view.values.filter((value) => value <= 0.075).length
    const high = view.values.filter((value) => value >= 1.425).length
    return { time: view.time - 0.25, angle: Math.atan2(y, x), magnitude: Math.hypot(x, y), allBoundary: low === 4 || high === 4 }
  })
  if (rows.some((row) => row.allBoundary || !Number.isFinite(row.magnitude) || row.magnitude <= threshold))
    return abstain(views, 'insufficient-differential-contrast')
  const angles = [rows[0]!.angle]
  for (let i = 1; i < rows.length; i++) angles.push(angles[i - 1]! + wrap(rows[i]!.angle - rows[i - 1]!.angle))
  const mt = rows.reduce((total, row) => total + row.time, 0) / rows.length
  const x = rows.map((row) => row.time - mt)
  const s2 = x.reduce((total, value) => total + value ** 2, 0)
  const s4 = x.reduce((total, value) => total + value ** 4, 0)
  const sy = angles.reduce((total, value) => total + value, 0)
  const sxy = x.reduce((total, value, i) => total + value * angles[i]!, 0)
  const sx2y = x.reduce((total, value, i) => total + value ** 2 * angles[i]!, 0)
  const den = rows.length * s4 - s2 ** 2
  if (!(den > 1e-12) || !(s2 > 1e-12)) return abstain(views, 'ill-conditioned-quadratic-fit')
  const a0 = (sy * s4 - s2 * sx2y) / den
  const a1 = sxy / s2
  const a2 = (rows.length * sx2y - s2 * sy) / den
  const acceleration = 2 * a2
  const at = now - mt
  const angle = a0 + a1 * at + a2 * at ** 2
  const instantaneousRate = a1 + acceleration * at
  const residual = Math.max(...angles.map((value, i) => Math.abs(wrap(value - (a0 + a1 * x[i]! + a2 * x[i]! ** 2)))))
  if (!Number.isFinite(angle) || !Number.isFinite(instantaneousRate) || !Number.isFinite(acceleration) ||
    Math.abs(instantaneousRate) > 6 || Math.abs(acceleration) > 0.6 || residual > Math.PI / 8)
    return abstain(views, 'unreliable-quadratic-fit')
  const direction = { x: Math.cos(angle), y: Math.sin(angle) }
  const oneSecondForecastRate = instantaneousRate + 0.5 * acceleration
  return { direction, reason: 'quadratic-time-direction', fittedRate: oneSecondForecastRate, maximumResidual: residual,
    action: { kind: 'follow' as const, direction, plannedDistance: 0.01, plannedDuration: 1, executedDistance: 0 } }
}

export const M36_DESIGN = { calibrationSeedBase: 76000, episodeSeedBase: 16000000,
  maximumResidualRadians: Math.PI / 8, maximumRate: 6, maximumAcceleration: 0.6,
  resenseDecisionTime: 20.5, secondActionEndTime: 21.5, developmentOnly: true,
  heldOutConfirmationRequired: true } as const
export const runM36 = () => {
  const seeds = { calibrationSeedBase: M36_DESIGN.calibrationSeedBase, episodeSeedBase: M36_DESIGN.episodeSeedBase }
  const timing = { resenseDecisionTime: M36_DESIGN.resenseDecisionTime, secondActionEndTime: M36_DESIGN.secondActionEndTime }
  const legacy = runM30({}, seeds)
  const repeated = runM30({}, { ...seeds, ...timing, freshAcquisition: m35FreshViews, freshDecision: m35RepeatedDecision })
  const quadratic = runM30({}, { ...seeds, ...timing, freshAcquisition: m35FreshViews, freshDecision: m36QuadraticDecision })
  return { complete: true, design: M36_DESIGN, legacy: summarizeM32Run(legacy),
    repeated: summarizeM32Run(repeated), quadratic: summarizeM32Run(quadratic) }
}
