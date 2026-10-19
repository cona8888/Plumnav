import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { exactField, M15_CALIBRATION, m15Jobs } from './lib/m15-manufactured-fields'
import { simulateCalibration, analyzeCalibration } from './lib/m15-measurement-calibration'

export const M15_OUTPUT = 'research/evidence/m15_measurement_calibration_2026-09-06'
const prior = 'research/evidence/m14_sniff_turn_bearing_corrected_2026-09-06'
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
export const runM15 = async () => {
  const priorBytes = await readFile(join(prior, 'design.json'))
  const previous = JSON.parse(priorBytes.toString())
  const previousChecksums = JSON.parse(await readFile(join(prior, 'checksums.json'), 'utf8'))
  if (hash(priorBytes) !== previousChecksums.inventory.find((e: any) => e.path === 'design.json').sha256) throw new Error('M14 reference design changed')
  for (const e of previous.sourceInventory) if (hash(await readFile(e.path)) !== e.sha256) throw new Error(`M14 source changed: ${e.path}`)
  const paths = [...previous.sourceInventory.map((e: any) => e.path),
    'scripts/lib/m15-manufactured-fields.ts', 'scripts/lib/m15-measurement-calibration.ts',
    'scripts/m15-measurement-calibration.ts', 'scripts/m15-calibration.test.ts',
    'research/protocols/m15_measurement_calibration_protocol.md'].sort() as string[]
  const sourceInventory = await Promise.all(paths.map(async (path) => {
    const b = await readFile(path); return { path, bytes: b.length, sha256: hash(b) }
  }))
  const jobs = m15Jobs()
  if (jobs.length !== M15_CALIBRATION.expectedTrajectories) throw new Error('Unexpected design dimensions')
  const design = { calibration: M15_CALIBRATION, jobs, sourceInventory, sourceInventorySha256: hash(json(sourceInventory)),
    m14DesignSha256: hash(priorBytes), runtime: { node: process.version, v8: process.versions.v8, arch: process.arch },
    verificationSubset: jobs.filter((j) => j.field === 'gaussian-pulsing' && j.offset === 0.015 && j.policy === 'sniff-turn' &&
      (j.reach === 0.065 || j.sensing === 'passive-array') && j.seed === 15101).map((j) => j.id),
    truthExample: exactField('source-free-wave', { x: 0.5, y: 0.5 }, 25.75) }
  await mkdir(M15_OUTPUT, { recursive: true })
  await writeFile(join(M15_OUTPUT, 'design.json'), json(design), { flag: 'wx' })
  for (const path of paths) {
    const target = join(M15_OUTPUT, 'source-snapshot', path)
    await mkdir(dirname(target), { recursive: true }); await copyFile(path, target)
  }
  const startedAt = new Date().toISOString(); const summaries = []
  const inventory: Array<{ path: string; bytes: number; sha256: string }> = []
  const capture = async (path: string) => { const b = await readFile(join(M15_OUTPUT, path)); inventory.push({ path, bytes: b.length, sha256: hash(b) }) }
  await capture('design.json')
  for (const [i, job] of jobs.entries()) {
    const observations = simulateCalibration(job); const analyses = analyzeCalibration(observations)
    const path = `${job.id}.json`
    await writeFile(join(M15_OUTPUT, path), json({ observations, analyses }), { flag: 'wx' }); await capture(path)
    summaries.push({ job, windows: analyses.map(({ window, summary }) => ({ window, ...summary })) })
    if ((i + 1) % 120 === 0) process.stdout.write(`${i + 1}/${jobs.length} manufactured observation trajectories\n`)
  }
  for (const e of sourceInventory) if (hash(await readFile(e.path)) !== e.sha256) throw new Error(`Source changed during M15: ${e.path}`)
  const summary = { complete: true, diagnosticOnly: true, startedAt, completedAt: new Date().toISOString(), summaries,
    trajectories: jobs.length, windowAnalyses: jobs.length * 2, scoreRecords: jobs.length * 2 * 12,
    sourceInventorySha256: design.sourceInventorySha256, peakRssBytes: process.resourceUsage().maxRSS * 1024 }
  await writeFile(join(M15_OUTPUT, 'summary.json'), json(summary), { flag: 'wx' }); await capture('summary.json')
  await writeFile(join(M15_OUTPUT, 'checksums.json'), json({ complete: true, inventory }), { flag: 'wx' })
  process.stdout.write(json({ complete: true, trajectories: summary.trajectories, scoreRecords: summary.scoreRecords,
    elapsedWallSeconds: (Date.parse(summary.completedAt) - Date.parse(startedAt)) / 1000,
    peakRssBytes: summary.peakRssBytes, sourceInventorySha256: design.sourceInventorySha256 }))
}
if (process.env.M15_CALIBRATION_RUN === '1') runM15().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1
})
