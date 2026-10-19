import { contrastAwareTimeDecision } from './m24-time-aware'
import { runM30 } from './m30-move-resense'

type Run = ReturnType<typeof runM30>
type Cell = Run['aggregates'][number]
const sum = (cells: Cell[], field: keyof Pick<Cell, 'decisions' | 'accepted' | 'follows' | 'correct' | 'positiveProgress'>) =>
  cells.reduce((total, cell) => total + cell[field], 0)
const reasons = (cells: Cell[]) => Object.fromEntries(Object.entries(cells.reduce<Record<string, number>>((all, cell) => {
  for (const [reason, count] of Object.entries(cell.reasons)) all[reason] = (all[reason] ?? 0) + count
  return all
}, {})).sort((a, b) => b[1] - a[1]))
const grouped = (cells: Cell[], key: 'map' | 'dynamic' | 'nuisance') => [...new Set(cells.map((cell) => cell[key]))].sort().map((value) => {
  const group = cells.filter((cell) => cell[key] === value)
  const decisions = sum(group, 'decisions'), accepted = sum(group, 'accepted'), follows = sum(group, 'follows')
  return { value, cells: group.length, decisions, accepted, follows,
    acceptanceRate: accepted / decisions, followRate: follows / decisions,
    correctDirectionRate: follows ? sum(group, 'correct') / follows : null,
    positiveProgressRate: follows ? sum(group, 'positiveProgress') / follows : null }
})
export const summarizeM32Run = (run: Run) => {
  const fresh = run.aggregates.filter((cell) => cell.arm === 'fresh-resense')
  const supported = fresh.filter((cell) => cell.nuisance !== 'slow')
  const follows = sum(supported, 'follows')
  return {
    counts: { baseEpisodes: run.baseEpisodes, reacquisitionDecisions: run.reacquisitionDecisions, freshSensorCycles: run.freshSensorCycles },
    gates: { safety: run.failures.safety.length, distance: run.failures.distance.length,
      slowFollow: run.failures.slowFollow.length, staleAcceptance: run.failures.staleAcceptance.length,
      acceptance: run.failures.acceptance.length, directionCells: run.failures.directionCells.length,
      progressCells: run.failures.progressCells.length, correctDirectionOverall: follows ? sum(supported, 'correct') / follows : null,
      positiveProgressOverall: follows ? sum(supported, 'positiveProgress') / follows : null,
      advances: run.advancesToMultiCycleTest },
    byMap: grouped(supported, 'map'), byDynamic: grouped(supported, 'dynamic'), byNuisance: grouped(supported, 'nuisance'),
    reasons: reasons(supported),
  }
}

export const M32_DESIGN = { calibrationSeedBase: 68000, episodeSeedBase: 8000000,
  developmentOnly: true, heldOutConfirmationRequired: true } as const

export const runM32 = () => {
  const options = { calibrationSeedBase: M32_DESIGN.calibrationSeedBase, episodeSeedBase: M32_DESIGN.episodeSeedBase }
  const legacy = runM30({}, options)
  const contrastAware = runM30({}, { ...options, decision: contrastAwareTimeDecision })
  return { complete: true, design: M32_DESIGN, legacy: summarizeM32Run(legacy), contrastAware: summarizeM32Run(contrastAware) }
}
