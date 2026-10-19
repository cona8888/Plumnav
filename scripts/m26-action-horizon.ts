import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runM26, M26_DESIGN } from './lib/m26-action-horizon'
export const M26_ROOT = 'research/evidence/m26_action_horizon_2026-09-09'
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
if (process.env.M26_RUN === '1') {
  const inherited = JSON.parse(await readFile('research/evidence/m24_time_aware_2026-09-09/design.json', 'utf8')).sourceInventory as Array<{ path: string; sha256: string }>
  const paths = [...inherited.map((e) => e.path), 'scripts/lib/m26-action-horizon.ts', 'scripts/m26-action-horizon.ts', 'scripts/m26-action-horizon.test.ts', 'research/protocols/m26_action_horizon_protocol.md']
  const unique = [...new Set(paths)], sources = await Promise.all(unique.map(async (path) => ({ path, data: await readFile(path) })))
  for (const e of inherited) if (hash(sources.find((s) => s.path === e.path)!.data) !== e.sha256) throw new Error(`Changed inherited source ${e.path}`)
  await mkdir(M26_ROOT)
  const sourceInventory = []
  for (const s of sources) { const target = join(M26_ROOT, 'source-snapshot', s.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, s.data, { flag: 'wx' }); sourceInventory.push({ path: s.path, bytes: s.data.length, sha256: hash(s.data) }) }
  const write = async (name: string, value: unknown) => { const data = Buffer.from(JSON.stringify(value) + '\n'); await writeFile(join(M26_ROOT, name), data, { flag: 'wx' }); return { path: name, bytes: data.length, sha256: hash(data) } }
  const inventory = [await write('design.json', { ...M26_DESIGN, sourceInventory })]
  const start = performance.now(), result = runM26(), elapsedSeconds = (performance.now() - start) / 1000
  inventory.push(await write('results.json', result), await write('runtime.json', { elapsedSeconds, peakRssBytes: process.resourceUsage().maxRSS * 1024, node: process.version, arch: process.arch }))
  await write('checksums.json', { complete: true, inventory })
  console.log(JSON.stringify({ complete: true, episodes: result.episodes, actions: result.actions, advances: result.advancesToReacquisitionTest, failures: { safety: result.failures.safety.length, distance: result.failures.distance.length, gainCells: result.failures.gainCells.length, slowFollow: result.failures.slowFollow.length, overallGain: result.failures.overallGain, challengeFraction: result.failures.challengeFraction }, elapsedSeconds }))
}
