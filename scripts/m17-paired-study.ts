import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { M17_DESIGN, m17Jobs, simulateM17, scoreM17 } from './lib/m17-paired-study'
import { M17_POLICY } from './lib/m17-prediction-guard'

const prior = 'research/evidence/m16_space_time_multiscale_2026-09-06'
export const M17_OUTPUT = 'research/evidence/m17_paired_prediction_2026-09-06'
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
export const runM17 = async () => {
  const bytes = await readFile(join(prior, 'design.json')); const previous = JSON.parse(bytes.toString())
  const previousInventory = JSON.parse(await readFile(join(prior, 'checksums.json'), 'utf8'))
  if (hash(bytes) !== previousInventory.inventory.find((e: any) => e.path === 'design.json').sha256) throw new Error('M16 design hash mismatch')
  for (const e of previous.sourceInventory) if (hash(await readFile(e.path)) !== e.sha256) throw new Error(`M16 source changed: ${e.path}`)
  const paths = [...previous.sourceInventory.map((e: any) => e.path), 'scripts/lib/m17-prediction-guard.ts',
    'scripts/lib/m17-paired-study.ts', 'scripts/m17-paired-study.ts', 'scripts/m17-candidate.test.ts',
    'research/protocols/m17_paired_prediction_protocol.md'].sort() as string[]
  const sourceInventory = await Promise.all(paths.map(async (path) => {
    const b = await readFile(path); return { path, bytes: b.length, sha256: hash(b) }
  }))
  const jobs = m17Jobs()
  if (jobs.length !== M17_DESIGN.expectedTrajectories || new Set(paths).size !== 74) throw new Error('Incorrect design dimensions')
  const design = { ...M17_DESIGN, policy: M17_POLICY, jobs, sourceInventory,
    sourceInventorySha256: hash(json(sourceInventory)), m16DesignSha256: hash(bytes),
    runtime: { node: process.version, v8: process.versions.v8, arch: process.arch },
    verificationSubset: jobs.filter((j) => ['moving', 'breathing'].includes(j.field) && j.width === 0.024 && j.period === 5 && j.offset === 0.015 && j.seed === 17101).map((j) => j.id) }
  await mkdir(M17_OUTPUT, { recursive: true }); await writeFile(join(M17_OUTPUT, 'design.json'), json(design), { flag: 'wx' })
  for (const path of paths) {
    const target = join(M17_OUTPUT, 'source-snapshot', path)
    await mkdir(dirname(target), { recursive: true }); await copyFile(path, target)
  }
  const inventory: Array<{ path: string; bytes: number; sha256: string }> = []
  const capture = async (path: string) => { const b = await readFile(join(M17_OUTPUT, path)); inventory.push({ path, bytes: b.length, sha256: hash(b) }) }
  await capture('design.json')
  const startedAt = new Date().toISOString(); const summaries = []; let scoreRecords = 0
  for (const [i, job] of jobs.entries()) {
    const observations = simulateM17(job); const analyses = scoreM17(observations)
    const path = `${job.id}.json`
    await writeFile(join(M17_OUTPUT, path), json({ observations, analyses }), { flag: 'wx' }); await capture(path)
    summaries.push({ job, estimators: analyses.map(({ estimator, summary }) => ({ estimator, ...summary })) })
    scoreRecords += analyses.reduce((s, a) => s + a.records.length, 0)
    if ((i + 1) % 145 === 0) process.stdout.write(`${i + 1}/${jobs.length} M17 trajectories\n`)
  }
  if (scoreRecords !== M17_DESIGN.expectedScores) throw new Error('Missing score records')
  for (const e of sourceInventory) if (hash(await readFile(e.path)) !== e.sha256) throw new Error(`Source changed during M17: ${e.path}`)
  const summary = { complete: true, diagnosticOnly: true, startedAt, completedAt: new Date().toISOString(),
    trajectories: jobs.length, scoreRecords, summaries, sourceInventorySha256: design.sourceInventorySha256,
    peakRssBytes: process.resourceUsage().maxRSS * 1024 }
  await writeFile(join(M17_OUTPUT, 'summary.json'), json(summary), { flag: 'wx' }); await capture('summary.json')
  await writeFile(join(M17_OUTPUT, 'checksums.json'), json({ complete: true, inventory }), { flag: 'wx' })
  process.stdout.write(json({ complete: true, trajectories: jobs.length, scoreRecords,
    elapsedWallSeconds: (Date.parse(summary.completedAt) - Date.parse(startedAt)) / 1000,
    peakRssBytes: summary.peakRssBytes, sourceInventorySha256: design.sourceInventorySha256 }))
}
if (process.env.M17_STUDY_RUN === '1') runM17().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
