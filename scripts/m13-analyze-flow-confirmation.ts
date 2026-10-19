import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SimulationEngine } from '../src/sim/engine'
import { evaluateFlowSourceEvidence, FLOW_SOURCE_POLICY } from './lib/flow-source-evidence'

const input = 'research/evidence/m13_flow_confirmation_2026-09-06'
const output = 'research/analysis/m13_flow_confirmation_2026-09-06'
const m11 = 'research/evidence/m11_confirmation_diagnostic_2026-09-05'
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const read = async (name: string) => JSON.parse(await readFile(join(input, name), 'utf8'))
const safe = (path: string) => {
  if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('Unsafe artifact path')
  return path
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b); const n = sorted.length
  return n ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2 : null
}
export const analyzeM13 = async () => {
  const design = await read('design.json'); const summary = await read('summary.json'); const checksums = await read('checksums.json')
  if (!summary.complete || !checksums.complete || design.jobs.length !== 28 || summary.summaries.length !== 28) throw new Error('Incomplete diagnostic')
  const expected = ['design.json', 'summary.json', ...design.jobs.map((job: any) => `${job.id}.json`)].sort()
  if (json(expected) !== json(checksums.inventory.map((e: any) => e.path).sort())) throw new Error('Evidence inventory dimensions disagree')
  for (const entry of checksums.inventory) {
    const bytes = await readFile(join(input, safe(entry.path)))
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`Invalid evidence: ${entry.path}`)
  }
  if (hash(json(design.sourceInventory)) !== design.sourceInventorySha256 ||
      summary.sourceInventorySha256 !== design.sourceInventorySha256 || json(design.policy) !== json(FLOW_SOURCE_POLICY)) {
    throw new Error('Source inventory or policy mismatch')
  }
  for (const entry of design.sourceInventory) {
    const bytes = await readFile(join(input, 'source-snapshot', safe(entry.path)))
    if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`Invalid snapshot: ${entry.path}`)
  }
  // The scorer used for independent recalculation must be the frozen scorer.
  const scorer = design.sourceInventory.find((e: any) => e.path === 'scripts/lib/flow-source-evidence.ts')
  if (hash(await readFile(scorer.path)) !== scorer.sha256) throw new Error('Current scorer no longer matches snapshot')
  const runs = []; let verifiedScanCalculations = 0; let matchedM11SourceReturns = 0
  for (const job of design.jobs) {
    const result = await read(`${job.id}.json`)
    if (json(result.job) !== json(job)) throw new Error(`Job identity changed: ${job.id}`)
    const reasons: Record<string, number> = {}
    let geometryExcludedScans = 0
    if (result.available) {
      const engine = new SimulationEngine(job.config)
      if (result.scans.length !== 12 || result.finalTime !== 40 ||
          Math.hypot(result.actualPosition.x - job.position.x, result.actualPosition.y - job.position.y) > 1e-12) {
        throw new Error(`Invalid stationary endpoint: ${job.id}`)
      }
      for (const scan of result.scans) {
        const recomputed = evaluateFlowSourceEvidence({ ...scan, isBlocked: engine.environment.isBlocked })
        if (json(recomputed) !== json(scan.flowEvidence)) throw new Error(`Scorer replay differs: ${job.id}/${scan.time}`)
        verifiedScanCalculations++
        reasons[recomputed.reason] = (reasons[recomputed.reason] ?? 0) + 1
        if (['clipped or unsupported channel', 'unidentifiable mixed curvature', 'singular footprint geometry',
          'no directional sampling gain', 'invalid footprint reach'].includes(recomputed.reason)) geometryExcludedScans++
      }
      if (job.poseId === 'source') {
        const path = `stationary-${job.world}-emitting-${job.armId}-original.json`
        const bytes = await readFile(join(m11, path))
        const m11Inventory = JSON.parse(await readFile(join(m11, 'checksums.json'), 'utf8')).inventory
        const entry = m11Inventory.find((e: any) => e.path === path)
        if (!entry || hash(bytes) !== entry.sha256) throw new Error(`Invalid M11 control: ${path}`)
        const prior = JSON.parse(bytes.toString())
        if (prior.returns.length !== result.scans.length) throw new Error('M11 scan count mismatch')
        for (let i = 0; i < result.scans.length; i++) {
          if (json(prior.returns[i].readings) !== json(result.scans[i].quad.readings) ||
              prior.returns[i].time !== result.scans[i].time ||
              prior.returns[i].surfaceAccepted !== result.scans[i].frozenSurfaceEvidence.surfaceAccepted) {
            throw new Error(`M11 known-source sensor return changed: ${job.id}/${i}`)
          }
          matchedM11SourceReturns++
        }
      }
    } else if (result.scans.length || job.available) throw new Error('Unavailable-job semantics changed')
    const final = result.scans.slice(-FLOW_SOURCE_POLICY.finalWindowScans)
    const positive = final.filter((s: any) => s.flowEvidence.positive).length
    const casePositive = final.length === 6 && positive >= 4
    const knownSummary = summary.summaries.find((s: any) => s.id === job.id)
    if (json(result.summary) !== json(knownSummary) || casePositive !== knownSummary.casePositive ||
        positive !== knownSummary.finalWindowPositiveScans) throw new Error('Case aggregation mismatch')
    const usable = result.scans.filter((s: any) => s.flowEvidence.usable)
    runs.push({ ...result.summary, evaluatorOffsetNormalized: job.evaluatorOffsetNormalized,
      geometryExcludedScans, reasons, medianResidual: median(usable.map((s: any) => s.flowEvidence.nominalResidual)),
      medianLowerBound: median(usable.map((s: any) => s.flowEvidence.lowerBound)),
      costs: result.costs ?? null })
  }
  const active = runs.filter((r) => r.armId === 'geometry-active')
  const knownSource = active.filter((r) => r.poseId === 'source')
  const offSource = active.filter((r) => !['source', 'absent'].includes(r.poseId))
  const absent = active.filter((r) => r.poseId === 'absent')
  const gates = {
    bothActiveKnownSourcesPositive: knownSource.length === 2 && knownSource.every((r) => r.available && r.casePositive),
    noActiveOffSourcePositives: offSource.length === 10 && offSource.every((r) => !r.casePositive),
    noActiveAbsentPositives: absent.length === 2 && absent.every((r) => r.available && !r.casePositive),
    offSourceGeometryCoverage: offSource.length === 10 && offSource.every((r) => r.available && r.geometryExcludedScans === 0),
  }
  const analysis = { diagnosticOnly: true, verifiedArtifacts: checksums.inventory.length,
    verifiedSourceFiles: design.sourceInventory.length, sourceInventorySha256: design.sourceInventorySha256,
    verifiedScanCalculations, matchedM11SourceReturns, availableJobs: runs.filter((r) => r.available).length,
    unavailableJobs: runs.filter((r) => !r.available).map((r) => r.id),
    elapsedWallSeconds: (Date.parse(summary.completedAt) - Date.parse(summary.startedAt)) / 1000,
    peakRssBytes: summary.peakRssBytes, gates, candidateAdvances: Object.values(gates).every(Boolean), runs }
  const table = [
    '| World / pose | Arm | Available | Usable scans | Final positives / 6 | Case positive | Frozen surface case |',
    '|---|---|---|---:|---:|---|---|',
    ...runs.map((r) => `| ${r.world} / ${r.poseId} | ${r.armId === 'geometry-active' ? 'Active' : 'Passive array'} | ${r.available ? 'yes' : 'NO'} | ${r.usableScans}/12 | ${r.available ? `${r.finalWindowPositiveScans}/6` : 'unavailable'} | ${r.available ? r.casePositive ? 'yes' : 'no' : 'unavailable'} | ${r.available ? r.frozenSurfaceCasePositive ? 'yes' : 'no' : 'unavailable'} |`),
  ].join('\n')
  const report = `# M13 flow-aware confirmation diagnostic\n\n${analysis.availableJobs}/28 prescribed jobs executed; ${analysis.unavailableJobs.length} were explicitly unavailable because their prescribed pose was blocked/out of bounds. Every available job returned twelve stationary scans. All ${analysis.verifiedArtifacts} evidence artifacts, ${analysis.verifiedSourceFiles} source snapshots and ${analysis.verifiedScanCalculations} scan-score recalculations verified. All ${analysis.matchedM11SourceReturns} known-source four-channel returns and original surface decisions exactly matched their archived M11 controls.\n\nMac execution: ${analysis.elapsedWallSeconds.toFixed(1)} s, peak process RSS ${(analysis.peakRssBytes / 2 ** 30).toFixed(2)} GiB; no AWS. M12 and the portable app remain unchanged.\n\n## Decision\n\nCandidate advances: **${analysis.candidateAdvances ? 'YES, to further development only' : 'NO; do not replace the M12 declaration rule'}**.\n\n${Object.entries(gates).map(([name, pass]) => `- ${name}: ${pass ? 'PASS' : 'FAIL'}`).join('\n')}\n\nThe active rule was positive at ${knownSource.filter((r) => r.casePositive).length}/2 known-source poses, ${offSource.filter((r) => r.casePositive).length}/${offSource.filter((r) => r.available).length} available off-source poses, and ${absent.filter((r) => r.casePositive).length}/2 source-absent poses. Blocked or unsupported cases are not correct negatives. These are descriptive case counts in two reused worlds, not general success/false-positive rates.\n\n## All prescribed cases\n\n${table}\n\nA positive case requires four of its final six scans positive. Individual noisy/transient scans and the nearby 0.02-offset cases remain important even when the case vote is negative. Repeated scans are correlated observations, not independent world replications. The 0.02 offset is outside the study's 1% coordinate tolerance.\n\n## Interpretation\n\nThis test uses a calibrated quadratic reconstruction of the four sampling footprints plus a recent central temporal trend. Its local transport residual allows advective asymmetry. The equation form is standard advection–diffusion ([COMSOL mass-balance documentation](https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_chemicalspeciestransport.28.03.html)); the diagnostic's reconstruction, uncertainty assumptions and temporal decision are study hypotheses, not established physical calibration or a novelty claim.\n\nThe rule never receives a source coordinate or emission rate. The harness uses truth only to prescribe labelled test poses. Therefore a known-source positive demonstrates sensor-rule attainability, not successful navigation/localization. The residual is not soil flux, and the nonconservative simulator flow is not an exact conservative mass balance. A positive residual can also arise from model mismatch, finite-footprint smoothing, temporal aliasing or curvature reconstruction error.\n\nActive and passive cases share scan starts, four channels, duration, and paired world seeds. They do not share footprints or pump energy. Actual cycles, sampling time and energy proxies are saved. The observations do not isolate an active-suction benefit. Saturation, clipped footprint geometry and failed reconstruction must remain abstentions, not be converted into favourable negative labels.\n\n## Next development block\n\nDo not retune this frozen rule using these outcomes. Use the saved reasons and per-scan bounds to separate signal/noise limitations from geometrical identifiability. For urban obstacles, the next candidate needs map-aware additional viewpoints to identify curvature when a four-channel stencil is clipped; four readings cannot estimate all five spatial quadratic terms. For 1% localization, investigate a smaller-footprint or multi-scale spatial consistency/refinement step with explicit near-source offsets on both sides of the tolerance. Freeze any revised design before collecting new development evidence, preserve this candidate as an ablation, and do not open validation/test seeds yet.\n\n## Reproducibility\n\nSource inventory SHA-256: ${analysis.sourceInventorySha256}\nAnalysis SHA-256: ${hash(json(analysis))}\n`
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'm13-flow-confirmation-analysis.json'), json(analysis))
  await writeFile(join(output, 'm13-flow-confirmation-report.md'), report)
  await copyFile('scripts/m13-analyze-flow-confirmation.ts', join(output, 'analysis-source.ts'))
  const inventory = await Promise.all(['m13-flow-confirmation-analysis.json', 'm13-flow-confirmation-report.md', 'analysis-source.ts']
    .map(async (path) => { const bytes = await readFile(join(output, path)); return { path, bytes: bytes.length, sha256: hash(bytes) } }))
  await writeFile(join(output, 'analysis-checksums.json'), json(inventory))
  process.stdout.write(json({ ...analysis, runs: runs.map(({ costs, ...rest }) => rest), analysisSha256: hash(json(analysis)), reportSha256: hash(report) }))
}
if (process.env.M13_FLOW_ANALYSIS_RUN === '1') analyzeM13().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1
})
