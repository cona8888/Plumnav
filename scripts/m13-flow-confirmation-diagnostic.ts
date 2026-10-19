/** Known-location sensor diagnostic only. No competitive robot/controller is changed. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SimulationEngine } from '../src/sim/engine'
import { SIMULATOR_VERSION } from '../src/sim/config'
import { QuadSoilSniffController } from '../src/sim/algorithms/quadSoilSniff'
import { distance, normalize } from '../src/sim/math'
import { createM10Manifest, M10_ARMS } from './m10-geometry-development-manifest'
import { m10ArmConfig } from './m10-sharded-development'
import { surfaceDiagnostic } from './m11-confirmation-diagnostic'
import { FLOW_SOURCE_POLICY, evaluateFlowSourceEvidence, type CentralSample } from './lib/flow-source-evidence'
import type { SimulationConfig, Vec2 } from '../src/sim/types'

export const M13_DESIGN = {
  version: 'm13-flow-confirmation-diagnostic-v1', diagnosticOnly: true,
  worlds: ['open-downwind-0', 'obstructed-downwind-0'],
  poses: [
    { id: 'source', along: 0, across: 0, condition: 'emitting' },
    { id: 'near-downwind', along: 0.02, across: 0, condition: 'emitting' },
    { id: 'far-downwind', along: 0.06, across: 0, condition: 'emitting' },
    { id: 'upwind', along: -0.06, across: 0, condition: 'emitting' },
    { id: 'cross-plus', along: 0, across: 0.06, condition: 'emitting' },
    { id: 'cross-minus', along: 0, across: -0.06, condition: 'emitting' },
    { id: 'absent', along: 0, across: 0, condition: 'absent' },
  ],
  arms: ['geometry-active', 'geometry-passive'],
  durationSeconds: 40, firstScanSeconds: 10, scanIntervalSeconds: 2.5, expectedScans: 12,
  expectedJobs: 28, maximumWorkers: 1,
  samplingBudget: 'Same scan starts, four channels and duration in each arm; pump energy and footprints differ and are reported, not claimed matched.',
  claimBoundary: 'Reused development worlds at evaluator-prescribed poses. No localization success, validated probability, physical flux estimate or superiority claim.',
} as const
const output = 'research/evidence/m13_flow_confirmation_2026-09-06'
const m12 = 'research/evidence/m12_confirmation_scheduling_2026-09-05'
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const filesIn = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true }))
  .map((e) => e.isDirectory() ? filesIn(join(dir, e.name)) : Promise.resolve([join(dir, e.name)])))).flat()
export const m13Jobs = () => {
  const manifest = createM10Manifest()
  return M13_DESIGN.worlds.flatMap((world) => {
    const emitting = manifest.cells.find((c) => c.id === `${world}-emitting`)!
    const anchor = emitting.config.sourcePositionOverride!
    const probe = new SimulationEngine(m10ArmConfig(emitting, M10_ARMS[0]!))
    const along = normalize(probe.environment.windAt(anchor, 10))
    const across = { x: -along.y, y: along.x }
    return M13_DESIGN.poses.flatMap((pose) => M13_DESIGN.arms.map((armId) => {
      const cell = manifest.cells.find((c) => c.id === `${world}-${pose.condition}`)!
      const arm = M10_ARMS.find((a) => a.id === armId)!
      const position: Vec2 = { x: anchor.x + along.x * pose.along + across.x * pose.across,
        y: anchor.y + along.y * pose.along + across.y * pose.across }
      const available = position.x >= 0.012 && position.x <= 0.988 && position.y >= 0.012 && position.y <= 0.988 &&
        !probe.environment.isBlocked(position, 0.012)
      const config: SimulationConfig = { ...m10ArmConfig(cell, arm), robotStartPositionOverride: position,
        durationSeconds: M13_DESIGN.durationSeconds, checkpointSeconds: [M13_DESIGN.durationSeconds] }
      return { id: `${world}-${pose.id}-${armId}`, world, poseId: pose.id, armId, config, position, available,
        evaluatorOffsetNormalized: Math.hypot(pose.along, pose.across) }
    }))
  })
}
const runJob = (job: ReturnType<typeof m13Jobs>[number]) => {
  if (!job.available) return { job, available: false, reason: 'prescribed pose blocked or out of bounds; not relocated', scans: [] }
  const engine = new SimulationEngine(job.config)
  const central: CentralSample[] = []
  const scans: unknown[] = []
  const shadow = new QuadSoilSniffController(job.armId === 'geometry-active' ? 'active-suction' : 'passive-array', 'geometry-conditioned')
  shadow.reset(engine.environment)
  let pending = false; let scanId = 0; let nextScan = M13_DESIGN.firstScanSeconds as number
  engine.controller.step = (input) => {
    if (input.measurement.sampleMode === 'passive' && input.measurement.valid) {
      central.push({ time: input.time, concentration: input.measurement.concentration })
    }
    if (input.measurement.quadSniff?.readings?.length) {
      const evidenceInput = { position: input.position, time: input.time, cycleSeconds: job.config.activeSniffCycleSeconds,
        quad: input.measurement.quadSniff, central: central.filter((s) => s.time >= input.time - FLOW_SOURCE_POLICY.centralWindowSeconds),
        wind: input.measurement.wind, diffusivity: engine.environment.scenario.diffusivity,
        sensorNoise: job.config.sensorNoise, sensorSaturation: job.config.sensorSaturation }
      scans.push({ ...evidenceInput, flowEvidence: evaluateFlowSourceEvidence({ ...evidenceInput, isBlocked: engine.environment.isBlocked }),
        frozenSurfaceEvidence: surfaceDiagnostic(shadow, input, job.config.sensorNoise) })
      pending = false
    }
    if (!pending && input.time >= nextScan) {
      scanId++; pending = true; nextScan += M13_DESIGN.scanIntervalSeconds
      return { direction: { x: 0, y: 0 }, speedScale: 0, estimate: null, confidence: 0,
        phase: 'EVALUATION-ONLY PRESCRIBED STATIONARY SCAN',
        quadSniff: { scanId, forward: { x: Math.cos(input.heading), y: Math.sin(input.heading) } } }
    }
    return { direction: { x: 0, y: 0 }, speedScale: 0, estimate: null, confidence: 0, phase: 'EVALUATION-ONLY STATIONARY HOLD' }
  }
  const frame = engine.runToCompletion()
  if (distance(frame.robot.position, job.position) > 1e-12 || scans.length !== M13_DESIGN.expectedScans) {
    throw new Error(`Incomplete stationary diagnostic: ${job.id}`)
  }
  return { job, available: true, scans, central, finalTime: frame.metrics.elapsedSeconds,
    actualPosition: frame.robot.position, effectivePhysicsStepSeconds: (engine.plume as unknown as { stepSeconds: number }).stepSeconds,
    costs: { quadCycles: frame.metrics.quadSniffCycles, passiveCycles: frame.metrics.quadPassiveCycles,
      suctionEnergy: frame.metrics.quadSuctionEnergy, activeSeconds: frame.metrics.activeSamplingSeconds,
      passiveArraySeconds: frame.metrics.quadPassiveSamplingSeconds },
  }
}
export const runM13 = async () => {
  const previous = JSON.parse(await readFile(join(m12, 'design.json'), 'utf8'))
  for (const file of previous.sourceInventory) if (hash(await readFile(file.path)) !== file.sha256) {
    throw new Error(`M12 frozen implementation changed: ${file.path}`)
  }
  const jobs = m13Jobs()
  const sourcePaths = [...await filesIn('src/sim'), 'scripts/m13-flow-confirmation-diagnostic.ts',
    'scripts/lib/flow-source-evidence.ts', 'scripts/flow-source-evidence.test.ts', 'scripts/m11-confirmation-diagnostic.ts',
    'scripts/m10-geometry-development-manifest.ts', 'scripts/m10-sharded-development.ts',
    'research/protocols/m13_flow_confirmation_protocol.md', 'package.json', 'pnpm-lock.yaml'].sort()
  const sourceInventory = await Promise.all(sourcePaths.map(async (path) => {
    const bytes = await readFile(path); return { path, bytes: bytes.length, sha256: hash(bytes) }
  }))
  const design = { ...M13_DESIGN, simulatorVersion: SIMULATOR_VERSION, policy: FLOW_SOURCE_POLICY, jobs,
    sourceInventory, sourceInventorySha256: hash(json(sourceInventory)), preservedM12SourceFiles: previous.sourceInventory.length,
    runtime: { node: process.version, v8: process.versions.v8, architecture: process.arch } }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'design.json'), json(design), { flag: 'wx' })
  for (const path of sourcePaths) {
    const dest = join(output, 'source-snapshot', path)
    await mkdir(dest.slice(0, dest.lastIndexOf('/')), { recursive: true }); await copyFile(path, dest)
  }
  const startedAt = new Date().toISOString(); const summaries = []; const artifacts = ['design.json']
  for (const job of jobs) {
    const result = runJob(job)
    const scans = result.scans as Array<{ flowEvidence: ReturnType<typeof evaluateFlowSourceEvidence>; frozenSurfaceEvidence: { surfaceAccepted: boolean } }>
    const final = scans.slice(-FLOW_SOURCE_POLICY.finalWindowScans)
    const positive = final.filter((s) => s.flowEvidence.positive).length
    const summary = { id: job.id, world: job.world, poseId: job.poseId, armId: job.armId, available: result.available,
      scans: scans.length, usableScans: scans.filter((s) => s.flowEvidence.usable).length,
      positiveScans: scans.filter((s) => s.flowEvidence.positive).length, finalWindowPositiveScans: positive,
      casePositive: final.length === FLOW_SOURCE_POLICY.finalWindowScans && positive >= FLOW_SOURCE_POLICY.requiredPositiveScans,
      frozenSurfacePositiveScans: scans.filter((s) => s.frozenSurfaceEvidence.surfaceAccepted).length,
      frozenSurfaceCasePositive: final.length === FLOW_SOURCE_POLICY.finalWindowScans &&
        final.filter((s) => s.frozenSurfaceEvidence.surfaceAccepted).length >= FLOW_SOURCE_POLICY.requiredPositiveScans }
    const path = `${job.id}.json`; await writeFile(join(output, path), json({ ...result, summary }), { flag: 'wx' })
    artifacts.push(path); summaries.push(summary)
    process.stdout.write(`${summaries.length}/${jobs.length} ${job.id}: ${positive}/6 final positive; usable=${summary.usableScans}/12\n`)
  }
  // Recheck after execution: no mutable implementation can silently enter a run.
  for (const file of sourceInventory) if (hash(await readFile(file.path)) !== file.sha256) throw new Error(`Source changed during run: ${file.path}`)
  const summary = { complete: true, diagnosticOnly: true, startedAt, completedAt: new Date().toISOString(),
    peakRssBytes: process.resourceUsage().maxRSS * 1024, summaries, sourceInventorySha256: design.sourceInventorySha256 }
  await writeFile(join(output, 'summary.json'), json(summary), { flag: 'wx' }); artifacts.push('summary.json')
  const inventory = await Promise.all(artifacts.map(async (path) => {
    const bytes = await readFile(join(output, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }
  }))
  await writeFile(join(output, 'checksums.json'), json({ complete: true, inventory }), { flag: 'wx' })
  process.stdout.write(json(summary))
}
if (process.env.M13_FLOW_DIAGNOSTIC_RUN === '1') runM13().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1
})
