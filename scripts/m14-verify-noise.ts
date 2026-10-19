/** Independent archive/score verification; does not rerun or tune the controls. */
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SimulationEngine } from '../src/sim/engine'
import { evaluateMultiView } from './lib/multiview-source-evidence'

const root = 'research/evidence/m14_concentration_noise_followup_2026-09-06'
const primary = 'research/evidence/m14_sniff_turn_bearing_corrected_2026-09-06'
const output = 'research/analysis/m14_concentration_noise_followup_2026-09-06'
const primaryAnalysis = 'research/analysis/m14_sniff_turn_bearing_corrected_2026-09-06/m14-sniff-turn-analysis.json'
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
const read = async (path: string) => JSON.parse(await readFile(join(root, path), 'utf8'))
const safe = (path: string) => {
  if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('Unsafe inventory path')
  return path
}
export const verifyM14Noise = async () => {
  const design = await read('design.json'); const summary = await read('summary.json'); const inventory = await read('checksums.json')
  if (!summary.complete || !inventory.complete || design.jobs.length !== 2 || summary.summaries.length !== 2 ||
      design.sourceInventory.length !== 60 || design.primaryDecisionChanged !== false || !design.selectedAfterPrimaryOutcomes) throw new Error('Invalid control archive')
  if (json(inventory.inventory.map((e: any) => e.path).sort()) !==
      json(['design.json', 'summary.json', ...design.jobs.map((j: any) => `${j.id}.json`)].sort())) throw new Error('Wrong artifact inventory')
  for (const [prefix, entries] of [['', inventory.inventory], ['source-snapshot/', design.sourceInventory]] as const) {
    for (const e of entries) {
      const bytes = await readFile(join(root, `${prefix}${safe(e.path)}`))
      if (bytes.length !== e.bytes || hash(bytes) !== e.sha256) throw new Error(`Archive hash mismatch: ${e.path}`)
      if (prefix && (e.path.startsWith('src/sim/') || e.path.startsWith('scripts/lib/')) &&
          hash(await readFile(e.path)) !== e.sha256) throw new Error(`Scoring source changed: ${e.path}`)
    }
  }
  if (hash(json(design.sourceInventory)) !== design.sourceInventorySha256 ||
      summary.sourceInventorySha256 !== design.sourceInventorySha256 ||
      hash(await readFile(primaryAnalysis)) !== design.primaryAnalysisSha256) throw new Error('Primary/source binding mismatch')
  const originalDesign = JSON.parse(await readFile(join(primary, 'design.json'), 'utf8'))
  let replayedScores = 0
  const cases = []
  for (const job of design.jobs) {
    const original = originalDesign.jobs.find((j: any) => `${j.id}-zero-concentration-noise` === job.id)
    if (!original || json(job) !== json({ ...original, id: job.id, config: { ...original.config, sensorNoise: 0 } })) throw new Error('Control changed more than concentration noise')
    const r = await read(`${job.id}.json`)
    const prior = JSON.parse(await readFile(join(primary, `${original.id}.json`), 'utf8'))
    if (!r.available || json(r.job) !== json(job) || r.records.length !== 12 || r.finalTime !== 40 ||
        r.missedSlots.length || r.costs.collisionAttempts || json(r.costs) !== json(prior.costs) ||
        json(r.timing) !== json(prior.timing)) throw new Error('Control identity/budget mismatch')
    const engine = new SimulationEngine(job.config)
    for (const record of r.records) {
      if (record.sensorNoise !== 0 || json(evaluateMultiView({ ...record, isBlocked: engine.environment.isBlocked })) !== json(record.evidence)) throw new Error('Control score replay mismatch')
      replayedScores++
    }
    const finalPositiveScans = r.records.slice(-6).filter((v: any) => v.evidence.positive).length
    const recomputed = { id: job.id, world: job.world, finalPositiveScans, casePositive: finalPositiveScans >= 4,
      identifiableScans: r.records.filter((v: any) => v.evidence.operatorIdentifiable).length,
      usableScans: r.records.filter((v: any) => v.evidence.usable).length }
    if (json(recomputed) !== json(r.summary) || json(recomputed) !== json(summary.summaries.find((s: any) => s.id === job.id))) throw new Error('Control summary mismatch')
    cases.push({ ...recomputed, primaryFinalPositiveScans: prior.summary.finalPositiveScans,
      primaryCasePositive: prior.summary.casePositive,
      finalRecords: r.records.slice(-6).map((v: any) => ({ time: v.time, ...v.evidence })) })
  }
  const result = { diagnosticOnly: true, primaryDecisionChanged: false, verifiedArtifacts: inventory.inventory.length,
    verifiedSourceFiles: design.sourceInventory.length, replayedScores, budgetsMatchedPrimary: true,
    sourceInventorySha256: design.sourceInventorySha256, primaryAnalysisSha256: design.primaryAnalysisSha256,
    elapsedWallSeconds: (Date.parse(summary.completedAt) - Date.parse(summary.startedAt)) / 1000,
    peakRssBytes: summary.peakRssBytes, cases,
    limitation: 'Post-hoc known-source controls only. No false-positive, localization-performance, or active-suction-superiority inference.' }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'm14-noise-verification.json'), json(result), { flag: 'wx' })
  await copyFile('scripts/m14-verify-noise.ts', join(output, 'analysis-source.ts'))
  const checksums = await Promise.all(['m14-noise-verification.json', 'analysis-source.ts'].map(async (path) => {
    const b = await readFile(join(output, path)); return { path, bytes: b.length, sha256: hash(b) }
  }))
  await writeFile(join(output, 'analysis-checksums.json'), json(checksums), { flag: 'wx' })
  process.stdout.write(json(result))
}
if (process.env.M14_VERIFY_NOISE_RUN === '1') verifyM14Noise().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1
})
