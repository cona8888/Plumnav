import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runM27, M27_DESIGN } from './lib/m27-feasible-action'
export const M27_ROOT = 'research/evidence/m27_feasible_action_2026-09-09'
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
if (process.env.M27_RUN === '1') {
  const inherited = JSON.parse(await readFile('research/evidence/m26_action_horizon_2026-09-09/design.json', 'utf8')).sourceInventory as Array<{ path: string; sha256: string }>
  const paths = [...new Set([...inherited.map((e) => e.path), 'scripts/lib/m26-action-horizon.ts', 'scripts/lib/m27-feasible-action.ts', 'scripts/m27-feasible-action.ts', 'scripts/m27-feasible-action.test.ts', 'research/protocols/m27_feasible_action_protocol.md'])]
  const sources = await Promise.all(paths.map(async (path) => ({ path, data: await readFile(path) })))
  await mkdir(M27_ROOT); const sourceInventory = []
  for (const s of sources) { const target = join(M27_ROOT, 'source-snapshot', s.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, s.data, { flag: 'wx' }); sourceInventory.push({ path: s.path, bytes: s.data.length, sha256: hash(s.data) }) }
  const write = async (name: string, value: unknown) => { const data = Buffer.from(JSON.stringify(value) + '\n'); await writeFile(join(M27_ROOT, name), data, { flag: 'wx' }); return { path: name, bytes: data.length, sha256: hash(data) } }
  const inventory = [await write('design.json', { ...M27_DESIGN, sourceInventory })], start = performance.now(), result = runM27(), elapsedSeconds = (performance.now() - start) / 1000
  inventory.push(await write('results.json', result), await write('runtime.json', { elapsedSeconds, peakRssBytes: process.resourceUsage().maxRSS * 1024, node: process.version, arch: process.arch })); await write('checksums.json', { complete: true, inventory })
  console.log(JSON.stringify({ complete: true, episodes: result.episodes, actions: result.actions, advances: result.advancesToReacquisitionTest, failures: { safety: result.failures.safety.length, distance: result.failures.distance.length, gainCells: result.failures.gainCells.length, slowFollow: result.failures.slowFollow.length, overallGain: result.failures.overallGain }, elapsedSeconds }))
}
