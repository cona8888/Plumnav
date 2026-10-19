import { QUAD_GEOMETRY_CONDITIONED_POLICY, QUAD_STAGED_CROSSWIND_POLICY } from '../../src/sim/algorithms/quadSoilSniff'
import type { SimulationConfig } from '../../src/sim/types'

/** Necessary time checks, not a sufficient observability or success test.
 * Applies to the current unseeded refinement controller in an unobstructed
 * flat world, with seven unskipped confirmation dwells and no extra scans
 * during confirmation. Does not reinterpret prior commissioning results.
 */
export function physicalAcquisitionBudget(config: SimulationConfig) {
  const p = config.localInletSampling
  if (!p || config.algorithmId !== 'quad-sniff-refine' || config.scenarioKind !== 'open') {
    throw new Error('Budget audit requires local-inlet refinement in an open world')
  }
  if (config.robotSpeed <= 0) throw new Error('Acquisition requires positive robot speed')
  const rays = QUAD_STAGED_CROSSWIND_POLICY.minimumRayCount
  const separation = p.bearingGeometry && p.bearingAblation !== 'legacy-spacing' ? 2 * p.opposingInletSpacingMetres :
    QUAD_STAGED_CROSSWIND_POLICY.minimumOriginSeparationNormalized * config.domainMeters
  const minimumTravel = (rays - 1) * separation / (config.robotSpeed * config.domainMeters)
  const minimumScans = rays * config.activeSniffCycleSeconds
  const confirmation = 7 * p.inspection.dwellSeconds
  const lowerBound = minimumTravel + minimumScans + confirmation
  const retention = QUAD_GEOMETRY_CONDITIONED_POLICY.rayRetentionSeconds
  const issues: string[] = []
  if (config.durationSeconds < lowerBound) issues.push('mission-shorter-than-optimistic-end-to-end-lower-bound')
  if (!p.candidateLifecycle && confirmation >= retention) issues.push('unrefreshed-rays-expire-before-seven-dwell-confirmation')
  const nominalViewpoint = Math.hypot(
    Math.min(...QUAD_GEOMETRY_CONDITIONED_POLICY.viewpointAdvanceNormalized),
    Math.min(...QUAD_GEOMETRY_CONDITIONED_POLICY.viewpointLateralOffsetNormalized),
  ) * config.domainMeters
  return { schemaVersion: 'physical-acquisition-budget-v1',
    ...(p.candidateLifecycle ? { candidateLifecycle: p.candidateLifecycle,
      requiresRuntimeInspectionBudget: true } : {}),
    minimumRayCount: rays, minimumPoseSeparationMetres: separation,
    optimisticTravelSeconds: minimumTravel, optimisticScanSeconds: minimumScans,
    minimumConfirmationDwellSeconds: confirmation, optimisticTotalSeconds: lowerBound,
    missionSeconds: config.durationSeconds, rayRetentionSeconds: retention,
    smallestNominalViewpointOffsetMetres: nominalViewpoint,
    nominalPointToPointViewpointSecondsAtPolicySpeed: nominalViewpoint / (config.robotSpeed * config.domainMeters * 0.66),
    issues, passesNecessaryChecks: issues.length === 0,
    caveat: 'Lower bound excludes search, turning, target approach, inter-waypoint movement and repeated scans. Nominal viewpoint time is not a hard lower bound because arrival radii permit early stopping.' }
}

/** Call before a future efficacy campaign; diagnostic fixtures may report failures without running a campaign. */
export function requirePhysicalAcquisitionBudget(config: SimulationConfig) {
  const audit = physicalAcquisitionBudget(config)
  if (!audit.passesNecessaryChecks) throw new Error(`Physical acquisition preflight failed: ${audit.issues.join(', ')}`)
  return audit
}
