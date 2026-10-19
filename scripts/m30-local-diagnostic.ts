import { runM30 } from './lib/m30-move-resense'

const result = runM30()

const summarize = (cells: typeof result.aggregates) => cells.map((cell) => ({
  map: cell.map,
  dynamic: cell.dynamic,
  nuisance: cell.nuisance,
  arm: cell.arm,
  decisions: cell.decisions,
  accepted: cell.accepted,
  follows: cell.follows,
  correct: cell.correct,
  positiveProgress: cell.positiveProgress,
}))

const grouped = (cells: typeof result.aggregates, field: 'map' | 'dynamic' | 'nuisance') =>
  Object.fromEntries([...new Set(cells.map((cell) => cell[field]))].sort().map((value) => [
    value,
    cells.filter((cell) => cell[field] === value).length,
  ]))

const acceptanceRates = result.failures.acceptance.map((cell) => cell.accepted / cell.decisions)

console.log(JSON.stringify({
  complete: result.complete,
  baseEpisodes: result.baseEpisodes,
  reacquisitionDecisions: result.reacquisitionDecisions,
  freshSensorCycles: result.freshSensorCycles,
  advancesToMultiCycleTest: result.advancesToMultiCycleTest,
  failures: {
    safety: result.failures.safety.length,
    distance: result.failures.distance.length,
    slowFollow: result.failures.slowFollow.length,
    staleAcceptance: result.failures.staleAcceptance.length,
    acceptance: {
      count: result.failures.acceptance.length,
      byMap: grouped(result.failures.acceptance, 'map'),
      byDynamic: grouped(result.failures.acceptance, 'dynamic'),
      byNuisance: grouped(result.failures.acceptance, 'nuisance'),
      minimumRate: Math.min(...acceptanceRates),
      maximumFailingRate: Math.max(...acceptanceRates),
    },
    directionCells: summarize(result.failures.directionCells),
    progressCells: summarize(result.failures.progressCells),
    correctDirectionOverall: result.failures.correctDirectionOverall,
    positiveProgressOverall: result.failures.positiveProgressOverall,
  },
}, null, 2))
