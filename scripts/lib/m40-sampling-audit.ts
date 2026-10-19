import { createQuadSniffEvent, integrateQuadSniffEvent } from '../../src/sim/quadSniff'
import type { PlumeModel } from '../../src/sim/plume'
import type { Vec2 } from '../../src/sim/types'
import { M21_NUISANCES, m21Calibrate } from './m21-direction-study'
import { M24_DYNAMICS, makeM24Sensor, m24Angle } from './m24-time-aware'
import { runM30, m30InitialViews, type M30DecisionObservation, type M30RunLimits } from './m30-move-resense'
import { summarizeM32Run } from './m32-contrast-aware-development'
import { m36QuadraticDecision } from './m36-quadratic-temporal'
import { m37RapidFreshViews } from './m37-rapid-fixed-quad'
import { executeM38ActionFrom } from './m38-feasibility-first-executor'
import { m39EndpointState } from './m39-contact-observability'
import { M40_CONTACT_DESIGN, m40ContactDecision } from './m40-contact-controller'

// Analysis only: reproduce M24's footprint, entrainment and time integration.
// This is pre-electronics potential contrast, not a full sensor observability
// bound: cross-talk, lag, gain errors and temporal fitting can remove information.
export const m40LatentCycle = (field: (point: Vec2, time: number) => number,
  origin: Vec2, heading: number, endTime: number) => {
  const plume = { concentrationAt: field } as PlumeModel
  const start = endTime - 0.5
  const event = createQuadSniffEvent({ command: { scanId: start,
    forward: { x: Math.cos(heading), y: Math.sin(heading) } }, origin, time: start,
    strengthScale: 0.78, samplingMode: 'active-suction', passiveArrayRadius: 0.0125,
    cycleSeconds: 0.5, reachForDirection: () => 0.0975, plume, isBlocked: () => false })!
  integrateQuadSniffEvent(event, start + 0.25, plume)
  integrateQuadSniffEvent(event, endTime, plume)
  return event.latentChannels.map((channel) => channel.latentConcentration)
}
const contrast = (values: number[]) => Math.hypot(values[0]! - values[2]!, values[3]! - values[1]!)
const clamp = (value: number) => Math.max(0, Math.min(1.5, value))
export const m40SamplingTruth = (observation: M30DecisionObservation) => {
  let contactCycles = 0, potentialCycles = 0, bestIntakeCycles = 0
  const threshold = 3 * Math.sqrt(observation.calibration.correctedVariance)
  for (const view of observation.views) {
    const latent = m40LatentCycle(observation.field, observation.position, view.heading, view.time)
    if (Math.max(...latent) > M40_CONTACT_DESIGN.detectionLevel) contactCycles++
    if (contrast(latent.map((value) => clamp(value * (view.intakeFraction ?? 1)))) > threshold) potentialCycles++
    if (Math.max(...[1, 0.5, 0.25].map((fraction) => contrast(latent.map((value) => clamp(value * fraction))))) > threshold)
      bestIntakeCycles++
  }
  return { contactCycles, potentialCycles, bestIntakeCycles,
    state: contactCycles === 0 ? 'no-local-contact' : potentialCycles >= 3 ? 'potential-direction' : 'contact-limited' }
}

export const M40_DESIGN = { calibrationSeedBase: 84000, episodeSeedBase: 24000000,
  controlSeedBase: 26000000, controlTrials: 64, calibrationReplicates: 2,
  ...M40_CONTACT_DESIGN, fullGslTrajectories: 0, appPromoted: false,
  preElectronicsProxyOnly: true, obstaclesModifyTransport: false,
  sameObservationComparison: true } as const
type Cell = { map: string; dynamic: string; nuisance: string; decisions: number;
  referenceNoContact: number; referencePotential: number; referenceAllEight: number;
  endpointPotential: number; endpointOnlyPotential: number; bestIntakePotential: number;
  baselineAccepted: number; accepted: number; correctAccepted: number;
  acceptedNoContact: number; falseNoContact: number; noContactPredictions: number;
  acceptedPotential: number; states: Record<string, number>; confusion: Record<string, number>;
  rejectionReasons: Record<string, number> }
