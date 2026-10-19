import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { M16_DESIGN, m16Jobs, simulateM16, scoreM16 } from './lib/m16-multiscale-study'
import { M16_POLICY } from './lib/m16-space-time-evidence'

const prior = 'research/evidence/m15_measurement_calibration_2026-09-06'
export const M16_OUTPUT = 'research/evidence/m16_space_time_multiscale_2026-09-06'
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
export const runM16 = async () => {
  const bytes = await readFile(join(prior, 'design.json')); const previous = JSON.parse(bytes.toString())
  const previousInventory = JSON.parse(await readFile(join(prior, 'checksums.json'), 'utf8'))
  if (hash(bytes) !== previousInventory.inventory.find((e: any) => e.path === 'design.json').sha256) throw new Error('M15 design hash mismatch')
  for (const e of previous.sourceInventory) if (hash(await readFile(e.path)) !== e.sha256) throw new Error(`M15 source changed: ${e.path}`)
  const paths = [...previous.sourceInventory.map((e: any) => e.path), 'scripts/lib/m16-space-time-evidence.ts',
    'scripts/lib/m16-multiscale-study.ts', 'scripts/m16-space-time-study.ts', 'scripts/m16-candidate.test.ts',
    'research/protocols/m16_space_time_multiscale_protocol.md'].sort() as string[]
  const sourceInventory = await Promise.all(paths.map(async (path) => {
    const b = await readFile(path); return { path, bytes: b.length, sha256: hash(b) }
  }))
  const jobs = m16Jobs()
  if (jobs.length !== 390) throw new Error('Incorrect design dimensions')
  const design = { ...M16_DESIGN, policy: M16_POLICY, jobs, sourceInventory,
    sourceInventorySha256: hash(json(sourceInventory)), m15DesignSha256: hash(bytes),
    runtime: { node: process.version, v8: process.versions.v8, arch: process.arch },
    verificationSubset: jobs.filter((j) => j.width === 0.024 && j.period === 5 && j.offset === 0.015 && j.seed === 16101).map((j) => j.id) }
  await mkdir(M16_OUTPUT, { recursive: true }); await writeFile(join(M16_OUTPUT, 'design.json'), json(design), { flag: 'wx' })
  for (const path of paths) {
    const target = join(M16_OUTPUT, 'source-snapshot', path)
    await mkdir(dirname(target), { recursive: true }); await copyFile(path, target)
  }
  const inventory: Array<{ path: string; bytes: number; sha256: string }> = []
  const capture = async (path: string) => { const b = await readFile(join(M16_OUTPUT, path)); inventory.push({ path, bytes: b.length, sha256: hash(b) }) }
  await capture('design.json')
  const startedAt = new Date().toISOString(); const summaries = []; let scoreRecords = 0
  for (const [i, job] of jobs.entries()) {
    const observations = simulateM16(job); const analyses = scoreM16(observations)
    const path = `${job.id}.json`
    await writeFile(join(M16_OUTPUT, path), json({ observations, analyses }), { flag: 'wx' }); await capture(path)
    summaries.push({ job, estimators: analyses.map(({ estimator, summary }) => ({ estimator, ...summary })) })
    scoreRecords += analyses.length * 12
    if ((i + 1) % 65 === 0) process.stdout.write(`${i + 1}/${jobs.length} M16 parameter-transfer trajectories\n`)
  }
  if (scoreRecords !== 7800) throw new Error('Missing score records')
  for (const e of sourceInventory) if (hash(await readFile(e.path)) !== e.sha256) throw new Error(`Source changed during M16: ${e.path}`)
  const summary = { complete: true, diagnosticOnly: true, startedAt, completedAt: new Date().toISOString(),
    trajectories: jobs.length, scoreRecords, summaries, sourceInventorySha256: design.sourceInventorySha256,
    peakRssBytes: process.resourceUsage().maxRSS * 1024 }
  await writeFile(join(M16_OUTPUT, 'summary.json'), json(summary), { flag: 'wx' }); await capture('summary.json')
  await writeFile(join(M16_OUTPUT, 'checksums.json'), json({ complete: true, inventory }), { flag: 'wx' })
  process.stdout.write(json({ complete: true, trajectories: jobs.length, scoreRecords,
    elapsedWallSeconds: (Date.parse(summary.completedAt) - Date.parse(startedAt)) / 1000,
    peakRssBytes: summary.peakRssBytes, sourceInventorySha256: design.sourceInventorySha256 }))
}
if (process.env.M16_STUDY_RUN === '1') runM16().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
