/** Frozen exploratory geometry revision and conditional-uncertainty audit. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { SimulationEngine } from '../src/sim/engine'
import { SeededRandom } from '../src/sim/rng'
import { physicalBearingIntersection } from '../src/sim/algorithms/physicalBearingGeometry'
import type { GradientRay, GradientRayEstimate } from '../src/sim/algorithms/quadSoilSniff'
import { recordResearchRun, summarizeResearchTrace, compareScientificMetrics } from './lib/research-recorder'
import { requirePhysicalAcquisitionBudget } from './lib/physical-acquisition-budget'
import type { SimulationConfig, BatchResult, MetricSnapshot } from '../src/sim/types'

const root = resolve(process.argv[2] ?? 'research/evidence/m78_physical_bearing_geometry_2026-09-13')
const m77 = 'research/evidence/m77_acquisition_scheduling_2026-09-13'
const prior = JSON.parse(await readFile(`${m77}/manifest.json`, 'utf8'))
const cases: Array<{ config: SimulationConfig; field: string; seed: number; revised: boolean; referenceIndex: number }> = []
for (const [index, s] of prior.cases.entries()) if (s.scheduled) for (const revised of [false, true]) {
  const config = structuredClone(s.config) as SimulationConfig
  if (revised) config.localInletSampling!.bearingGeometry = 'linearized-local-bearing-v1'
  cases.push({ config, field: s.field, seed: s.seed, revised, referenceIndex: index })
}
const noiseLevels = [0.01, 0.05, 0.2], angularBiases = [0, 0.1], repeats = 2000
await mkdir(root, { recursive: true })
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const writeNew = (file: string, value: unknown) => writeFile(resolve(root, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const files = ['scripts/m78-physical-bearing-geometry.ts', 'scripts/lib/research-recorder.ts', 'scripts/lib/physical-acquisition-budget.ts']
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
  const bytes = await readFile(file), target = resolve(root, 'source-snapshot', file)
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' })
  sourceInventory.push({ file, sha256: hash(bytes) })
}
await writeNew('manifest.json', { schemaVersion: 'm78-linearized-local-bearing-v1', cases, sourceInventory,
  prescribedFields: prior.prescribedFields,
  uncertaintyAudit: { noiseLevels, angularBiases, repeats, seed: 780031,
    positionsMetres: [[-0.4, -0.3], [0.4, -0.3], [0, 0.5], [-0.5, 0.1]] },
  limits: 'Exploratory joint geometry/bearing revision, not an isolated mechanism ablation. Conditional first-order nominal uncertainty, not calibrated outdoor confidence. No threshold fitting.',
  references: ['https://www.nist.gov/pml/nist-technical-note-1297/nist-tn-1297-appendix-law-propagation-uncertainty',
    'https://pmc.ncbi.nlm.nih.gov/articles/PMC3812610/'],
  runtime: { node: process.version, platform: process.platform, architecture: process.arch } })
const inventory: Array<{file: string; sha256: string; bytes: number}> = []
async function retain(file: string, value: unknown) {
  await writeNew(file, value)
  const bytes = await readFile(resolve(root, file)); inventory.push({ file, sha256: hash(bytes), bytes: bytes.length })
}
const rng = new SeededRandom(780031), uncertaintyAudit = []
for (const sigma of noiseLevels) for (const bias of angularBiases) {
  const samples = []
  for (let k = 0; k < repeats; k++) {
    const rays: GradientRay[] = [[-0.4, -0.3], [0.4, -0.3], [0, 0.5], [-0.5, 0.1]].map(([x, y]) => {
      const angle = Math.atan2(-y!, -x!) + bias + rng.normal(0, sigma)
      return { time: 0, origin: { x: 0.5 + x! / 100, y: 0.5 + y! / 100 },
        direction: { x: Math.cos(angle), y: Math.sin(angle) }, angularSigma: sigma, weight: 1 }
    })
    const fit = physicalBearingIntersection(rays, 0.001, 0.001)
    const error = fit ? Math.hypot(fit.point.x - 0.5, fit.point.y - 0.5) * 100 : null
    samples.push({ errorMetres: error, radiusMetres: fit ? fit.physicalUncertainty!.nominalRadius95 * 100 : null,
      acceptable: fit?.physicalUncertainty?.acceptable ?? false })
  }
  const valid = samples.filter(s => s.errorMetres !== null)
  const accepted = valid.filter(s => s.acceptable)
  uncertaintyAudit.push({ sigma, bias, repeats, returnedFits: valid.length,
    coveredFits: valid.filter(s => s.errorMetres! <= s.radiusMetres!).length,
    acceptedFits: accepted.length, acceptedCoveredFits: accepted.filter(s => s.errorMetres! <= s.radiusMetres!).length,
    acceptedOutsideInspectionRadius: accepted.filter(s => s.errorMetres! > 0.1).length, samples })
}
await retain('uncertainty-audit.json', uncertaintyAudit)
const summaries = [], traceReplays = []
for (const [index, spec] of cases.entries()) {
  const { config, field, revised, seed } = spec
  const preflight = requirePhysicalAcquisitionBudget(config)
  const engine = new SimulationEngine(config)
  const width = field === 'broad-peak' ? 3 : field === 'near-peak' ? 0.6 : 0.06
  engine.plume.concentrationAt = p => {
    const r = Math.hypot(p.x - 0.5, p.y - 0.5) * config.domainMeters
    return field === 'blank' ? 0 : field === 'uniform' ? 0.5 : 0.01 +
      (field === 'weak' ? 0.0001 : 1) * Math.exp(-r * r / (2 * width ** 2))
  }
  const access = engine.controller as unknown as { intersectCurrentRays(rays: readonly GradientRay[]): GradientRayEstimate | null }
  const original = access.intersectCurrentRays.bind(access)
  const geometryEvents: Array<{ time: number; rayCount: number; result: GradientRayEstimate | null }> = []
  access.intersectCurrentRays = rays => {
    const result = original(rays)
    geometryEvents.push({ time: engine.getFrame().time, rayCount: rays.length, result: structuredClone(result) })
    return result
  }
  const { trace, frame } = recordResearchRun(engine)
  if (!revised) {
    const old = JSON.parse(await readFile(`${m77}/run-${spec.referenceIndex}.json`, 'utf8'))
    if (JSON.stringify(trace) !== JSON.stringify(old.trace)) throw new Error('M77 trace changed')
    traceReplays.push({ referenceIndex: spec.referenceIndex, exact: true })
  }
  const declared = trace.find(r => r.decision.nativeTerminated)
  const summary = { index, field, seed, revised, ...summarizeResearchTrace(trace),
    nativeDeclaration: frame.metrics.nativeDeclaration, nativeAbstention: frame.metrics.nativeAbstention,
    declarationTime: declared?.inputTimeSeconds ?? null,
    declaredPeakErrorMetres: declared?.decision.estimate ? Math.hypot(declared.decision.estimate.x - 0.5,
      declared.decision.estimate.y - 0.5) * config.domainMeters : null,
    maximumRayPool: Math.max(0, ...geometryEvents.map(e => e.rayCount)),
    maximumSolvedRays: Math.max(0, ...geometryEvents.map(e => e.result?.rayCount ?? 0)),
    acceptableGeometryEvents: geometryEvents.filter(e => e.result?.physicalUncertainty?.acceptable).length,
    pathLengthMetres: frame.metrics.pathLengthMeters }
  await retain(`run-${index}.json`, { ...spec, preflight, summary, geometryEvents, trace })
  summaries.push(summary)
  process.stdout.write(`${index}: ${field} ${seed} revised=${revised} rays=${summary.maximumRayPool} fits=${summary.maximumSolvedRays} attempts=${summary.bracketAttempts.length} declared=${summary.nativeDeclaration}\n`)
}
const legacy = JSON.parse(await readFile('research/evidence/m72_diagnostic_replay_2026-09-13/manifest.json', 'utf8')) as { inputs: Array<{run: BatchResult}> }
const refs: Array<{config: SimulationConfig; metrics: MetricSnapshot; checkpoint: number}> =
  legacy.inputs.map(i => ({config: i.run.config, metrics: i.run.metrics, checkpoint: i.run.checkpointSeconds}))
for (let i = 0; i < 8; i++) {
  const a = JSON.parse(await readFile(`research/evidence/m73_local_inlet_commissioning_2026-09-13/run-${i}.json`, 'utf8'))
  const b = JSON.parse(await readFile(`research/evidence/m74_bounded_scan_diagnostic_2026-09-13/pair-${i}.json`, 'utf8'))
  refs.push({config:a.config, metrics:a.metrics, checkpoint:120}, {config:b.treatmentConfig,metrics:b.treatmentMetrics,checkpoint:120})
}
const metricReplays = []
for (const ref of refs) {
  const e = new SimulationEngine(ref.config)
  while (!e.isCompleted()) e.step()
  const comparison = compareScientificMetrics(e.getFrame().checkpoints[ref.checkpoint]!, ref.metrics)
  if (!comparison.exact) throw new Error('Archived metric changed')
  metricReplays.push(comparison)
}
await retain('compatibility.json', { traceReplays, metricReplays })
await retain('summary.json', summaries)
const bytes = await readFile(resolve(root, 'manifest.json'))
inventory.push({file:'manifest.json',sha256:hash(bytes),bytes:bytes.length})
await writeNew('complete.json', {complete:true, cases:cases.length, metricReplays:metricReplays.length,
  traceReplays:traceReplays.length, uncertaintyRealizations:noiseLevels.length*angularBiases.length*repeats, inventory})
