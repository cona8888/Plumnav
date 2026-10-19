import { directionDecision, type DirectionView, type DirectionCalibration } from './m21-direction'
import { M21_NUISANCES, M21_FIELDS, m21Calibrate, m21Episode } from './m21-direction-study'
export type TimedView = DirectionView & { time: number; intakeFraction?: number }
export const M22_ARMS = ['raw-pooled', 'calibrated-pooled', 'raw-consistent', 'calibrated-consistent', 'raw-recovery', 'calibrated-recovery'] as const
export type M22Arm = typeof M22_ARMS[number]
export const recoveryDecision = (views: TimedView[], c: DirectionCalibration, arm: M22Arm, now: number) => {
  if (!M22_ARMS.includes(arm)) throw new Error('Unknown arm')
  const calibrated = arm.startsWith('calibrated')
  const calibration = calibrated ? c : { slopes: [1, 1, 1, 1], offsets: [0, 0, 0, 0], rawVariance: c.rawVariance, correctedVariance: c.rawVariance }
  // Keep raw/calibrated comparisons on the same validity boundary as M21.
  const validity = directionDecision(views, c, 'raw')
  const invalidCalibration = ['invalid-calibration', 'invalid-variance'].includes(validity.reason)
  const causal = Number.isFinite(now) && views.length === 4 && views.every((v, i) => Number.isFinite(v.time) &&
    v.time <= now && (i === 0 || v.time > views[i - 1]!.time)) && now - views[3]!.time <= 0.25
  let result = { direction: null as { x: number; y: number } | null, reason: 'invalid-or-stale-history' }
  let stage = 'none'
  if (causal && !invalidCalibration) {
    result = directionDecision(views, calibration, arm.endsWith('pooled') ? 'calibrated' : 'rotation-consistent')
    stage = 'four-view'
    if (result.direction === null && arm.endsWith('recovery') && now - views[2]!.time <= 1.25) {
      result = directionDecision([views[2]!, views[2]!, views[3]!, views[3]!], calibration, 'rotation-consistent')
      stage = 'recent-pair'
    }
  }
  const heading = Number.isFinite(views.at(-1)?.heading) ? views.at(-1)!.heading + Math.PI / 2 : 0
  return { ...result, stage, action: { kind: result.direction ? 'follow' : 'explore',
    direction: result.direction ?? { x: Math.cos(heading), y: Math.sin(heading) },
    plannedDistance: 0.01, plannedDuration: 1, executedDistance: 0 } }
}
export const M22_DESIGN = { arms: M22_ARMS, calibrationSeeds: [41000, 41034], episodeSeedBase: 200000,
  expectedCalibrations: 35, expectedEpisodes: 5600, expectedDecisions: 33600,
  calibrationSeconds: 144, drawSeconds: 2, warmupSeconds: 8, turnSeconds: 1.5,
  plannedDistance: 0.01, plannedDuration: 1, executedDistance: 0, maximumLastAge: 0.25,
  maximumPreviousAge: 1.25, falseGuidanceCap: 0.05, wrongDirectionCap: 0.05, minimumCoverage: 0.5,
  movementExecuted: false, appPromoted: false } as const
export const runM22 = () => {
  const calibrations = []
  const episodes: Array<Omit<ReturnType<typeof m21Episode>, 'views' | 'decisions'> & {
    calibrationId: string; views: TimedView[];
    decisions: Array<ReturnType<typeof recoveryDecision> & { arm: M22Arm; angleError: number | null }>
  }> = []
  for (const [ni, n] of M21_NUISANCES.entries()) for (let rep = 0; rep < 5; rep++) {
    const id = `${n.id}-${rep}`; const calibration = m21Calibrate(n, 41000 + ni * 5 + rep)
    calibrations.push({ id, nuisance: n.id, ...calibration })
    for (const [fi, field] of M21_FIELDS.entries()) for (let k = 0; k < 20; k++) {
      const e = m21Episode(n, field, 200000 + ni * 10000 + rep * 1000 + fi * 20 + k, calibration.calibration)
      const views = e.views.map((v, i) => ({ ...v, time: 8.5 + i }))
      const decisions = M22_ARMS.map((arm) => {
        const d = recoveryDecision(views, calibration.calibration, arm, 11.5)
        const error = d.direction && !e.nullDirection ? Math.acos(Math.max(-1, Math.min(1,
          (d.direction.x * e.gradient.x + d.direction.y * e.gradient.y) / Math.hypot(e.gradient.x, e.gradient.y)))) * 180 / Math.PI : null
        return { arm, ...d, angleError: error }
      })
      episodes.push({ calibrationId: id, seed: e.seed, field, nuisance: n.id, gradient: e.gradient, nullDirection: e.nullDirection, views, decisions })
    }
  }
  const cells = M21_NUISANCES.flatMap((n) => M21_FIELDS.flatMap((field) => M22_ARMS.map((arm) => {
    const es = episodes.filter((e) => e.nuisance === n.id && e.field === field)
    const ds = es.map((e) => e.decisions.find((d) => d.arm === arm)!)
    const accepted = ds.filter((d) => d.direction)
    return { nuisance: n.id, field, arm, episodes: es.length, accepted: accepted.length, explore: ds.length - accepted.length,
      wrong: accepted.filter((d) => d.angleError !== null && d.angleError > 45).length,
      recovered: accepted.filter((d) => d.stage === 'recent-pair').length,
      nullDirection: field === 'flat' || field === 'peak', meanError: accepted.length && accepted[0]!.angleError !== null ? accepted.reduce((s, d) => s + d.angleError!, 0) / accepted.length : null }
  })))
  const gates = (arm: M22Arm) => cells.filter((c) => c.arm === arm).filter((c) =>
    (c.nullDirection && c.accepted > 5) || (!c.nullDirection && c.wrong > c.accepted * 0.05) ||
    (['linear', 'off-peak', 'turning'].includes(c.field) && c.accepted < 50))
  const summary = { cells, recoveryFailures: { raw: gates('raw-recovery'), calibrated: gates('calibrated-recovery') },
    rawAdvances: gates('raw-recovery').length === 0, calibratedAdvances: gates('calibrated-recovery').length === 0,
    appPromoted: false, movementExecuted: false, gslTrajectories: 0 }
  return { complete: true, design: M22_DESIGN, calibrations, episodes, summary }
}
