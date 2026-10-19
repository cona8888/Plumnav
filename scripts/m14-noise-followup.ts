/** Post-hoc upper-bound diagnosis, separate from the frozen 40-job decision. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runM14Job, type m14Jobs } from './m14-sniff-turn-diagnostic'

const primary = 'research/evidence/m14_sniff_turn_bearing_corrected_2026-09-06'
const analysis = 'research/analysis/m14_sniff_turn_bearing_corrected_2026-09-06'
const output = 'research/evidence/m14_concentration_noise_followup_2026-09-06'
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
export const runNoiseFollowup = async () => {
  const acceptedBytes = await readFile(join(analysis, 'm14-sniff-turn-analysis.json'))
  const accepted = JSON.parse(acceptedBytes.toString())
  const acceptedInventory = JSON.parse(await readFile(join(analysis, 'analysis-checksums.json'), 'utf8'))
  if (hash(acceptedBytes) !== acceptedInventory.find((e: any) => e.path === 'm14-sniff-turn-analysis.json').sha256 ||
      !accepted.gates.matchedBudgets || !accepted.gates.obstructedOperatorImproved) throw new Error('Primary verification/mechanism gate not complete')
  const frozen = JSON.parse(await readFile(join(primary, 'design.json'), 'utf8'))
  const jobs = (frozen.jobs as Awaited<ReturnType<typeof m14Jobs>>).filter((j) =>
    j.poseId === 'source' && j.armId === 'geometry-active' && j.policy === 'sniff-turn')
    .map((job) => ({ ...job, id: `${job.id}-zero-concentration-noise`, config: { ...job.config, sensorNoise: 0 } }))
  if (jobs.length !== 2) throw new Error('Unexpected follow-up dimensions')
  const paths = [...frozen.sourceInventory.map((e: any) => e.path), 'scripts/m14-noise-followup.ts'] as string[]
  for (const e of frozen.sourceInventory) if (hash(await readFile(e.path)) !== e.sha256) throw new Error(`Primary source changed: ${e.path}`)
  const sourceInventory = await Promise.all(paths.map(async (path) => {
    const b = await readFile(path); return { path, bytes: b.length, sha256: hash(b) }
  }))
  const design = { version: 'm14-posthoc-concentration-noise-controls-v1', diagnosticOnly: true,
    primaryDecisionChanged: false, selectedAfterPrimaryOutcomes: true, jobs,
    change: 'Regenerate observations with concentration sensorNoise=0 only. Retain wind noise, plume, lag, clipping, geometry, timing and all decision rules.',
    scope: 'Two known-source attainability controls only; no off-source/absent controls, no specificity or superiority conclusion.',
    primaryAnalysisSha256: hash(acceptedBytes), sourceInventory, sourceInventorySha256: hash(json(sourceInventory)) }
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'design.json'), json(design), { flag: 'wx' })
  for (const path of paths) {
    const dest = join(output, 'source-snapshot', path)
    await mkdir(dest.slice(0, dest.lastIndexOf('/')), { recursive: true }); await copyFile(path, dest)
  }
  const startedAt = new Date().toISOString(); const summaries = []; const artifacts = ['design.json']
  for (const job of jobs) {
    const result = runM14Job(job)
    if (!('costs' in result) || result.records.length !== 12 || result.missedSlots!.length || result.finalTime !== 40) throw new Error('Incomplete control')
    const final = result.records.slice(-6); const positive = final.filter((r) => r.evidence.positive).length
    const summary = { id: job.id, world: job.world, finalPositiveScans: positive, casePositive: positive >= 4,
      identifiableScans: result.records.filter((r) => r.evidence.operatorIdentifiable).length,
      usableScans: result.records.filter((r) => r.evidence.usable).length }
    const path = `${job.id}.json`; await writeFile(join(output, path), json({ ...result, summary }), { flag: 'wx' })
    artifacts.push(path); summaries.push(summary); process.stdout.write(json(summary))
  }
  for (const e of sourceInventory) if (hash(await readFile(e.path)) !== e.sha256) throw new Error('Source changed during follow-up')
  const summary = { complete: true, diagnosticOnly: true, startedAt, completedAt: new Date().toISOString(), summaries,
    sourceInventorySha256: design.sourceInventorySha256, peakRssBytes: process.resourceUsage().maxRSS * 1024 }
  await writeFile(join(output, 'summary.json'), json(summary), { flag: 'wx' }); artifacts.push('summary.json')
  const inventory = await Promise.all(artifacts.map(async (path) => {
    const b = await readFile(join(output, path)); return { path, bytes: b.length, sha256: hash(b) }
  }))
  await writeFile(join(output, 'checksums.json'), json({ complete: true, inventory }), { flag: 'wx' })
}
if (process.env.M14_NOISE_FOLLOWUP_RUN === '1') runNoiseFollowup().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1
})
