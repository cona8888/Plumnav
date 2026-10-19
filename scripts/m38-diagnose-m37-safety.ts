import { runM30 } from './lib/m30-move-resense'
import { m36QuadraticDecision } from './lib/m36-quadratic-temporal'
import { M37_DESIGN, m37RapidFreshViews } from './lib/m37-rapid-fixed-quad'

const run = runM30({}, {
  calibrationSeedBase: M37_DESIGN.calibrationSeedBase,
  episodeSeedBase: M37_DESIGN.episodeSeedBase,
  resenseDecisionTime: M37_DESIGN.resenseDecisionTime,
  secondActionEndTime: M37_DESIGN.secondActionEndTime,
  freshAcquisition: m37RapidFreshViews,
  freshDecision: m36QuadraticDecision,
})
const compact = (cells: typeof run.aggregates) => cells.map((cell) => ({
  map: cell.map, dynamic: cell.dynamic, nuisance: cell.nuisance, arm: cell.arm,
  decisions: cell.decisions, accepted: cell.accepted, follows: cell.follows,
  collisions: cell.collisions, blockedEndpoints: cell.blockedEndpoints,
  fullDistance: cell.fullDistance, distance: cell.distance, reasons: cell.reasons,
}))
console.log(JSON.stringify({ safety: compact(run.failures.safety), distance: compact(run.failures.distance) }, null, 2))
