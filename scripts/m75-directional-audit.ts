/** Controlled sensing/geometry audit; not another GSL efficacy campaign. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { estimateQuadGradient } from '../src/sim/algorithms/quadSoilSniff'
import { LocalInletChannel } from '../src/sim/localInletSampling'
import { quadSniffChannelDirections } from '../src/sim/quadSniff'
import { createScenario } from '../src/sim/scenarios'
import { FilamentPlume } from '../src/sim/plume'
import { SeededRandom } from '../src/sim/rng'
import { SimulationEngine } from '../src/sim/engine'
import type { BatchResult, QuadSniffChannelReading, SimulationConfig, MetricSnapshot } from '../src/sim/types'
import type { ResearchTraceRow } from './lib/research-recorder'
import { compareScientificMetrics } from './lib/research-recorder'
import { physicalAcquisitionBudget } from './lib/physical-acquisition-budget'

const output = resolve(process.argv[2] ?? 'research/evidence/m75_directional_audit_2026-09-13')
const m74 = 'research/evidence/m74_bounded_scan_diagnostic_2026-09-13'
const sourceManifest = JSON.parse(await readFile(`${m74}/manifest.json`, 'utf8')) as { treatments: SimulationConfig[] }
const sourceCompletion = JSON.parse(await readFile(`${m74}/complete.json`, 'utf8')) as { inventory: Array<{ file: string; sha256: string }> }
const domains = [1, 100, 1000, 100_000], slopes = [0, 0.1, 0.5, 1, 2], noises = [0.001, 0.01, 0.025]
const angles = [0, Math.PI / 4], replicates = 500, seed = 750031
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const writeNew = (name: string, data: unknown) => writeFile(resolve(output, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' })
await mkdir(output, { recursive: true })
const files = ['scripts/m75-directional-audit.ts', 'scripts/lib/physical-acquisition-budget.ts', 'scripts/lib/research-recorder.ts']
async function collect(dir: string) {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const f = `${dir}/${e.name}`
    if (e.isDirectory()) await collect(f)
    else if (f.endsWith('.ts')) files.push(f)
  }
}
await collect('src/sim')
const sourceInventory = []
for (const file of files) {
  const bytes = await readFile(file), destination = resolve(output, 'source-snapshot', file)
  await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes, { flag: 'wx' })
  sourceInventory.push({ file, sha256: hash(bytes) })
}
await writeNew('manifest.json', { schemaVersion: 'm75-directional-identifiability-audit-v1',
  purpose: 'Separate numerical geometry, controlled directional SNR, temporal memory and time feasibility',
  slopesPerMetreInNormalizedConcentration: slopes, perChannelNoise: noises, anglesRadians: angles,
  domainCoordinateScalesMetres: domains, replicates, seed, headSpacingMetres: 0.1,
  concentrationOffset: 0.5, unchangedDecisionThresholds: true,
  scope: 'Manufactured fields and retrospective diagnostics. No sensor calibration or GSL success claim.',
  sourceInventory, archivedInputInventory: sourceCompletion.inventory,
  runtime: { node: process.version, platform: process.platform, architecture: process.arch } })
const geometry = (domain: number, heading = 0) => quadSniffChannelDirections({ x: Math.cos(heading), y: Math.sin(heading) })
  .map(g => ({ ...g, reach: 0.05 / domain, support: 1,
    effectiveOffset: { x: g.direction.x * 0.05 / domain, y: g.direction.y * 0.05 / domain },
    integrationSamples: 1, effectiveIntegrationSamples: 1 }))
const makeReadings = (domain: number, values: number[], heading = 0): QuadSniffChannelReading[] =>
  geometry(domain, heading).map((g, i) => ({ ...g, concentration: values[i]!, hit: values[i]! >= 0.115, saturated: false }))

// Paired concentration/noise values across coordinate scales: head and field do not change.
const rng = new SeededRandom(seed), rows = []
let scaleDisagreements = 0
for (const slope of slopes) for (const noise of noises) for (const angle of angles) {
  const counters = domains.map(domain => ({ domain, oldValid: 0, relativeValid: 0, within30Degrees: 0, acceptedAngleSum: 0 }))
  for (let trial = 0; trial < replicates; trial++) {
    const values = geometry(1).map(g => Math.max(0, 0.5 + slope * 0.05 *
      (g.direction.x * Math.cos(angle) + g.direction.y * Math.sin(angle)) + rng.normal(0, noise)))
    let reference: ReturnType<typeof estimateQuadGradient> | null = null
    for (const count of counters) {
      const readings = makeReadings(count.domain, values)
      const old = estimateQuadGradient(readings, noise)
      const result = estimateQuadGradient(readings, noise, 'relative-geometry-v1')
      count.oldValid += Number(old.validDirection); count.relativeValid += Number(result.validDirection)
      if (reference && (result.validDirection !== reference.validDirection ||
          Math.abs(result.gradientSnr - reference.gradientSnr) > 1e-9)) scaleDisagreements++
      reference ??= result
      if (slope > 0 && result.validDirection) {
        const error = Math.acos(Math.max(-1, Math.min(1, result.direction.x * Math.cos(angle) + result.direction.y * Math.sin(angle)))) * 180 / Math.PI
        count.acceptedAngleSum += error; count.within30Degrees += Number(error <= 30)
      }
    }
  }
  for (const count of counters) rows.push({ slope, noise, angle, replicates, ...count,
    acceptedMeanAngleDegrees: slope > 0 && count.relativeValid ? count.acceptedAngleSum / count.relativeValid : null })
}
if (scaleDisagreements) throw new Error('Relative geometry is not invariant on the manufactured inputs')
await writeNew('steady-field-noise-audit.json', { complete: true, scaleDisagreements, rows })

// Time-varying field tests pass through the actual delay/response/averaging model.
const physical = sourceManifest.treatments[0]!.localInletSampling!
const temporal = []
for (const field of ['uniform-pulse', 'steady-gradient', 'gradient-with-quarter-turn'] as const) {
  const channels = Array.from({ length: 4 }, () => new LocalInletChannel(physical))
  const samples = []
  for (let tick = 0; tick <= 240; tick++) {
    const time = tick / 4
    const heading = field === 'gradient-with-quarter-turn' && time >= 20 ? Math.PI / 2 : 0
    const values = geometry(1, heading).map((g, i) => channels[i]!.update(time,
      field === 'uniform-pulse' ? 0.5 + 0.2 * Math.sin(2 * Math.PI * time / 8) : 0.5 + 0.5 * g.direction.x * 0.05))
    if (tick % 4 === 0) {
      const estimate = estimateQuadGradient(makeReadings(100, values, heading), 0.001, 'relative-geometry-v1')
      samples.push({ time, heading, values, estimate })
    }
  }
  if (field === 'uniform-pulse' && samples.some(s => s.estimate.validDirection)) throw new Error('Common temporal signal created a direction')
  temporal.push({ field, samples })
}
await writeNew('temporal-field-audit.json', temporal)

// Replay the archived trajectory through private noise-free channel states.
// These states are used only in this diagnostic, never delivered to a controller.
const archived = []
for (const [index, item] of sourceCompletion.inventory.entries()) {
  const bytes = await readFile(`${m74}/${item.file}`)
  if (hash(bytes) !== item.sha256) throw new Error('M74 trajectory checksum mismatch')
  const source = JSON.parse(bytes.toString()) as { treatmentConfig: SimulationConfig; treatmentMetrics: MetricSnapshot; trace: ResearchTraceRow[] }
  const config = source.treatmentConfig, p = config.localInletSampling!
  const model = new FilamentPlume(createScenario(config.scenarioKind, config.seed, config), config.seed)
  const channels = Array.from({ length: 4 }, () => new LocalInletChannel(p))
  const returns = []
  for (const row of source.trace) {
    const body = geometry(config.domainMeters, row.inputHeading)
    const values = body.map((g, i) => channels[i]!.update(row.inputTimeSeconds, model.concentrationAt({
      x: row.inputPosition.x + g.effectiveOffset.x, y: row.inputPosition.y + g.effectiveOffset.y }, row.inputTimeSeconds)))
    if (row.measurement.sampleMode !== 'quad-passive-return') continue
    const actual = row.measurement.quadSniff!.readings!
    const expected = actual.map((r, i) => ({ ...r, concentration: Math.min(config.sensorSaturation, values[i]!),
      saturated: values[i]! >= config.sensorSaturation - 1e-9 }))
    returns.push({ time: row.inputTimeSeconds,
      measured: estimateQuadGradient(actual, config.sensorNoise, 'relative-geometry-v1'),
      noiseFreeSignalAtConfiguredNoise: estimateQuadGradient(expected, config.sensorNoise, 'relative-geometry-v1') })
  }
  archived.push({ index, algorithm: config.algorithmId, targetStatus: config.targetStatus, returns })
}
await writeNew('archived-channel-audit.json', archived)
const budgets = sourceManifest.treatments.filter(c => c.algorithmId === 'quad-sniff-refine').map(physicalAcquisitionBudget)
await writeNew('acquisition-budget.json', budgets)

// Confirm that omission of the new flag preserves all three previous evidence stages.
const compatibility = []
const legacy = JSON.parse(await readFile('research/evidence/m72_diagnostic_replay_2026-09-13/manifest.json', 'utf8')) as { inputs: Array<{run: BatchResult}> }
const references = legacy.inputs.map(i => ({ config: i.run.config, metrics: i.run.metrics, checkpoint: i.run.checkpointSeconds }))
for (let index = 0; index < 8; index++) {
  const old = JSON.parse(await readFile(`research/evidence/m73_local_inlet_commissioning_2026-09-13/run-${index}.json`, 'utf8'))
  references.push({ config: old.config, metrics: old.metrics, checkpoint: 120 })
  const prior = JSON.parse(await readFile(`${m74}/pair-${index}.json`, 'utf8'))
  references.push({ config: prior.treatmentConfig, metrics: prior.treatmentMetrics, checkpoint: 120 })
}
for (const ref of references) {
  const engine = new SimulationEngine(ref.config)
  while (!engine.isCompleted()) engine.step()
  const comparison = compareScientificMetrics(engine.getFrame().checkpoints[ref.checkpoint]!, ref.metrics)
  compatibility.push(comparison)
  if (!comparison.exact) throw new Error('Archived scientific metrics changed')
}
await writeNew('compatibility.json', compatibility)
const inventory = []
for (const file of ['manifest.json', 'steady-field-noise-audit.json', 'temporal-field-audit.json', 'archived-channel-audit.json', 'acquisition-budget.json', 'compatibility.json']) {
  const bytes = await readFile(resolve(output, file)); inventory.push({ file, sha256: hash(bytes), bytes: bytes.length })
}
await writeNew('complete.json', { complete: true, exactCompatibilityReplays: compatibility.length,
  manufacturedNoiseDraws: slopes.length * noises.length * angles.length * replicates,
  coordinateScaleDisagreements: scaleDisagreements, inventory,
  archivedSummary: archived.map(r => ({ index: r.index, algorithm: r.algorithm, target: r.targetStatus,
    returns: r.returns.length, acceptedMeasured: r.returns.filter(s => s.measured.validDirection).length,
    acceptedExpectedSignal: r.returns.filter(s => s.noiseFreeSignalAtConfiguredNoise.validDirection).length,
    maximumExpectedGradientSnr: Math.max(0, ...r.returns.map(s => s.noiseFreeSignalAtConfiguredNoise.gradientSnr)) })),
  budgets })
process.stdout.write(await readFile(resolve(output, 'complete.json'), 'utf8'))
