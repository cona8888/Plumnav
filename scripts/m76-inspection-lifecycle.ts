/** M76 manufactured-field commissioning. Seeded cases are NOT GSL efficacy. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { SimulationEngine } from '../src/sim/engine'
import { createDefaultConfig } from '../src/sim/config'
import { withBoundedPoseScans, withLocalInletDesign } from '../src/sim/localInletSampling'
import { GSL_REFERENCE_DESIGN } from '../src/sim/physicalDesign'
import { recordResearchRun, summarizeResearchTrace, compareScientificMetrics } from './lib/research-recorder'
import { requirePhysicalAcquisitionBudget } from './lib/physical-acquisition-budget'
import type { BatchResult, SimulationConfig, MetricSnapshot, Vec2 } from '../src/sim/types'

const output = resolve(process.argv[2] ?? 'research/evidence/m76_inspection_lifecycle_2026-09-13')
const center = { x: 0.5, y: 0.5 }
const fields = ['narrow-peak', 'broad-peak', 'uniform', 'weak', 'blank'] as const
type Field = typeof fields[number]
const configurations = []
for (const seeded of [true, false]) for (const enabled of seeded ? [false, true] : [true]) {
  for (const field of fields) {
    const config = withBoundedPoseScans(withLocalInletDesign({ ...createDefaultConfig('quad-sniff-refine', 'open'),
      seed: 76001, durationSeconds: seeded ? 300 : 600, checkpointSeconds: [seeded ? 300 : 600],
      stopOnNativeDeclaration: true, sensorNoise: 0.001, windNoise: 0,
      robotStartPositionOverride: seeded ? center : { x: 0.54, y: 0.5 } }, GSL_REFERENCE_DESIGN,
    { recoveryTimeConstantSeconds: 2, maximumTurnRateRadiansPerSecond: Math.PI / 4 }))
    config.localInletSampling!.gradientEstimator = 'relative-geometry-v1'
    if (enabled) config.localInletSampling!.candidateLifecycle = 'bounded-inspection-v1'
    configurations.push({ field, seeded, enabled, config })
  }
}
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const writeNew = (name: string, value: unknown) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
await mkdir(output, { recursive: true })
const files = ['scripts/m76-inspection-lifecycle.ts', 'scripts/lib/research-recorder.ts', 'scripts/lib/physical-acquisition-budget.ts']
async function collect(dir: string) {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${dir}/${e.name}`
    if (e.isDirectory()) await collect(path)
    else if (path.endsWith('.ts')) files.push(path)
  }
}
await collect('src/sim')
const sourceInventory = []
for (const file of files) {
  const bytes = await readFile(file), target = resolve(output, 'source-snapshot', file)
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' })
  sourceInventory.push({ file, sha256: hash(bytes) })
}
await writeNew('manifest.json', { schemaVersion: 'm76-bounded-inspection-commissioning-v1', configurations,
  manufacturedFields: { center, narrowWidthMetres: 0.06, broadWidthMetres: 3,
    peakAmplitude: 1, weakAmplitude: 0.0001, background: 0.01, uniform: 0.5, blank: 0 },
  scope: 'One fixed development seed. Prescribed stationary fields are not transport validation. Seeded candidates isolate inspection; unseeded cases exercise acquisition. Engine source-error metrics are omitted because manufactured peaks replace the scenario plume.',
  sourceInventory, runtime: { node: process.version, platform: process.platform, architecture: process.arch } })
const inventory: Array<{file: string; sha256: string; bytes: number}> = []
const retain = async (file: string, value: unknown) => {
  await writeNew(file, value)
  const bytes = await readFile(resolve(output, file)); inventory.push({ file, sha256: hash(bytes), bytes: bytes.length })
}
const summaries = []
for (const [index, spec] of configurations.entries()) {
  const { field, seeded, enabled, config } = spec
  // The archival legacy comparison is intentionally allowed to fail preflight.
  const preflight = enabled ? requirePhysicalAcquisitionBudget(config) : null
  const engine = new SimulationEngine(config)
  engine.plume.concentrationAt = (p: Vec2) => {
    const r = Math.hypot(p.x - center.x, p.y - center.y) * config.domainMeters
    return field === 'blank' ? 0 : field === 'uniform' ? 0.5 : 0.01 +
      (field === 'weak' ? 0.0001 : 1) * Math.exp(-r * r / (2 * (field === 'broad-peak' ? 3 : 0.06) ** 2))
  }
  if (seeded) Object.assign(engine.controller, {
    everPassiveHit: true, lastPassiveHitTime: 0, lastScanAt: 0, nextScanAt: 1000,
    gradientRays: [
      { time: 0, origin: { x: 0.45, y: 0.5 }, direction: { x: 1, y: 0 }, weight: 1 },
      { time: 0, origin: { x: 0.5, y: 0.45 }, direction: { x: 0, y: 1 }, weight: 1 },
      { time: 0, origin: { x: 0.55, y: 0.5 }, direction: { x: -1, y: 0 }, weight: 1 }],
    rayEstimate: { point: center, residual: 0, geometryQuality: 1, forwardFraction: 1,
      poseSpan: 0.1, quality: 1, rayCount: 3 },
    estimateHistory: [-4, -2, 0].map(time => ({ time, point: center })),
  })
  const { trace, frame } = recordResearchRun(engine)
  const access = engine.controller as unknown as { inspectionOutcome: string; gradientRays: unknown[] }
  const summary = { index, field, seeded, enabled, ...summarizeResearchTrace(trace),
    nativeDeclaration: frame.metrics.nativeDeclaration, nativeAbstention: frame.metrics.nativeAbstention,
    declarationTime: trace.find(row => row.decision.nativeTerminated)?.inputTimeSeconds ?? null,
    pathLengthMetres: frame.metrics.pathLengthMeters, inspectionOutcome: access.inspectionOutcome,
    remainingRawRays: access.gradientRays.length,
    maxProvisionalRays: frame.metrics.quadCandidateMaxProvisionalRayCount }
  // Assert commissioning expectations only for the isolated positive/negative controls.
  if (seeded && enabled && field === 'narrow-peak' && !summary.nativeDeclaration) throw new Error('Observable seeded positive control failed')
  if (['uniform', 'weak', 'blank'].includes(field) && summary.nativeDeclaration) throw new Error('Negative control declared')
  await retain(`run-${index}.json`, { config, field: field as Field, seeded, preflight, summary, trace })
  summaries.push(summary)
  process.stdout.write(`${index}: ${seeded ? 'seeded' : 'unseeded'} ${field} ${enabled ? 'bounded' : 'legacy'} declared=${summary.nativeDeclaration} ${summary.inspectionOutcome}\n`)
}
const compatibility = []
const oldManifest = JSON.parse(await readFile('research/evidence/m72_diagnostic_replay_2026-09-13/manifest.json', 'utf8')) as { inputs: Array<{ run: BatchResult }> }
const references: Array<{ config: SimulationConfig; metrics: MetricSnapshot; checkpoint: number }> =
  oldManifest.inputs.map(i => ({ config: i.run.config, metrics: i.run.metrics, checkpoint: i.run.checkpointSeconds }))
for (let index = 0; index < 8; index++) {
  const a = JSON.parse(await readFile(`research/evidence/m73_local_inlet_commissioning_2026-09-13/run-${index}.json`, 'utf8'))
  const b = JSON.parse(await readFile(`research/evidence/m74_bounded_scan_diagnostic_2026-09-13/pair-${index}.json`, 'utf8'))
  references.push({ config: a.config, metrics: a.metrics, checkpoint: 120 },
    { config: b.treatmentConfig, metrics: b.treatmentMetrics, checkpoint: 120 })
}
for (const ref of references) {
  const engine = new SimulationEngine(ref.config)
  while (!engine.isCompleted()) engine.step()
  const comparison = compareScientificMetrics(engine.getFrame().checkpoints[ref.checkpoint]!, ref.metrics)
  if (!comparison.exact) throw new Error('Archived compatibility failed')
  compatibility.push(comparison)
}
await retain('compatibility.json', compatibility)
await retain('summary.json', summaries)
const bytes = await readFile(resolve(output, 'manifest.json'))
inventory.push({ file: 'manifest.json', sha256: hash(bytes), bytes: bytes.length })
await writeNew('complete.json', { complete: true, commissionedCases: summaries.length,
  exactCompatibilityReplays: compatibility.length, inventory })
process.stdout.write(`Complete: ${summaries.length} cases, ${compatibility.length} exact compatibility replays.\n`)
