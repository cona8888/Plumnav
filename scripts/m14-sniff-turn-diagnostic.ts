import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SimulationEngine } from '../src/sim/engine'
import { distance, sub, magnitude, wrapAngle } from '../src/sim/math'
import { evaluateMultiView, selectSniffTurnPlan, MULTIVIEW_POLICY, type LocalCentralSample, type LocalQuadSample } from './lib/multiview-source-evidence'
import { evaluateFlowSourceEvidence } from './lib/flow-source-evidence'
import type { SimulationConfig, Vec2 } from '../src/sim/types'

export const M14_DESIGN = {
  schemaVersion: 'm14-sniff-turn-diagnostic-v2-bearing-aligned', diagnosticOnly: true,
  worlds: ['open-downwind-0', 'obstructed-downwind-0'],
  poses: [{ id: 'source', offset: 0, condition: 'emitting' },
    { id: 'inside-tolerance', offset: 0.005, condition: 'emitting' },
    { id: 'outside-tolerance', offset: 0.015, condition: 'emitting' },
    { id: 'far-downwind', offset: 0.06, condition: 'emitting' },
    { id: 'absent', offset: 0, condition: 'absent' }],
  sensingArms: ['geometry-active', 'geometry-passive'], policies: ['fixed', 'sniff-turn'],
  expectedJobs: 40, durationSeconds: 40, firstScanSeconds: 10, intervalSeconds: 2.5, expectedScans: 12,
  maximumWorkers: 1, scope: 'Post-hoc measurement-policy diagnostic, not autonomous source localization or validation',
} as const
const output = 'research/evidence/m14_sniff_turn_bearing_corrected_2026-09-06'
const superseded = 'research/evidence/m14_sniff_turn_2026-09-06'
const m13 = 'research/evidence/m13_flow_confirmation_2026-09-06'
const m12 = 'research/evidence/m12_confirmation_scheduling_2026-09-05'
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
type MeasurementRecord = {
  anchor: Vec2; time: number; central: LocalCentralSample[]; scans: LocalQuadSample[];
  wind: Vec2; diffusivity: number; sensorNoise: number; sensorSaturation: number;
  evidence: ReturnType<typeof evaluateMultiView>; frozenM13: ReturnType<typeof evaluateFlowSourceEvidence> | null;
}
export const m14Jobs = async () => {
  const old = JSON.parse(await readFile(join(m13, 'design.json'), 'utf8'))
  return M14_DESIGN.worlds.flatMap((world) => M14_DESIGN.poses.flatMap((pose) =>
    M14_DESIGN.sensingArms.flatMap((armId) => M14_DESIGN.policies.map((policy) => {
      const source = old.jobs.find((j: any) => j.world === world && j.poseId === 'source' && j.armId === armId)
      const near = old.jobs.find((j: any) => j.world === world && j.poseId === 'near-downwind' && j.armId === armId)
      const base = pose.condition === 'absent'
        ? old.jobs.find((j: any) => j.world === world && j.poseId === 'absent' && j.armId === armId) : source
      const anchor: Vec2 = pose.id === 'far-downwind'
        ? { ...old.jobs.find((j: any) => j.world === world && j.poseId === 'far-downwind' && j.armId === armId).position }
        : { x: source.position.x + (near.position.x - source.position.x) * pose.offset / 0.02,
          y: source.position.y + (near.position.y - source.position.y) * pose.offset / 0.02 }
      const config: SimulationConfig = { ...base.config, robotStartPositionOverride: anchor }
      const probe = new SimulationEngine(config)
      const available = !probe.environment.isBlocked(anchor, 0.014)
      const plan = policy === 'sniff-turn'
        ? selectSniffTurnPlan(anchor, armId === 'geometry-active' ? 'active-suction' : 'passive-array',
          config.activeSniffReach, config.activeSniffStrength, probe.environment.isBlocked, config.robotSpeed,
          ((config.robotStartHeadingDegrees ?? 0) * Math.PI) / 180)
        : { secondPosition: anchor, mode: 'fixed' as const, rank: null, condition: null, identifiable: null }
      return { id: `${world}-${pose.id}-${armId}-${policy}`, world, poseId: pose.id, armId, policy,
        anchor, evaluatorOffsetNormalized: pose.offset, available, config, plan }
    }))))
}
export const runM14Job = (job: Awaited<ReturnType<typeof m14Jobs>>[number]) => {
  if (!job.available) return { job, available: false, reason: 'prescribed anchor blocked; not relocated', records: [] }
  const engine = new SimulationEngine(job.config)
  const central: LocalCentralSample[] = []; const scans: LocalQuadSample[] = []; const records: MeasurementRecord[] = []
  const timing: Array<{ slot: number; issuedAt: number; deadline: number; position: Vec2; bearing: number; settledSeconds: number }> = []
  const missedSlots: number[] = []
  const initialBearing = ((job.config.robotStartHeadingDegrees ?? 0) * Math.PI) / 180
  let slot = 0; let pending = false; let bearing = initialBearing; let settledAt: number | null = 0
  let turnRadians = 0; let turningSeconds = 0
  engine.controller.step = (input) => {
    if (input.measurement.valid && input.measurement.sampleMode === 'passive') {
      central.push({ time: input.time, position: { ...input.position }, concentration: input.measurement.concentration })
    }
    if (input.measurement.quadSniff?.readings?.length) {
      const scan: LocalQuadSample = { time: input.time, position: { ...input.position }, quad: input.measurement.quadSniff,
        cycleSeconds: job.config.activeSniffCycleSeconds }
      scans.push(scan)
      const recentCentral = central.filter((s) => s.time >= input.time - MULTIVIEW_POLICY.windowSeconds)
      const recentScans = scans.filter((s) => s.time >= input.time - MULTIVIEW_POLICY.windowSeconds)
      const common = { anchor: job.anchor, time: input.time, central: recentCentral, scans: recentScans,
        wind: input.measurement.wind, diffusivity: engine.environment.scenario.diffusivity,
        sensorNoise: job.config.sensorNoise, sensorSaturation: job.config.sensorSaturation }
      const evidence = evaluateMultiView({ ...common, isBlocked: engine.environment.isBlocked })
      const frozenM13 = job.policy === 'fixed' ? evaluateFlowSourceEvidence({ ...common, position: input.position,
        quad: scan.quad, cycleSeconds: scan.cycleSeconds, isBlocked: engine.environment.isBlocked }) : null
      records.push({ ...common, evidence, frozenM13 })
      pending = false
    }
    const hold = { direction: { x: 0, y: 0 }, speedScale: 0, estimate: null, confidence: 0, phase: 'RESEARCH HOLD' }
    if (pending || slot >= M14_DESIGN.expectedScans) return hold
    const target = job.policy === 'sniff-turn' && slot % 2 === 1 ? job.plan.secondPosition : job.anchor
    const targetBearing = initialBearing + (job.policy === 'sniff-turn' && slot % 2 === 1 ? MULTIVIEW_POLICY.secondBearingRadians : 0)
    const delta = wrapAngle(targetBearing - bearing)
    const turn = Math.sign(delta) * Math.min(Math.abs(delta), MULTIVIEW_POLICY.turnRateRadiansPerSecond * input.dt)
    bearing += turn; turnRadians += Math.abs(turn); turningSeconds += Math.abs(turn) / MULTIVIEW_POLICY.turnRateRadiansPerSecond
    const travel = distance(input.position, target)
    const readyPose = travel <= MULTIVIEW_POLICY.arrivalRadius && Math.abs(wrapAngle(targetBearing - bearing)) <= 1e-10
    settledAt = readyPose ? settledAt ?? input.time : null
    const deadline = M14_DESIGN.firstScanSeconds + slot * M14_DESIGN.intervalSeconds
    if (input.time >= deadline) {
      if (settledAt !== null && input.time - settledAt >= MULTIVIEW_POLICY.settleSeconds) {
        timing.push({ slot, issuedAt: input.time, deadline, position: { ...input.position }, bearing,
          settledSeconds: input.time - settledAt })
        slot++; pending = true; settledAt = null
        return { ...hold, phase: 'RESEARCH FOUR-CHANNEL SAMPLE', quadSniff: { scanId: slot,
          forward: { x: Math.cos(bearing), y: Math.sin(bearing) } } }
      }
      missedSlots.push(slot); slot++; settledAt = null
      return { ...hold, phase: 'RESEARCH MISSED FIXED SAMPLING SLOT' }
    }
    if (travel > MULTIVIEW_POLICY.arrivalRadius) return { ...hold, direction: sub(target, input.position),
      speedScale: Math.min(1, travel / (engine.environment.maxSpeed * input.dt)), phase: 'RESEARCH MAP-SAFE REPOSITION' }
    return { ...hold, phase: readyPose ? 'RESEARCH SETTLING' : 'RESEARCH INTAKE BEARING TURN' }
  }
  const frame = engine.runToCompletion()
  const sourceDistance = engine.scenario.source ? distance(frame.robot.position, engine.scenario.source) : null
  return { job, available: true, records, central, scans, timing, missedSlots,
    finalTime: frame.metrics.elapsedSeconds, evaluatorFinalSourceDistance: sourceDistance,
    costs: { elapsedSeconds: frame.metrics.elapsedSeconds, turnRadians, turningSeconds,
      pathLengthNormalized: frame.metrics.pathLengthNormalized, collisionAttempts: frame.metrics.collisionAttempts,
      activeCycles: frame.metrics.quadSniffCycles, passiveCycles: frame.metrics.quadPassiveCycles,
      activeSamplingSeconds: frame.metrics.activeSamplingSeconds, passiveSamplingSeconds: frame.metrics.quadPassiveSamplingSeconds,
      suctionEnergy: frame.metrics.quadSuctionEnergy },
  }
}
export const runM14 = async () => {
  const supersededInventory = JSON.parse(await readFile(join(superseded, 'checksums.json'), 'utf8'))
  if (!supersededInventory.complete) throw new Error('Initial diagnostic is incomplete')
  for (const e of supersededInventory.inventory) if (hash(await readFile(join(superseded, e.path))) !== e.sha256) throw new Error('Initial evidence changed')
  const old = JSON.parse(await readFile(join(m12, 'design.json'), 'utf8'))
  for (const e of old.sourceInventory) if (hash(await readFile(e.path)) !== e.sha256) throw new Error(`M12 changed: ${e.path}`)
  const m13Inventory = JSON.parse(await readFile(join(m13, 'checksums.json'), 'utf8')).inventory
  const previousDesign = await readFile(join(m13, 'design.json'))
  if (hash(previousDesign) !== m13Inventory.find((e: any) => e.path === 'design.json').sha256) throw new Error('M13 design checksum failed')
  const paths = [...new Set([...old.sourceInventory.map((e: any) => e.path), 'scripts/lib/flow-source-evidence.ts',
    'scripts/lib/multiview-source-evidence.ts', 'scripts/multiview-source-evidence.test.ts', 'scripts/m14-sniff-turn-diagnostic.ts', 'scripts/m14-scheduling.test.ts',
    'research/protocols/m14_sniff_turn_protocol.md', 'research/protocols/m14_sniff_turn_corrected_protocol.md'])] as string[]
  const sourceInventory = await Promise.all(paths.sort().map(async (path) => {
    const bytes = await readFile(path); return { path, bytes: bytes.length, sha256: hash(bytes) }
  }))
  const jobs = await m14Jobs()
  const design = { ...M14_DESIGN, policy: MULTIVIEW_POLICY, jobs, sourceInventory,
    supersededRunSummarySha256: hash(await readFile(join(superseded, 'summary.json'))),
    correction: 'Align fixed and rotating intake bearings to the archived scenario starting heading; preserve all rules and budgets.',
    sourceInventorySha256: hash(json(sourceInventory)), m13DesignSha256: hash(previousDesign),
    runtime: { node: process.version, v8: process.versions.v8, arch: process.arch } }
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'design.json'), json(design), { flag: 'wx' })
  for (const path of paths) {
    const dest = join(output, 'source-snapshot', path)
    await mkdir(dest.slice(0, dest.lastIndexOf('/')), { recursive: true }); await copyFile(path, dest)
  }
  const startedAt = new Date().toISOString(); const summaries = []; const artifacts = ['design.json']
  for (const job of jobs) {
    const result = runM14Job(job)
    const final = result.records.slice(-6)
    const positives = final.filter((r) => r.evidence.positive).length
    const summary = { id: job.id, world: job.world, poseId: job.poseId, armId: job.armId, policy: job.policy,
      available: result.available, scans: result.records.length, planMode: job.plan.mode,
      identifiableScans: result.records.filter((r) => r.evidence.operatorIdentifiable).length,
      usableScans: result.records.filter((r) => r.evidence.usable).length,
      finalPositiveScans: positives, casePositive: final.length === 6 && positives >= 4 }
    const path = `${job.id}.json`; await writeFile(join(output, path), json({ ...result, summary }), { flag: 'wx' })
    artifacts.push(path); summaries.push(summary)
    process.stdout.write(`${summaries.length}/40 ${job.id}: identifiable=${summary.identifiableScans}/12, final positive=${positives}/6\n`)
  }
  for (const e of sourceInventory) if (hash(await readFile(e.path)) !== e.sha256) throw new Error(`Source changed during run: ${e.path}`)
  const summary = { complete: true, diagnosticOnly: true, startedAt, completedAt: new Date().toISOString(),
    peakRssBytes: process.resourceUsage().maxRSS * 1024, summaries, sourceInventorySha256: design.sourceInventorySha256 }
  await writeFile(join(output, 'summary.json'), json(summary), { flag: 'wx' }); artifacts.push('summary.json')
  const inventory = await Promise.all(artifacts.map(async (path) => {
    const bytes = await readFile(join(output, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }
  }))
  await writeFile(join(output, 'checksums.json'), json({ complete: true, inventory }), { flag: 'wx' })
  process.stdout.write(json({ completed: jobs.length, peakRssBytes: summary.peakRssBytes, sourceInventorySha256: summary.sourceInventorySha256 }))
}
if (process.env.M14_SNIFF_TURN_RUN === '1') runM14().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1
})
