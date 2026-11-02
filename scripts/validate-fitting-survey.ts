/** Four mapped fittings, unlabelled to the controller; single-release and blank challenges. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AssetInspectionController } from '../src/sim/algorithms/assetInspection'
import { createDefaultConfig } from '../src/sim/config'
import { SimulationEngine } from '../src/sim/engine'
import { GSL_REFERENCE_DESIGN } from '../src/sim/physicalDesign'
import { evaluateArchivedLeakRun } from '../src/sim/researchEvaluation'
import type { SimulationConfig, Vec2 } from '../src/sim/types'
import { runBenchCalibration, syntheticBenchTraces, withCalibratedSIInlet } from './field-sensor-calibration'
import { SI_HALFSPACE_REFERENCE } from './lib/si-research-config'

const side = 6 // metres
const fittings = [{ x: 2, y: 2 }, { x: 2, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 2 }]
const methods = ['asset-inspection', 'surge-cast', 'quad-sniff-refine'] as const
const normalise = (p: Vec2) => ({ x: p.x / side, y: p.y / side })
const id = (i: number) => 'ABCD'[i]!
const flags = process.argv.slice(2).filter(arg => arg.startsWith('--'))
const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
if (flags.some(flag => !['--legacy', '--challenge', '--holdout'].includes(flag)) || args.length > 2 || (flags.includes('--challenge') && flags.includes('--holdout'))) {
  throw new Error('Usage: validate-fitting-survey.ts [--legacy] [--challenge | --holdout] [new-output-directory [bench-report.json]]')
}
const challenge = flags.includes('--challenge')
const holdout = flags.includes('--holdout')
const verified = !flags.includes('--legacy')
const budget = verified || challenge || holdout ? 450 : 360 // reproduce the original standard legacy run
const output = resolve(args[0] ?? `benchmark-output/fitting-survey-${verified ? 'bracket' : 'legacy'}${challenge ? '-challenge' : holdout ? '-holdout' : ''}`)
const bench = args[1] ? JSON.parse(await readFile(args[1], 'utf8')) : (() => {
  const { training, holdout } = syntheticBenchTraces()
  return { dataSource: 'manufactured independent pulse traces', ...runBenchCalibration(training, holdout) }
})()
if (!bench.fit || !bench.fit.setup || ![bench.fit.riseSeconds, bench.fit.recoverySeconds].every(x => Number.isFinite(x) && x > 0)) {
  throw new Error('Expected the JSON report from field-sensor-calibration.cli.ts')
}
const design = { ...GSL_REFERENCE_DESIGN, domainMetres: side, referenceWindMetresPerSecond: 0.02 }
// On measured replays use exactly the four setup quantities recorded by the bench fit.
for (const key of ['tubeLengthMetres', 'tubeInnerDiameterMetres', 'actualFlowLitresPerMinute', 'averagingSeconds'] as const) {
  if (!Number.isFinite(bench.fit.setup[key])) throw new Error(`Missing or invalid bench setup: ${key}`)
  design[key] = bench.fit.setup[key]
}
const arms: { name: string; fitting: number | null; source: Vec2 | null; wind: number; replicate: number; speed?: number; duration?: number }[] = []
for (const [replicate, wind] of (challenge || holdout ? [] : [90, 270]).entries()) {
  const dx = replicate === 0 ? 0.06 : -0.08
  const dy = replicate === 0 ? 0.08 : 0.06
  for (const [index, p] of fittings.entries()) {
    const offsetScale = (index + replicate) % 2 === 0 ? 0.5 : 1
    arms.push({ name: `${id(index)}-${wind}`, fitting: index, source: { x: p.x + offsetScale * dx, y: p.y + offsetScale * dy }, wind, replicate })
  }
  arms.push({ name: `blank-${wind}`, fitting: null, source: null, wind, replicate })
  // Deliberately put a non-asset source upwind of fitting A in each wind orientation.
  arms.push({ name: `off-map-${wind}`, fitting: null, source: { x: 2 + (replicate === 0 ? -0.5 : 0.5), y: 2 }, wind, replicate })
}
// A separate stress set rotates both the wind and the implicated fitting and includes a crosswind interferer.
// Geometry, noise seeds and offsets are independent of the historical A/90° and A/270° cases.
if (challenge) {
  for (const [k, wind] of [35, 155, 290].entries()) {
    const fitting = [1, 2, 3][k]!, p = fittings[fitting]!, angle = wind * Math.PI / 180
    const flow = { x: Math.sin(angle), y: -Math.cos(angle) }
    const point = (along: number, across: number) => ({ x: p.x + along * flow.x - across * flow.y,
      y: p.y + along * flow.y + across * flow.x })
    const common = { wind, replicate: 31 + k }
    arms.push({ ...common, name: `near-${wind}`, fitting, source: point(0, 0.08) },
      { ...common, name: `upwind-${wind}`, fitting: null, source: point(-0.6, 0.06) },
      { ...common, name: `lateral-${wind}`, fitting: null, source: point(0, 0.25) },
      { ...common, name: `blank-${wind}`, fitting: null, source: null })
  }
  arms.push({ name: 'weak-wind', wind: 35, replicate: 40, fitting: 1, source: fittings[1]!, speed: 0.003 },
    { name: 'short-budget', wind: 35, replicate: 41, fitting: 1, source: fittings[1]!, duration: 295 })
}
// Keep the previously scored holdout geometry fixed and available to other users in ordinary Git.
if (holdout) {
  const source = new URL('../validation/synthetic/fitting-holdout/cases.json', import.meta.url)
  arms.push(...JSON.parse(await readFile(source, 'utf8')))
}
const configs: SimulationConfig[] = []
const rows: (string | number | null)[][] = []
const readouts: (string | number)[][] = []
const visits: (string | number | null)[][] = []
const controls: (string | number | null)[][] = []
const decisions: (string | number | null)[][] = []
const csvValue = (v: string | number | null) => {
  const text = v === null ? '' : String(v)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
const formatCsv = (records: (string | number | null)[][]) => records.map(r => r.map(csvValue).join(',')).join('\n') + '\n'
await mkdir(resolve(output, '..'), { recursive: true })
await mkdir(output) // Preserve earlier measurements, including incomplete runs.
for (const arm of arms) {
  for (const method of (challenge || holdout ? ['asset-inspection'] as const : methods)) {
    const base = { ...createDefaultConfig(method, 'open'),
      ...(method === 'asset-inspection' ? { inspectionStations: fittings.map(normalise),
        ...(!verified ? { assetVerification: undefined } : {}) } : {}),
      targetStatus: arm.source ? 'emitting' as const : 'absent' as const,
      ...(arm.source ? { sourcePositionOverride: normalise(arm.source) } : {}),
      robotStartPositionOverride: normalise({ x: 1, y: 3 }), robotStartHeadingDegrees: 0,
      seed: 81000 + arm.replicate, sourceSeed: 82000 + arm.replicate,
      controllerSeed: 83000 + arm.replicate, observationModelSeed: 84000 + arm.replicate,
      windDirectionDegrees: arm.wind, windNoise: 0, durationSeconds: arm.duration ?? budget, checkpointSeconds: [arm.duration ?? budget],
    }
    const config = withCalibratedSIInlet(base, bench.fit,
      { ...design, referenceWindMetresPerSecond: arm.speed ?? design.referenceWindMetresPerSecond }, SI_HALFSPACE_REFERENCE)
    if (method === 'quad-sniff-refine') Object.assign(config.localInletSampling!, {
      gradientEstimator: 'relative-geometry-v1', candidateLifecycle: 'bounded-inspection-v1',
      acquisitionPolicy: 'time-budgeted-viewpoints-v1', bearingGeometry: 'linearized-local-bearing-v1',
      rayWindowPolicy: 'rolling-expiry-v1', localGradientPolicy: 'head-step-v1', localMaximumPolicy: 'fresh-cross-v1',
    })
    configs.push(config)
    const engine = new SimulationEngine(config)
    const frame = engine.runToCompletion()
    const m = frame.metrics
    const score = evaluateArchivedLeakRun(config, m, frame.scenario.source)
    // A proposed follow-up visit has its own outcome, distinct from a native source declaration.
    const inspection = engine.controller instanceof AssetInspectionController ? engine.controller : null
    const stationIndex = inspection?.getNominatedStationIndex() ?? null
    const nominated = stationIndex === null ? null : id(stationIndex)
    const nominationOffset = stationIndex !== null && arm.source
      ? Math.hypot(fittings[stationIndex]!.x - arm.source.x, fittings[stationIndex]!.y - arm.source.y) : null
    if (inspection && m.nativeDeclaration) throw new Error('A fitting nomination cannot certify a source')
    if (score.outcome === 'pending' || !Number.isFinite(m.pathLengthMeters) || !frame.observations.length ||
        frame.observations.some(o => !Number.isFinite(o.concentration) || !Number.isFinite(o.position.x) || !Number.isFinite(o.position.y))) {
      throw new Error(`Invalid completed mission: ${arm.name} ${method}`)
    }
    const maxPpm = Math.max(0, ...frame.observations.map(o => o.concentration * config.sensorPpmPerNormalizedUnit))
    decisions.push([arm.name, method, frame.decision.phase, frame.completionReason, score.outcome, nominated])
    rows.push([arm.name, method, arm.fitting === null ? null : id(arm.fitting), nominated, nominationOffset, score.outcome,
      m.declarationErrorNormalized === null ? null : m.declarationErrorNormalized * side, score.eventTimeSeconds, m.elapsedSeconds,
      m.pathLengthMeters, m.hitCount, frame.observations.length, maxPpm, m.collisionAttempts])
    for (const o of frame.observations) {
      readouts.push([arm.name, method, o.time, o.position.x * side, o.position.y * side,
        o.concentration * config.sensorPpmPerNormalizedUnit, Number(o.hit), o.sampleMode,
        o.localInletReadings?.filter(c => c.saturated).length ?? 0])
    }
    if (inspection) {
      for (const v of inspection.getVerificationVisits()) controls.push([arm.name, v.role, id(v.stationIndex),
        v.position.x * side, v.position.y * side, v.arrivedAt, v.departedAt, v.sampleCount, v.hitCount, v.clippedCount,
        Number(v.windAligned), v.median === null ? null : v.median * config.sensorPpmPerNormalizedUnit])
      for (const v of inspection.getVisits()) visits.push([arm.name, v.pass, id(v.stationIndex), v.arrivedAt, v.departedAt,
        v.sampleCount, v.hitCount, v.clippedCount, v.median === null ? null : v.median * config.sensorPpmPerNormalizedUnit])
    }
    console.log(`${arm.name} ${method}: ${score.outcome}, nominated ${nominated ?? 'none'}`)
  }
}
await writeFile(join(output, 'protocol.json'), JSON.stringify({ node: process.version, design, bench, fittingsMetres: fittings,
  arms, configs, verified, challenge, holdout, strictSourceToleranceMetres: side * 0.01 }, null, 2) + '\n')
await writeFile(join(output, 'readings.csv'), formatCsv([['case','method','time_s','robot_x_m','robot_y_m','ch4_excess_ppm','hit','mode','clipped_channels'], ...readouts]))
await writeFile(join(output, 'visits.csv'), formatCsv([['case','pass','fitting','arrival_s','departure_s','sample_count','hit_count','clipped_count','median_excess_ppm'], ...visits]))
await writeFile(join(output, 'verification-visits.csv'), formatCsv([['case','role','fitting','sample_x_m','sample_y_m','arrival_s','departure_s',
  'sample_count','hit_count','clipped_count','wind_aligned','median_excess_ppm'], ...controls]))
await writeFile(join(output, 'decisions.csv'), formatCsv([['case','method','phase','stop_reason','strict_source_outcome','flagged_fitting'], ...decisions]))
await writeFile(join(output, 'missions.csv'), formatCsv([['case','method','emitting_fitting','flagged_fitting','flag_to_source_m','strict_source_outcome','declared_error_m',
  'decision_s','elapsed_s','path_m','passive_hits','valid_samples','max_excess_ppm','blocked_motion_ticks'], ...rows]))
console.log(`Wrote ${rows.length} missions to ${output}`)
