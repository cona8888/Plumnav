import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { M19_DESIGN, m19Settings, m19Contexts, studyM19Setting } from './lib/m19-scan-order'

const prior = 'research/evidence/m18_geometry_feasibility_2026-09-08'
export const M19_OUTPUT = 'research/evidence/m19_scan_order_2026-09-08'
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
export const runM19 = async () => {
  const bytes = await readFile(join(prior, 'design.json')); const previous = JSON.parse(bytes.toString())
  const previousInventory = JSON.parse(await readFile(join(prior, 'checksums.json'), 'utf8'))
  if (hash(bytes) !== previousInventory.inventory.find((e: any) => e.path === 'design.json').sha256) throw new Error('M18 design mismatch')
  for (const e of previous.sourceInventory) if (hash(await readFile(e.path)) !== e.sha256) throw new Error(`M18 source changed: ${e.path}`)
  const paths = [...previous.sourceInventory.map((e: any) => e.path), 'scripts/lib/m19-scan-order.ts',
    'scripts/m19-order-study.ts', 'scripts/m19-scan-order.test.ts', 'research/protocols/m19_scan_order_protocol.md'].sort() as string[]
  const sourceInventory = await Promise.all(paths.map(async (path) => {
    const b = await readFile(path); return { path, bytes: b.length, sha256: hash(b) }
  }))
  const settings = m19Settings(); const contexts = m19Contexts()
  if (settings.length !== 18 || contexts.length !== 34 || new Set(paths).size !== 82) throw new Error('Incorrect dimensions')
  const design = { ...M19_DESIGN, settings, contexts, sourceInventory, sourceInventorySha256: hash(json(sourceInventory)),
    m18DesignSha256: hash(bytes), runtime: { node: process.version, v8: process.versions.v8, arch: process.arch } }
  await mkdir(M19_OUTPUT, { recursive: true }); await writeFile(join(M19_OUTPUT, 'design.json'), json(design), { flag: 'wx' })
  for (const path of paths) {
    const target = join(M19_OUTPUT, 'source-snapshot', path)
    await mkdir(dirname(target), { recursive: true }); await copyFile(path, target)
  }
  const inventory: Array<{ path: string; bytes: number; sha256: string }> = []
  const capture = async (path: string) => { const b = await readFile(join(M19_OUTPUT, path)); inventory.push({ path, bytes: b.length, sha256: hash(b) }) }
  await capture('design.json')
  const startedAt = new Date().toISOString(); const summaries = []; let factorialChecks = 0; let rolloutChecks = 0
  for (const [i, setting] of settings.entries()) {
    const result = studyM19Setting(setting); const path = `${setting.id}.json`
    await writeFile(join(M19_OUTPUT, path), json(result), { flag: 'wx' }); await capture(path)
    summaries.push({ setting, warmFeasibleContexts: result.warmFeasibleContexts, coldFeasibleContexts: result.coldFeasibleContexts,
      qualifiedRolloutDecisions: result.rollouts.reduce((n, r) => n + r.qualifiedDecisions, 0), eligibleForManufacturedDiagnostic: result.eligibleForManufacturedDiagnostic })
    factorialChecks += result.factorial.reduce((n, c) => n + c.candidates.length, 0)
    rolloutChecks += result.rollouts.reduce((n, r) => n + r.steps.reduce((m, s) => m + (s.decision?.candidates.length ?? 0), 0), 0)
    if ((i + 1) % 6 === 0) process.stdout.write(`${i + 1}/18 M19 settings complete\n`)
  }
  if (factorialChecks !== 4896 || rolloutChecks !== 1152) throw new Error('Missing candidate checks')
  for (const e of sourceInventory) if (hash(await readFile(e.path)) !== e.sha256) throw new Error(`Source changed during M19: ${e.path}`)
  const summary = { complete: true, geometryOnly: true, startedAt, completedAt: new Date().toISOString(), settings: 18,
    factorialChecks, rolloutChecks, rollouts: 36, plumeTrajectories: 0, summaries,
    sourceInventorySha256: design.sourceInventorySha256, peakRssBytes: process.resourceUsage().maxRSS * 1024 }
  await writeFile(join(M19_OUTPUT, 'summary.json'), json(summary), { flag: 'wx' }); await capture('summary.json')
  await writeFile(join(M19_OUTPUT, 'checksums.json'), json({ complete: true, inventory }), { flag: 'wx' })
  process.stdout.write(json({ complete: true, settings: 18, factorialChecks, rolloutChecks, plumeTrajectories: 0,
    elapsedWallSeconds: (Date.parse(summary.completedAt) - Date.parse(startedAt)) / 1000,
    peakRssBytes: summary.peakRssBytes, sourceInventorySha256: design.sourceInventorySha256 }))
}
if (process.env.M19_STUDY_RUN === '1') runM19().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