const sum = (rows: Cell[], field: keyof Cell) => rows.reduce((total, row) => total + (row[field] as number), 0)
const rate = (a: number, b: number) => b ? a / b : null
const summarize = (rows: Cell[]) => {
  const total = Object.fromEntries(['decisions', 'referenceNoContact', 'referencePotential', 'referenceAllEight',
    'endpointPotential', 'endpointOnlyPotential', 'bestIntakePotential', 'baselineAccepted', 'accepted',
    'correctAccepted', 'acceptedNoContact', 'falseNoContact', 'noContactPredictions', 'acceptedPotential']
    .map((key) => [key, sum(rows, key as keyof Cell)])) as Record<string, number>
  const records = (key: 'states' | 'confusion' | 'rejectionReasons') => rows.reduce<Record<string, number>>((all, row) => {
    for (const [name, count] of Object.entries(row[key])) all[name] = (all[name] ?? 0) + count
    return all
  }, {})
  return { ...total, potentialCoverage: rate(total.acceptedPotential!, total.referencePotential!),
    acceptedDirectionAccuracy: rate(total.correctAccepted!, total.accepted!),
    falseNoContactAmongPredictions: rate(total.falseNoContact!, total.noContactPredictions!),
    states: records('states'), confusion: records('confusion'), rejectionReasons: records('rejectionReasons') }
}

export const runM40Controls = (trials: number = M40_DESIGN.controlTrials) => {
  const rows = []
  for (const [ni, nuisance] of M21_NUISANCES.entries()) for (let rep = 0; rep < M40_DESIGN.calibrationReplicates; rep++) {
    const calibration = m21Calibrate(nuisance, M40_DESIGN.calibrationSeedBase + ni * 2 + rep).calibration
    for (const [fi, concentration] of [0, 0.02, 0.5].entries()) {
      const counts: Record<string, number> = {}
      let directions = 0
      for (let trial = 0; trial < trials; trial++) {
        const sensor = makeM24Sensor(nuisance, M40_DESIGN.controlSeedBase + ni * 10000 + rep * 1000 + fi * 100 + trial)
        const field = () => concentration, origin = { x: 0.5, y: 0.5 }
        m30InitialViews(sensor, field, 0, origin)
        const views = m37RapidFreshViews(sensor, field, 0, origin)
        const decision = m40ContactDecision(views, calibration, 17, nuisance.lag)
        const key = `${decision.state ?? 'invalid'}|${decision.evidence}`
        counts[key] = (counts[key] ?? 0) + 1
        directions += Number(decision.direction !== null)
      }
      rows.push({ nuisance: nuisance.id, replicate: rep, concentration, trials, directions, counts })
    }
  }
  return rows
}

