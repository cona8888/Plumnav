import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { M18_DESIGN, m18Plans, m18Rows, screenM18 } from './lib/m18-geometry-feasibility'

const prior = 'research/evidence/m17_paired_prediction_2026-09-06'
export const M18_OUTPUT = 'research/evidence/m18_geometry_feasibility_2026-09-08'
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
export const runM18 = async () => {
  const bytes = await readFile(join(prior, 'design.json')); const previous = JSON.parse(bytes.toString())
  const previousInventory = JSON.parse(await readFile(join(prior, 'checksums.json'), 'utf8'))
  if (hash(bytes) !== previousInventory.inventory.find((e: any) => e.path === 'design.json').sha256) throw new Error('M17 design mismatch')
  for (const e of previous.sourceInventory) if (hash(await readFile(e.path)) !== e.sha256) throw new Error(`M17 source changed: ${e.path}`)
  const paths = [...previous.sourceInventory.map((e: any) => e.path), 'scripts/lib/m18-geometry-feasibility.ts',
    'scripts/m18-geometry-screen.ts', 'scripts/m18-feasibility.test.ts', 'research/protocols/m18_geometry_feasibility_protocol.md'].sort() as string[]
  const sourceInventory = await Promise.all(paths.map(async (path) => {
    const b = await readFile(path); return { path, bytes: b.length, sha256: hash(b) }
  }))
  const plans = m18Plans()
  if (plans.length !== 144 || new Set(paths).size !== 78) throw new Error('Incorrect design dimensions')
  const design = { ...M18_DESIGN, plans, sourceInventory, sourceInventorySha256: hash(json(sourceInventory)),
    m17DesignSha256: hash(bytes), runtime: { node: process.version, v8: process.versions.v8, arch: process.arch } }
  await mkdir(M18_OUTPUT, { recursive: true }); await writeFile(join(M18_OUTPUT, 'design.json'), json(design), { flag: 'wx' })
  for (const path of paths) {
    const target = join(M18_OUTPUT, 'source-snapshot', path)
    await mkdir(dirname(target), { recursive: true }); await copyFile(path, target)
  }
  const inventory: Array<{ path: string; bytes: number; sha256: string }> = []
  const capture = async (path: string) => { const b = await readFile(join(M18_OUTPUT, path)); inventory.push({ path, bytes: b.length, sha256: hash(b) }) }
  await capture('design.json')
  const startedAt = new Date().toISOString(); const summaries = []; let epochs = 0
  for (const plan of plans) {
    const result = screenM18(plan); const geometry = result.epochs.map((e) => m18Rows(plan, e.block))
    const path = `${plan.id}.json`
    await writeFile(join(M18_OUTPUT, path), json({ result, geometry }), { flag: 'wx' }); await capture(path)
    summaries.push({ plan, feasible: result.feasible, worstPredictionAllowance: result.worstPredictionAllowance,
      worstResidualAllowance: result.worstResidualAllowance }); epochs += result.epochs.length
  }
  if (epochs !== 432) throw new Error('Missing matrix checks')
  for (const e of sourceInventory) if (hash(await readFile(e.path)) !== e.sha256) throw new Error(`Source changed during M18: ${e.path}`)
  const summary = { complete: true, geometryOnly: true, startedAt, completedAt: new Date().toISOString(), plans: plans.length,
    epochs, plumeTrajectories: 0, summaries, sourceInventorySha256: design.sourceInventorySha256, peakRssBytes: process.resourceUsage().maxRSS * 1024 }
  await writeFile(join(M18_OUTPUT, 'summary.json'), json(summary), { flag: 'wx' }); await capture('summary.json')
  await writeFile(join(M18_OUTPUT, 'checksums.json'), json({ complete: true, inventory }), { flag: 'wx' })
  process.stdout.write(json({ complete: true, plans: plans.length, epochs, plumeTrajectories: 0,
    elapsedWallSeconds: (Date.parse(summary.completedAt) - Date.parse(startedAt)) / 1000,
    peakRssBytes: summary.peakRssBytes, sourceInventorySha256: design.sourceInventorySha256 }))
}
if (process.env.M18_SCREEN_RUN === '1') runM18().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
