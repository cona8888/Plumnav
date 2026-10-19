/** Paired scheduling diagnostic; no threshold fitting or transport-validation claim. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { SimulationEngine } from '../src/sim/engine'
import { recordResearchRun, summarizeResearchTrace, compareScientificMetrics } from './lib/research-recorder'
import { auditAcquisitionReturns } from './lib/acquisition-return-audit'
import { requirePhysicalAcquisitionBudget } from './lib/physical-acquisition-budget'
import type { BatchResult, SimulationConfig, MetricSnapshot, Vec2, AlgorithmStepInput } from '../src/sim/types'
import type { QuadGradientEstimate } from '../src/sim/algorithms/quadSoilSniff'

const output = resolve(process.argv[2] ?? 'research/evidence/m77_acquisition_scheduling_2026-09-13')
const m76 = 'research/evidence/m76_inspection_lifecycle_2026-09-13'
const manifest = JSON.parse(await readFile(`${m76}/manifest.json`, 'utf8'))
const fields = ['narrow-peak', 'broad-peak', 'uniform', 'weak', 'blank', 'near-peak'] as const
const cases = []
for (const seed of [76001, 77002]) for (const field of fields) for (const scheduled of [false, true]) {
  const index = field === 'near-peak' ? 11 : 10 + fields.indexOf(field)
  const config = structuredClone(manifest.configurations[index].config) as SimulationConfig
  config.seed = seed
  if (field === 'near-peak') config.robotStartPositionOverride = { x: 0.508, y: 0.5 }
  if (scheduled) config.localInletSampling!.acquisitionPolicy = 'time-budgeted-viewpoints-v1'
  cases.push({ field, seed, scheduled, config })
}
await mkdir(output, { recursive: true })
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const writeNew = (file: string, data: unknown) => writeFile(resolve(output, file), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' })
const files = ['scripts/m77-acquisition-scheduling.ts', 'scripts/lib/acquisition-return-audit.ts',
  'scripts/lib/research-recorder.ts', 'scripts/lib/physical-acquisition-budget.ts']
async function collect(dir: string) {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${dir}/${e.name}`
    if (e.isDirectory()) await collect(file)
    else if (file.endsWith('.ts')) files.push(file)
  }
}
await collect('src/sim')
const sourceInventory = []
for (const file of files) {
  const bytes = await readFile(file), target = resolve(output, 'source-snapshot', file)
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' })
  sourceInventory.push({ file, sha256: hash(bytes) })
}
const archiveManifestBytes = await readFile(`${m76}/manifest.json`)
await writeNew('manifest.json', { schemaVersion: 'm77-scheduling-only-v1', cases, sourceInventory,
  m76ManifestSha256: hash(archiveManifestBytes),
  prescribedFields: { center: { x: 0.5, y: 0.5 }, narrowWidthMetres: 0.06, broadWidthMetres: 3,
    nearWidthMetres: 0.6, amplitude: 1, weakAmplitude: 0.0001, background: 0.01, uniform: 0.5, blank: 0 },
  fixedGates: { raySeparationNormalized: 0.018, rayRetentionSeconds: 75, unchangedSignalAndGeometryGates: true },
  purpose: 'Unseeded paired scheduling diagnostic. Not a physical transport model, commercial sensor calibration or held-out benchmark.',
  runtime: { node: process.version, platform: process.platform, architecture: process.arch } })
const inventory: Array<{ file: string; sha256: string; bytes: number }> = []
async function retain(file: string, data: unknown) {
  await writeNew(file, data)
  const bytes = await readFile(resolve(output, file)); inventory.push({ file, sha256: hash(bytes), bytes: bytes.length })
}
const summaries = [], traceCompatibility = []
for (const [index, spec] of cases.entries()) {
  const { config, field, scheduled, seed } = spec
  const preflight = requirePhysicalAcquisitionBudget(config)
  const engine = new SimulationEngine(config)
  const width = field === 'broad-peak' ? 3 : field === 'near-peak' ? 0.6 : 0.06
  engine.plume.concentrationAt = p => {
    const r = Math.hypot(p.x - 0.5, p.y - 0.5) * config.domainMeters
    return field === 'blank' ? 0 : field === 'uniform' ? 0.5 : 0.01 +
      (field === 'weak' ? 0.0001 : 1) * Math.exp(-r * r / (2 * width ** 2))
  }
  const access = engine.controller as unknown as {
    gradientRays: Array<{ time: number; origin: Vec2; direction: Vec2 }>
    acceptQuadReturn(input: AlgorithmStepInput): QuadGradientEstimate
  }
  const original = access.acceptQuadReturn.bind(access), returnDecisions: unknown[] = []
  access.acceptQuadReturn = input => {
    const before = structuredClone(access.gradientRays)
    const result = original(input)
    const after = structuredClone(access.gradientRays)
    const added = after.some(ray => ray.time === input.time)
    const separation = before.length ? Math.min(...before.map(ray => Math.hypot(
      ray.origin.x - input.position.x, ray.origin.y - input.position.y))) : null
    returnDecisions.push({ time: input.time, position: input.position, result, before, after,
      minimumOriginDistanceMetres: separation === null ? null : separation * config.domainMeters,
      reason: added ? 'accepted-ray' : !result.validDirection ? 'direction-gate' :
        result.commonMean < 0.16 || result.quality < 0.08 ? 'signal-gate' :
          separation !== null && separation < 0.018 ? 'separation-gate' : 'other-gate' })
    return result
  }
  const { trace, frame } = recordResearchRun(engine)
  if (!scheduled && seed === 76001 && field !== 'near-peak') {
    const old = JSON.parse(await readFile(`${m76}/run-${10 + fields.indexOf(field)}.json`, 'utf8'))
    if (JSON.stringify(trace) !== JSON.stringify(old.trace)) throw new Error(`M76 trace changed: ${field}`)
    traceCompatibility.push({ field, exact: true })
  }
  const audit = auditAcquisitionReturns(trace, config)
  const declared = trace.find(row => row.decision.nativeTerminated)
  const reasonCounts: Record<string, number> = {}
  for (const row of returnDecisions as Array<{reason: string}>) reasonCounts[row.reason] = (reasonCounts[row.reason] ?? 0) + 1
  const summary = { index, field, seed, scheduled, ...summarizeResearchTrace(trace),
    nativeDeclaration: frame.metrics.nativeDeclaration, nativeAbstention: frame.metrics.nativeAbstention,
    declarationTime: declared?.inputTimeSeconds ?? null,
    declaredPeakErrorMetres: declared?.decision.estimate ? Math.hypot(declared.decision.estimate.x - 0.5,
      declared.decision.estimate.y - 0.5) * config.domainMeters : null,
    pathLengthMetres: frame.metrics.pathLengthMeters,
    maximumRayPool: Math.max(0, ...audit.map(r => r.rayPoolCount ?? 0)),
    maximumProvisionalRays: Math.max(0, ...audit.map(r => r.provisionalRayCount ?? 0)),
    signalEligibleReturns: audit.filter(r => r.signalEligible).length, reasonCounts,
    firstReturnTimes: audit.slice(0, 4).map(r => r.time) }
  await retain(`run-${index}.json`, { ...spec, preflight, summary, audit, returnDecisions, trace })
  summaries.push(summary)
  process.stdout.write(`${index}: ${field} ${seed} scheduled=${scheduled} pool=${summary.maximumRayPool} candidateRays=${summary.maximumProvisionalRays} declared=${summary.nativeDeclaration}\n`)
}
const compatibility = []
const legacy = JSON.parse(await readFile('research/evidence/m72_diagnostic_replay_2026-09-13/manifest.json', 'utf8')) as { inputs: Array<{ run: BatchResult }> }
const references: Array<{config: SimulationConfig; metrics: MetricSnapshot; checkpoint: number}> =
  legacy.inputs.map(i => ({ config: i.run.config, metrics: i.run.metrics, checkpoint: i.run.checkpointSeconds }))
for (let i = 0; i < 8; i++) {
  const a = JSON.parse(await readFile(`research/evidence/m73_local_inlet_commissioning_2026-09-13/run-${i}.json`, 'utf8'))
  const b = JSON.parse(await readFile(`research/evidence/m74_bounded_scan_diagnostic_2026-09-13/pair-${i}.json`, 'utf8'))
  references.push({ config: a.config, metrics: a.metrics, checkpoint: 120 },
    { config: b.treatmentConfig, metrics: b.treatmentMetrics, checkpoint: 120 })
}
for (const ref of references) {
  const e = new SimulationEngine(ref.config)
  while (!e.isCompleted()) e.step()
  const comparison = compareScientificMetrics(e.getFrame().checkpoints[ref.checkpoint]!, ref.metrics)
  if (!comparison.exact) throw new Error('Archived metric compatibility failed')
  compatibility.push(comparison)
}
await retain('compatibility.json', { metricReplays: compatibility, fullTraceReplays: traceCompatibility })
await retain('summary.json', summaries)
const bytes = await readFile(resolve(output, 'manifest.json'))
inventory.push({ file: 'manifest.json', sha256: hash(bytes), bytes: bytes.length })
await writeNew('complete.json', { complete: true, cases: cases.length,
  exactMetricReplays: compatibility.length, exactFullTraceReplays: traceCompatibility.length, inventory })
