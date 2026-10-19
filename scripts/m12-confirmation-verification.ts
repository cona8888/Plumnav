/** Post-hoc mechanism verification of the M12 scheduling correction. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SimulationEngine } from '../src/sim/engine'
import { SIMULATOR_VERSION } from '../src/sim/config'
import { batchResultsToCsv } from '../src/sim/batch'
import { QUAD_CONFIRMATION_PRIORITY_POLICY } from '../src/sim/algorithms/quadSoilSniff'
import { distance } from '../src/sim/math'
import type { AlgorithmId, BatchResult, QuadDeclarationEvidenceStatus, AlgorithmStepInput, Vec2 } from '../src/sim/types'
import { createM10Manifest, M10_ARMS } from './m10-geometry-development-manifest'
import { m10ArmConfig } from './m10-sharded-development'

const output = 'research/evidence/m12_confirmation_scheduling_2026-09-05'
const archive = 'research/evidence/m10_geometry_conditioned_development_2026-09-05'
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const jobs = [
  { cellId: 'open-downwind-0-emitting', algorithmId: 'quad-sniff' },
  { cellId: 'open-downwind-0-emitting', algorithmId: 'quad-sniff-confirmation' },
  { cellId: 'obstructed-downwind-2-emitting', algorithmId: 'quad-sniff' },
  { cellId: 'obstructed-downwind-2-emitting', algorithmId: 'quad-sniff-confirmation' },
  { cellId: 'open-downwind-0-absent', algorithmId: 'quad-sniff-confirmation' },
  { cellId: 'obstructed-downwind-2-absent', algorithmId: 'quad-sniff-confirmation' },
] satisfies Array<{ cellId: string; algorithmId: AlgorithmId }>
const filesIn = async (directory: string): Promise<string[]> => (await Promise.all(
  (await readdir(directory, { withFileTypes: true })).map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesIn(path) : Promise.resolve([path])
  }),
)).flat()

const main = async () => {
  await mkdir(output, { recursive: true })
  const sourceFiles = [...await filesIn('src/sim'), 'scripts/m12-confirmation-verification.ts',
    'scripts/m10-geometry-development-manifest.ts', 'scripts/m10-sharded-development.ts', 'package.json', 'pnpm-lock.yaml'].sort()
  const sourceInventory = []
  for (const path of sourceFiles) {
    const bytes = await readFile(path)
    sourceInventory.push({ path, sha256: hash(bytes), bytes: bytes.length })
  }
  const manifest = createM10Manifest()
  const design = { schemaVersion: 'm12-confirmation-mechanism-v1', simulatorVersion: SIMULATOR_VERSION,
    diagnosticOnly: true, policy: QUAD_CONFIRMATION_PRIORITY_POLICY, jobs,
    configs: jobs.map((job) => ({ ...m10ArmConfig(manifest.cells.find((cell) => cell.id === job.cellId)!, M10_ARMS[0]!),
      algorithmId: job.algorithmId })),
    sourceInventory, sourceInventorySha256: hash(json(sourceInventory)),
    successChecks: [
      'M10 emitting controls match archived scientific columns except timing and simulator-version metadata',
      'No trusted M12 scan return immediately selects gradient advance',
      'M12 completes at least one confirmation sequence and rejects unsupported evidence in each emitting example',
      'No spurious declaration in the two matched absent examples',
    ],
    scope: 'Post-hoc scheduling mechanism check on reused development worlds; not a new performance estimate or validation',
  }
  await writeFile(join(output, 'design.json'), json(design), { flag: 'wx' })
  for (const path of sourceFiles) {
    const destination = join(output, 'source-snapshot', path)
    await mkdir(destination.slice(0, destination.lastIndexOf('/')), { recursive: true })
    await copyFile(path, destination)
  }
  const startedAt = new Date().toISOString()
  const summaries = []
  const artifacts = ['design.json']
  for (const [index, job] of jobs.entries()) {
    const config = design.configs[index]!
    const engine = new SimulationEngine(config)
    const originalStep = engine.controller.step.bind(engine.controller)
    const state = engine.controller as unknown as {
      declarationEvidence(input: AlgorithmStepInput): QuadDeclarationEvidenceStatus
      confirmationIndex: number; lastFailedConfirmationAt: number; confirmationCandidate: Vec2 | null
    }
    let resets = 0
    let previousReset = -Infinity
    let trustedReturns = 0
    let advanceOnTrustedReturn = 0
    const records = []
    engine.controller.step = (input) => {
      const decision = originalStep(input)
      const evidence = state.declarationEvidence(input)
      if (state.lastFailedConfirmationAt !== previousReset) { resets++; previousReset = state.lastFailedConfirmationAt }
      const returned = Boolean(input.measurement.quadSniff?.readings?.length)
      if (returned && evidence.candidate) {
        trustedReturns++
        if (decision.phase === 'QUADRATURE GRADIENT ADVANCE') advanceOnTrustedReturn++
      }
      records.push({ time: input.time, position: input.position, phase: decision.phase, returned,
        candidate: evidence.candidate, candidateError: evidence.candidate && engine.scenario.source
          ? distance(evidence.candidate, engine.scenario.source) : null,
        confirmationIndex: state.confirmationIndex, resets, ready: evidence.ready, gates: evidence.gates, raw: evidence.raw })
      return decision
    }
    const frame = engine.runToCompletion()
    const result: BatchResult = { algorithmId: config.algorithmId, scenarioKind: config.scenarioKind, seed: config.seed,
      checkpointSeconds: 180, config, observationModelVersion: engine.environment.observationModelVersion,
      observationModelSeed: config.observationModelSeed, metrics: frame.checkpoints[180]!,
      effectivePhysicsStepSeconds: (engine.plume as { stepSeconds: number }).stepSeconds }
    const csv = batchResultsToCsv([result])
    let matchedM10ScientificColumns: number | null = null
    if (job.algorithmId === 'quad-sniff') {
      const [header, row] = csv.trimEnd().split('\n')
      const old = (await readFile(join(archive, 'cells', `${job.cellId}.csv`), 'utf8')).trimEnd().split('\n')
      const oldHeader = old[0]!.split(','); const oldRow = old[1]!.split(','); const newRow = row!.split(',')
      matchedM10ScientificColumns = 0
      for (const [i, column] of header!.split(',').entries()) {
        if (['mean_compute_ms', 'p95_compute_ms', 'simulator_version'].includes(column)) continue
        if (newRow[i] !== oldRow[oldHeader.indexOf(column)]) throw new Error(`M10 behavior changed: ${job.cellId}/${column}`)
        matchedM10ScientificColumns++
      }
    }
    const summary = { ...job, trustedReturns, advanceOnTrustedReturn, resets,
      maximumConfirmationIndex: Math.max(...records.map((r) => r.confirmationIndex)),
      matchedM10ScientificColumns, nativeDeclaration: result.metrics.nativeDeclaration,
      terminalOutcome: result.metrics.terminalOutcome, spuriousDeclaration: result.metrics.spuriousDeclaration,
      surfaceCountPasses: result.metrics.quadDeclarationGatePasses['surface-count'],
      correctDeclaration: result.metrics.terminalOutcome === 'correct-declaration' }
    const name = `${job.cellId}-${job.algorithmId}`
    await writeFile(join(output, `${name}.json`), json({ summary, records }), { flag: 'wx' })
    await writeFile(join(output, `${name}.csv`), csv, { flag: 'wx' })
    artifacts.push(`${name}.json`, `${name}.csv`)
    summaries.push(summary)
    process.stdout.write(`Completed ${job.cellId}/${job.algorithmId}: resets=${resets}, trusted-return advances=${advanceOnTrustedReturn}/${trustedReturns}\n`)
  }
  const priorityPresent = summaries.filter((s) => s.algorithmId === 'quad-sniff-confirmation' && s.cellId.endsWith('emitting'))
  const checks = {
    preservedM10: summaries.filter((s) => s.algorithmId === 'quad-sniff').every((s) => s.matchedM10ScientificColumns === 177),
    priorityRespected: priorityPresent.every((s) => s.trustedReturns > 0 && s.advanceOnTrustedReturn === 0),
    confirmationCompletedAndRejected: priorityPresent.every((s) => s.resets >= 1 && s.maximumConfirmationIndex === 9),
    absentSafety: summaries.filter((s) => s.cellId.endsWith('absent')).every((s) => !s.spuriousDeclaration),
  }
  const summary = { complete: true, diagnosticOnly: true, startedAt, completedAt: new Date().toISOString(),
    peakRssBytes: process.resourceUsage().maxRSS * 1024, sourceInventorySha256: design.sourceInventorySha256,
    checks, mechanismPassed: Object.values(checks).every(Boolean), summaries }
  await writeFile(join(output, 'summary.json'), json(summary), { flag: 'wx' }); artifacts.push('summary.json')
  const inventory = await Promise.all(artifacts.map(async (path) => {
    const bytes = await readFile(join(output, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }
  }))
  await writeFile(join(output, 'checksums.json'), json({ complete: true, inventory }), { flag: 'wx' })
  process.stdout.write(json(summary))
}
if (process.env.M12_VERIFICATION_RUN === '1') main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1
})
