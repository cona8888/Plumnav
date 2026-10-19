import { runM30, type M30DecisionObservation } from './m30-move-resense'
import { m36QuadraticDecision } from './m36-quadratic-temporal'
import { m37RapidFreshViews } from './m37-rapid-fixed-quad'
import { executeM38ActionFrom } from './m38-feasibility-first-executor'

type ContactState = 'no-local-contact' | 'contact-direction-limited' | 'direction-observable'
type Cell = { map: string; dynamic: string; nuisance: string; episodes: number; noContact: number;
  limited: number; observable: number; acceptedNoContact: number; abstainedNoContact: number;
  acceptedLimited: number; acceptedObservable: number }
const clamp = (value: number) => Math.max(0, Math.min(1.5, value))
export const m39EndpointState = (observation: M30DecisionObservation): ContactState => {
  const threshold = 3 * Math.sqrt(observation.calibration.correctedVariance)
  let contact = false, observableCycles = 0
  for (const view of observation.views) {
    const time = view.time - 0.25
    const directions = [0, -Math.PI / 2, Math.PI, Math.PI / 2].map((offset) => ({
      x: Math.cos(view.heading + offset), y: Math.sin(view.heading + offset),
    }))
    const values = directions.map((direction) => observation.field({
      x: observation.position.x + 0.0975 * direction.x,
      y: observation.position.y + 0.0975 * direction.y,
    }, time))
    const center = observation.field(observation.position, time)
    if (Math.max(center, ...values) > 0.075) contact = true
    const bestContrast = Math.max(...[1, 0.5, 0.25].map((fraction) => {
      const sensed = values.map((value) => clamp(fraction * value))
      return Math.hypot(sensed[0]! - sensed[2]!, sensed[3]! - sensed[1]!)
    }))
    if (bestContrast > threshold) observableCycles++
  }
  if (!contact) return 'no-local-contact'
  return observableCycles >= 3 ? 'direction-observable' : 'contact-direction-limited'
}
const rate = (numerator: number, denominator: number) => denominator ? numerator / denominator : null

export const M39_DESIGN = { calibrationSeedBase: 82000, episodeSeedBase: 22000000,
  detectionLevel: 0.075, sensorMaximum: 1.5, oracleFractions: [1, 0.5, 0.25],
  minimumObservableCycles: 3, diagnosticOnly: true } as const
export const runM39 = () => {
  const cells = new Map<string, Cell>()
  const onDecision = (observation: M30DecisionObservation) => {
    if (observation.arm !== 'fresh-resense') return
    const state = m39EndpointState(observation)
    const accepted = observation.decision.direction !== null
    const key = `${observation.map}|${observation.dynamic}|${observation.nuisance}`
    const cell = cells.get(key) ?? { map: observation.map, dynamic: observation.dynamic, nuisance: observation.nuisance,
      episodes: 0, noContact: 0, limited: 0, observable: 0, acceptedNoContact: 0, abstainedNoContact: 0,
      acceptedLimited: 0, acceptedObservable: 0 }
    cell.episodes++
    if (state === 'no-local-contact') { cell.noContact++; cell.acceptedNoContact += Number(accepted); cell.abstainedNoContact += Number(!accepted) }
    else if (state === 'contact-direction-limited') { cell.limited++; cell.acceptedLimited += Number(accepted) }
    else { cell.observable++; cell.acceptedObservable += Number(accepted) }
    cells.set(key, cell)
  }
  const run = runM30({}, { calibrationSeedBase: M39_DESIGN.calibrationSeedBase,
    episodeSeedBase: M39_DESIGN.episodeSeedBase, resenseDecisionTime: 17, secondActionEndTime: 18,
    freshAcquisition: m37RapidFreshViews, freshDecision: m36QuadraticDecision,
    actionExecutor: executeM38ActionFrom, onDecision })
  const rows = [...cells.values()]
  const totals = rows.reduce((all, cell) => ({ episodes: all.episodes + cell.episodes,
    noContact: all.noContact + cell.noContact, limited: all.limited + cell.limited,
    observable: all.observable + cell.observable, acceptedNoContact: all.acceptedNoContact + cell.acceptedNoContact,
    abstainedNoContact: all.abstainedNoContact + cell.abstainedNoContact,
    acceptedLimited: all.acceptedLimited + cell.acceptedLimited,
    acceptedObservable: all.acceptedObservable + cell.acceptedObservable }),
  { episodes: 0, noContact: 0, limited: 0, observable: 0, acceptedNoContact: 0,
    abstainedNoContact: 0, acceptedLimited: 0, acceptedObservable: 0 })
  const byMap = [...new Set(rows.map((row) => row.map))].map((map) => {
    const selected = rows.filter((row) => row.map === map)
    const noContact = selected.reduce((sum, row) => sum + row.noContact, 0)
    const observable = selected.reduce((sum, row) => sum + row.observable, 0)
    const acceptedNoContact = selected.reduce((sum, row) => sum + row.acceptedNoContact, 0)
    const acceptedObservable = selected.reduce((sum, row) => sum + row.acceptedObservable, 0)
    return { map, noContact, observable, noContactFalseDirectionRate: rate(acceptedNoContact, noContact),
      observableDirectionalCoverage: rate(acceptedObservable, observable) }
  })
  return { complete: true, design: M39_DESIGN, execution: { baseEpisodes: run.baseEpisodes,
    decisions: run.reacquisitionDecisions, safetyFailures: run.failures.safety.length,
    staleAcceptanceFailures: run.failures.staleAcceptance.length }, totals: { ...totals,
    noContactFalseDirectionRate: rate(totals.acceptedNoContact, totals.noContact),
    noContactCorrectAbstentionRate: rate(totals.abstainedNoContact, totals.noContact),
    observableDirectionalCoverage: rate(totals.acceptedObservable, totals.observable),
    limitedContactAcceptanceRate: rate(totals.acceptedLimited, totals.limited) }, byMap, cells: rows }
}
