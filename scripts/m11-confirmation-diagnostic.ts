/** Evaluation-only diagnostics; never registered as a competitive algorithm. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SimulationEngine } from '../src/sim/engine'
import { batchResultsToCsv } from '../src/sim/batch'
import { CONTROLLER_OBSERVATION_MODEL_VERSION } from '../src/sim/controllerObservationModel'
import { QuadSoilSniffController, estimateQuadGradient, evaluateQuadDeclarationEvidence } from '../src/sim/algorithms/quadSoilSniff'
import { distance } from '../src/sim/math'
import type { AlgorithmStepInput, BatchResult, QuadSniffChannelReading, QuadDeclarationEvidenceStatus, Vec2 } from '../src/sim/types'
import { createM10Manifest, M10_ARMS } from './m10-geometry-development-manifest'
import { m10ArmConfig } from './m10-sharded-development'

const archive = 'research/evidence/m10_geometry_conditioned_development_2026-09-05'
const output = 'research/evidence/m11_confirmation_diagnostic_2026-09-05'
export const M11_DESIGN = {
  schemaVersion: 'm11-confirmation-diagnostic-v1',
  scope: 'post-hoc development diagnosis; known-source controls are not localization results',
  stationaryCells: ['open-downwind-0-emitting', 'obstructed-downwind-0-emitting'],
  stationaryArms: ['geometry-active', 'geometry-passive'],
  sensorConditions: ['original', 'zero-additive-noise'],
  stationaryDurationSeconds: 40,
  firstScanSeconds: 10,
  scanIntervalSeconds: 2.5,
  traceCells: ['open-downwind-0-emitting', 'obstructed-downwind-2-emitting'],
  traceArm: 'geometry-active',
  traceDurationSeconds: 180,
  expectedRuns: 10,
  fixedController: 'quad-geometry-conditioned-v1',
  noCompetitiveControllerChanges: true,
} as const

// Explicit diagnostic access to frozen internals. Production code is untouched.
type DiagnosticAccess = {
  acceptQuadReturn(input: AlgorithmStepInput): ReturnType<typeof estimateQuadGradient>
  declarationEvidence(input: AlgorithmStepInput): QuadDeclarationEvidenceStatus
  surfaceEvidence: Array<{ time: number; position: Vec2; score: number }>
  confirmationIndex: number
  confirmationCandidate: Vec2 | null
  confirmationCompletedAt: number | null
  lastFailedConfirmationAt: number
  gradientRays: unknown[]
}
const access = (controller: unknown) => controller as DiagnosticAccess
const hash = (contents: string | Uint8Array) => createHash('sha256').update(contents).digest('hex')
const json = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`
const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  return { count: n, min: n ? sorted[0] : null, max: n ? sorted[n - 1] : null,
    median: n ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2 : null }
}

export const surfaceDiagnostic = (controller: QuadSoilSniffController, input: AlgorithmStepInput, sensorNoise: number) => {
  const readings = input.measurement.quadSniff?.readings ?? []
  const gradient = estimateQuadGradient(readings, sensorNoise)
  access(controller).acceptQuadReturn(input)
  const accepted = access(controller).surfaceEvidence.at(-1)?.time === input.time
  return {
    time: input.time, position: { ...input.position }, readings,
    ...gradient,
    anySaturated: readings.some((reading) => reading.saturated),
    surfaceAccepted: accepted,
    surfaceScore: accepted ? access(controller).surfaceEvidence.at(-1)!.score : null,
  }
}

export const idealReadings = (concentration: number, saturated = false): QuadSniffChannelReading[] =>
  (['front', 'left', 'aft', 'right'] as const).map((channel, i) => {
    const angle = -i * Math.PI / 2
    const direction = { x: Math.cos(angle), y: Math.sin(angle) }
    return { channel, direction, reach: 0.06, support: 1, effectiveOffset: { x: direction.x * 0.04, y: direction.y * 0.04 },
      concentration, saturated, hit: concentration >= 0.1, integrationSamples: 4, effectiveIntegrationSamples: 4 }
  })

const verifyFrozenSource = async () => {
  const implementation = JSON.parse(await readFile(join(archive, 'implementation.json'), 'utf8'))
  const digest = createHash('sha256')
  for (const entry of implementation.files) {
    const bytes = await readFile(entry.path)
    if (hash(bytes) !== entry.sha256) throw new Error(`M10 source changed: ${entry.path}`)
    digest.update(entry.path); digest.update('\0'); digest.update(bytes); digest.update('\0')
  }
  if (digest.digest('hex') !== implementation.implementationSha256) throw new Error('Frozen source identity mismatch')
  return implementation.implementationSha256 as string
}

const stationaryConfig = (cellId: string, armId: string, noise: string) => {
  const manifest = createM10Manifest()
  const cell = manifest.cells.find((cell) => cell.id === cellId)!
  const arm = M10_ARMS.find((arm) => arm.id === armId)!
  const config = { ...m10ArmConfig(cell, arm), durationSeconds: 40, checkpointSeconds: [40],
    robotStartPositionOverride: { ...cell.config.sourcePositionOverride! },
    ...(noise === 'zero-additive-noise' ? { sensorNoise: 0, windNoise: 0 } : {}) }
  return { cell, config }
}

const stationary = (cellId: string, armId: string, noise: string) => {
  const { cell, config } = stationaryConfig(cellId, armId, noise)
  const engine = new SimulationEngine(config)
  const shadow = new QuadSoilSniffController(armId === 'geometry-passive' ? 'passive-array' : 'active-suction', 'geometry-conditioned')
  shadow.reset(engine.environment)
  const returns: ReturnType<typeof surfaceDiagnostic>[] = []
  let scanId = 0
  let pending = false
  let nextScan = M11_DESIGN.firstScanSeconds as number
  engine.controller.step = (input) => {
    if (input.measurement.quadSniff?.readings?.length) {
      returns.push(surfaceDiagnostic(shadow, input, config.sensorNoise))
      pending = false
    }
    if (!pending && input.time >= nextScan) {
      pending = true; scanId += 1; nextScan += M11_DESIGN.scanIntervalSeconds
      return { direction: { x: 0, y: 0 }, estimate: null, confidence: 0, phase: 'EVALUATION-ONLY KNOWN-SOURCE STATIONARY SCAN',
        quadSniff: { scanId, forward: { x: Math.cos(input.heading), y: Math.sin(input.heading) } } }
    }
    return { direction: { x: 0, y: 0 }, estimate: null, confidence: 0, phase: 'EVALUATION-ONLY STATIONARY HOLD' }
  }
  engine.runToCompletion()
  const positionError = distance(engine.getFrame().robot.position, cell.config.sourcePositionOverride!)
  if (positionError > 1e-12) throw new Error('Stationary control moved away from the prescribed source')
  if (returns.length !== 12) throw new Error(`Expected 12 stationary scans; got ${returns.length}`)
  return { cellId, armId, noise, config, diagnosticOnly: true, knownSourcePositionError: positionError,
    summary: { scans: returns.length, accepted: returns.filter((r) => r.surfaceAccepted).length,
      saturated: returns.filter((r) => r.anySaturated).length,
      commonMean: summarize(returns.map((r) => r.commonMean)),
      contrast: summarize(returns.map((r) => r.normalizedContrast)),
      lowContrast: returns.filter((r) => r.normalizedContrast <= 0.22).length }, returns }
}

const trace = async (cellId: string) => {
  const cell = createM10Manifest().cells.find((cell) => cell.id === cellId)!
  const config = m10ArmConfig(cell, M10_ARMS[0]!)
  const engine = new SimulationEngine(config)
  const originalStep = engine.controller.step.bind(engine.controller)
  const state = access(engine.controller)
  const source = cell.config.sourcePositionOverride!
  const records: Array<Record<string, unknown>> = []
  const scans: Array<Record<string, unknown>> = []
  const shadow = new QuadSoilSniffController('active-suction', 'geometry-conditioned')
  shadow.reset(engine.environment)
  let previousFailure = -Infinity
  let failedConfirmations = 0
  engine.controller.step = (input) => {
    const decision = originalStep(input)
    const evidence = state.declarationEvidence(input)
    if (input.measurement.quadSniff?.readings?.length) {
      scans.push({ ...surfaceDiagnostic(shadow, input, config.sensorNoise),
        distanceToSource: distance(input.position, source),
        candidate: evidence.candidate,
        candidateError: evidence.candidate ? distance(evidence.candidate, source) : null })
    }
    if (state.lastFailedConfirmationAt !== previousFailure) { failedConfirmations += 1; previousFailure = state.lastFailedConfirmationAt }
    records.push({ time: input.time, position: input.position, phase: decision.phase,
      sampleMode: input.measurement.sampleMode, candidate: evidence.candidate,
      candidateError: evidence.candidate ? distance(evidence.candidate, source) : null,
      distanceToSource: distance(input.position, source),
      confirmationIndex: state.confirmationIndex, confirmationCandidate: state.confirmationCandidate,
      confirmationCompletedAt: state.confirmationCompletedAt, failedConfirmations,
      rayCount: state.gradientRays.length, ready: evidence.ready, raw: evidence.raw, gates: evidence.gates })
    return decision
  }
  const frame = engine.runToCompletion()
  const result: BatchResult = { algorithmId: config.algorithmId, scenarioKind: cell.scenarioKind, seed: config.seed,
    checkpointSeconds: 180, config, observationModelVersion: CONTROLLER_OBSERVATION_MODEL_VERSION,
    observationModelSeed: config.observationModelSeed, metrics: frame.checkpoints[180]!,
    effectivePhysicsStepSeconds: (engine.plume as { stepSeconds: number }).stepSeconds }
  const [newHeader, newRow] = batchResultsToCsv([result]).trimEnd().split('\n')
  const archivedLines = (await readFile(join(archive, 'cells', `${cellId}.csv`), 'utf8')).trimEnd().split('\n')
  const archivedHeader = archivedLines[0]!.split(',')
  const archivedRow = archivedLines[1]!.split(',')
  const values = newRow!.split(',')
  let matchedColumns = 0
  for (const [index, column] of newHeader!.split(',').entries()) {
    if (['mean_compute_ms', 'p95_compute_ms'].includes(column)) continue
    if (values[index] !== archivedRow[archivedHeader.indexOf(column)]) throw new Error(`${cellId}: instrumented replay changed ${column}`)
    matchedColumns += 1
  }
  return { cellId, matchedScientificColumns: matchedColumns, failedConfirmations,
    summary: { scans: scans.length, acceptedSurfaceScans: scans.filter((r) => r.surfaceAccepted).length,
      minimumScanSourceDistance: Math.min(...scans.map((r) => r.distanceToSource as number)),
      maximumConfirmationIndex: Math.max(...records.map((r) => r.confirmationIndex as number)),
      simultaneousReadyTicks: records.filter((r) => r.ready).length }, scans, records }
}

export const runM11 = async () => {
  const implementationSha256 = await verifyFrozenSource()
  await mkdir(output, { recursive: true })
  const design = { ...M11_DESIGN, implementationSha256,
    diagnosticScriptSha256: hash(await readFile('scripts/m11-confirmation-diagnostic.ts')) }
  const resumeMetadataFix = process.env.M11_RESUME_METADATA_FIX === '1'
  if (resumeMetadataFix) {
    const initial = JSON.parse(await readFile(join(output, 'design.json'), 'utf8'))
    const initialSource = await readFile(join(output, 'diagnostic-source-initial.ts'))
    if (initial.diagnosticScriptSha256 !== hash(initialSource) ||
        initial.diagnosticScriptSha256 !== 'ee7cde46d42d5a7bf947f1a633bb3d0a1a013b80d62e5646eb1bdcc3808f399c' ||
        JSON.stringify({ ...initial, diagnosticScriptSha256: design.diagnosticScriptSha256 }) !== JSON.stringify(design)) {
      throw new Error('Initial diagnostic design/source mismatch')
    }
    await writeFile(join(output, 'export-metadata-correction.json'), json({ design,
      reason: 'Replay result exporter omitted effectivePhysicsStepSeconds; add engine timestep metadata. No design, sensor, controller or physics change.',
      initialDiagnosticScriptSha256: initial.diagnosticScriptSha256 }), { flag: 'wx' })
  } else await writeFile(join(output, 'design.json'), json(design), { flag: 'wx' })
  const startedAt = new Date().toISOString()
  const idealInput = { ray: { quality: 1, residual: 0 }, stability: { count: 4, span: 4, radius: 0 },
    surface: { count: 2, meanScore: 0.78 }, passive: { coreCount: 6, coreHits: 6, ringCount: 5, coreMean: 0.8, contrast: 0.5 },
    secondsSincePassiveHit: 0, distanceToCandidate: 0 }
  const ideal = evaluateQuadDeclarationEvidence(idealInput)
  if (!ideal.ready) throw new Error('Ideal complete evidence failed the frozen declaration rule')
  const summaries: unknown[] = []
  const files = ['design.json']
  if (resumeMetadataFix) files.push('diagnostic-source-initial.ts', 'export-metadata-correction.json')
  for (const cellId of M11_DESIGN.stationaryCells) for (const armId of M11_DESIGN.stationaryArms) for (const noise of M11_DESIGN.sensorConditions) {
    const filename = `stationary-${cellId}-${armId}-${noise}.json`
    const result = resumeMetadataFix
      ? JSON.parse(await readFile(join(output, filename), 'utf8')) as ReturnType<typeof stationary>
      : stationary(cellId, armId, noise)
    if (JSON.stringify(result.config) !== JSON.stringify(stationaryConfig(cellId, armId, noise).config) ||
        result.cellId !== cellId || result.armId !== armId || result.noise !== noise ||
        result.returns.length !== 12 || result.knownSourcePositionError !== 0) {
      throw new Error(`Stationary control identity mismatch: ${filename}`)
    }
    if (!resumeMetadataFix) await writeFile(join(output, filename), json(result), { flag: 'wx' })
    files.push(filename)
    summaries.push({ cellId, armId, noise, ...result.summary })
    process.stdout.write(`Completed stationary control ${cellId}/${armId}/${noise}\n`)
  }
  const traces = []
  for (const cellId of M11_DESIGN.traceCells) {
    const result = await trace(cellId)
    const filename = `trace-${cellId}.json`
    await writeFile(join(output, filename), json(result), { flag: 'wx' }); files.push(filename)
    traces.push({ cellId, matchedScientificColumns: result.matchedScientificColumns,
      failedConfirmations: result.failedConfirmations, ...result.summary })
    process.stdout.write(`Completed exact scientific replay ${cellId}\n`)
  }
  const summary = { schemaVersion: M11_DESIGN.schemaVersion, diagnosticOnly: true, complete: true,
    startedAt, completedAt: new Date().toISOString(), design, idealInput, ideal, stationary: summaries, traces }
  await writeFile(join(output, 'summary.json'), json(summary), { flag: 'wx' }); files.push('summary.json')
  const inventory = await Promise.all(files.map(async (path) => {
    const bytes = await readFile(join(output, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }
  }))
  await writeFile(join(output, 'checksums.json'), json({ complete: true, inventory }), { flag: 'wx' })
  process.stdout.write(json(summary))
}

if (process.env.M11_DIAGNOSTIC_RUN === '1') runM11().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1
})
