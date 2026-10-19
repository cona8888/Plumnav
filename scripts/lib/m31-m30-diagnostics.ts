import { runM30 } from './m30-move-resense'

type Cell = ReturnType<typeof runM30>['aggregates'][number]
const sum = (cells: Cell[], field: keyof Pick<Cell, 'decisions' | 'accepted' | 'follows' | 'correct' | 'positiveProgress'>) =>
  cells.reduce((total, cell) => total + cell[field], 0)
const group = (cells: Cell[], key: 'map' | 'dynamic' | 'nuisance') => [...new Set(cells.map((cell) => cell[key]))].sort().map((value) => {
  const selected = cells.filter((cell) => cell[key] === value)
  const decisions = sum(selected, 'decisions')
  const accepted = sum(selected, 'accepted')
  const follows = sum(selected, 'follows')
  return { value, cells: selected.length, decisions, accepted, follows,
    acceptanceRate: decisions ? accepted / decisions : null,
    followRate: decisions ? follows / decisions : null }
})
const reasons = (cells: Cell[]) => Object.entries(cells.reduce<Record<string, number>>((all, cell) => {
  for (const [reason, count] of Object.entries(cell.reasons)) all[reason] = (all[reason] ?? 0) + count
  return all
}, {})).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }))

export const runM31 = () => {
  const m30 = runM30()
  const fresh = m30.aggregates.filter((cell) => cell.arm === 'fresh-resense')
  const supported = fresh.filter((cell) => cell.nuisance !== 'slow')
  const moving = supported.filter((cell) => cell.dynamic !== 'static')
  const staticCells = supported.filter((cell) => cell.dynamic === 'static')
  const follows = sum(supported, 'follows')
  const correctedDirectionOverall = follows ? sum(supported, 'correct') / follows : null
  const progressOverall = follows ? sum(supported, 'positiveProgress') / follows : null
  return {
    complete: true,
    purpose: 'diagnostic-only; M30 thresholds and evaluation design unchanged',
    counts: { baseEpisodes: m30.baseEpisodes, reacquisitionDecisions: m30.reacquisitionDecisions,
      freshSensorCycles: m30.freshSensorCycles },
    invariants: {
      correctNeverExceedsFollows: m30.aggregates.every((cell) => cell.correct <= cell.follows),
      progressNeverExceedsFollows: m30.aggregates.every((cell) => cell.positiveProgress <= cell.follows),
    },
    gates: {
      safetyFailures: m30.failures.safety.length,
      distanceFailures: m30.failures.distance.length,
      slowFollowFailures: m30.failures.slowFollow.length,
      staleAcceptanceFailures: m30.failures.staleAcceptance.length,
      acceptanceFailures: m30.failures.acceptance.length,
      directionCellFailures: m30.failures.directionCells.length,
      progressCellFailures: m30.failures.progressCells.length,
      correctedDirectionOverall,
      progressOverall,
      advancesToMultiCycleTest: m30.advancesToMultiCycleTest,
    },
    static: { byMap: group(staticCells, 'map'), byNuisance: group(staticCells, 'nuisance'), reasons: reasons(staticCells) },
    moving: { byMap: group(moving, 'map'), byDynamic: group(moving, 'dynamic'), byNuisance: group(moving, 'nuisance'), reasons: reasons(moving) },
    failingProgressCells: m30.failures.progressCells.map((cell) => ({ map: cell.map, dynamic: cell.dynamic,
      nuisance: cell.nuisance, follows: cell.follows, correct: cell.correct,
      positiveProgress: cell.positiveProgress, reasons: cell.reasons })),
  }
}