export const runM40 = (limits: M30RunLimits = {}) => {
  const cells = new Map<string, Cell>()
  let staleDirections = 0, staleNoContactClaims = 0, firstMoveCollisions = 0, firstMoveBlockedEndpoints = 0
  const onDecision = (observation: M30DecisionObservation) => {
    const decision = m40ContactDecision(observation.views, observation.calibration,
      observation.decisionTime, observation.responseSeconds)
    if (observation.arm !== 'fresh-resense') {
      staleDirections += Number(decision.direction !== null)
      staleNoContactClaims += Number(decision.state === 'no-local-contact')
      return
    }
    firstMoveCollisions += observation.firstMove.collisions
    firstMoveBlockedEndpoints += Number(observation.firstMove.blockedEndpoint)
    const truth = m40SamplingTruth(observation)
    const endpoint = m39EndpointState(observation)
    const baseline = m36QuadraticDecision(observation.views, observation.calibration,
      observation.decisionTime, observation.responseSeconds)
    const key = `${observation.map}|${observation.dynamic}|${observation.nuisance}`
    const cell = cells.get(key) ?? { map: observation.map, dynamic: observation.dynamic, nuisance: observation.nuisance,
      decisions: 0, referenceNoContact: 0, referencePotential: 0, referenceAllEight: 0, endpointPotential: 0,
      endpointOnlyPotential: 0, bestIntakePotential: 0, baselineAccepted: 0, accepted: 0,
      correctAccepted: 0, acceptedNoContact: 0, falseNoContact: 0, noContactPredictions: 0,
      acceptedPotential: 0, states: {}, confusion: {}, rejectionReasons: {} } as Cell
    const accepted = decision.direction !== null, potential = truth.state === 'potential-direction'
    const noContact = truth.state === 'no-local-contact', predictsAbsent = decision.state === 'no-local-contact'
    const angle = m24Angle(M24_DYNAMICS.find((dynamic) => dynamic.id === observation.dynamic)!, observation.phase,
      observation.decisionTime)
    const error = decision.direction ? Math.abs(Math.atan2(Math.sin(Math.atan2(decision.direction.y, decision.direction.x) - angle),
      Math.cos(Math.atan2(decision.direction.y, decision.direction.x) - angle))) : null
    cell.decisions++
    cell.referenceNoContact += Number(noContact)
    cell.referencePotential += Number(potential)
    cell.referenceAllEight += Number(truth.potentialCycles === 8)
    cell.endpointPotential += Number(endpoint === 'direction-observable')
    cell.endpointOnlyPotential += Number(endpoint === 'direction-observable' && !potential)
    cell.bestIntakePotential += Number(!noContact && truth.bestIntakeCycles >= 3)
    cell.baselineAccepted += Number(baseline.direction !== null)
    cell.accepted += Number(accepted)
    cell.correctAccepted += Number(error !== null && error <= Math.PI / 4)
    cell.acceptedNoContact += Number(noContact && accepted)
    cell.falseNoContact += Number(!noContact && predictsAbsent)
    cell.noContactPredictions += Number(predictsAbsent)
    cell.acceptedPotential += Number(potential && accepted)
    const label = `${decision.state ?? 'invalid'}|${decision.evidence}`
    cell.states[label] = (cell.states[label] ?? 0) + 1
    const confusion = `${truth.state} -> ${label}`
    cell.confusion[confusion] = (cell.confusion[confusion] ?? 0) + 1
    if (potential && !accepted) cell.rejectionReasons[decision.reason] = (cell.rejectionReasons[decision.reason] ?? 0) + 1
    cells.set(key, cell)
  }
  const run = runM30(limits, { calibrationSeedBase: M40_DESIGN.calibrationSeedBase,
    episodeSeedBase: M40_DESIGN.episodeSeedBase, resenseDecisionTime: 17, secondActionEndTime: 18,
    freshAcquisition: m37RapidFreshViews, freshDecision: m40ContactDecision,
    actionExecutor: executeM38ActionFrom, honorNonDirectionalActions: true, onDecision })
  const rows = [...cells.values()]
  return { complete: true, design: M40_DESIGN, limits, execution: summarizeM32Run(run),
    movementSafety: { firstMoveCollisions, firstMoveBlockedEndpoints,
      secondMoveCollisions: run.aggregates.reduce((total, cell) => total + cell.collisions, 0),
      secondMoveBlockedEndpoints: run.aggregates.reduce((total, cell) => total + cell.blockedEndpoints, 0) },
    staleDirections, staleNoContactClaims, allSensors: summarize(rows),
    supportedSensors: summarize(rows.filter((row) => row.nuisance !== 'slow')),
    byMap: [...new Set(rows.map((row) => row.map))].map((map) => ({ map,
      ...summarize(rows.filter((row) => row.map === map && row.nuisance !== 'slow')) })),
    controls: runM40Controls(), cells: rows }
}
