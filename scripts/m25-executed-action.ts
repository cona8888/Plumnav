import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runM25, M25_DESIGN } from './lib/m25-executed-action'
export const M25_ROOT = 'research/evidence/m25_executed_action_2026-09-09'
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
if (process.env.M25_RUN === '1') {
  const inherited = JSON.parse(await readFile('research/evidence/m24_time_aware_2026-09-09/design.json', 'utf8')).sourceInventory as Array<{ path: string; sha256: string }>
  const paths = [...inherited.map((e) => e.path), 'scripts/lib/m25-executed-action.ts', 'scripts/m25-executed-action.ts',
    'scripts/m25-executed-action.test.ts', 'research/protocols/m25_executed_action_protocol.md']
  const sources = await Promise.all(paths.map(async (path) => ({ path, data: await readFile(path) })))
  for (const e of inherited) if (hash(sources.find((s) => s.path === e.path)!.data) !== e.sha256) throw new Error(`Changed source ${e.path}`)
  const m24Checks = JSON.parse(await readFile('research/evidence/m24_time_aware_2026-09-09/checksums.json', 'utf8')) as { inventory: Array<{ path: string; sha256: string }> }
  for (const e of m24Checks.inventory) if (hash(await readFile(join('research/evidence/m24_time_aware_2026-09-09', e.path))) !== e.sha256) throw new Error(`Changed M24 evidence ${e.path}`)
  const archive = JSON.parse(await readFile('research/evidence/m24_time_aware_2026-09-09/results.json', 'utf8'))
  await mkdir(M25_ROOT)
  const sourceInventory = []
  for (const s of sources) { const target = join(M25_ROOT, 'source-snapshot', s.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, s.data, { flag: 'wx' }); sourceInventory.push({ path: s.path, bytes: s.data.length, sha256: hash(s.data) }) }
  const write = async (name: string, value: unknown) => { const data = Buffer.from(JSON.stringify(value) + '\n'); await writeFile(join(M25_ROOT, name), data, { flag: 'wx' }); return { path: name, bytes: data.length, sha256: hash(data) } }
  const inventory = [await write('design.json', { ...M25_DESIGN, m24Evidence: m24Checks.inventory, sourceInventory })]
  const start = performance.now(); const result = runM25(archive); const elapsedSeconds = (performance.now() - start) / 1000
  inventory.push(await write('results.json', result), await write('runtime.json', { elapsedSeconds, peakRssBytes: process.resourceUsage().maxRSS * 1024, node: process.version, arch: process.arch }))
  await write('checksums.json', { complete: true, inventory })
  console.log(JSON.stringify({ complete: true, actions: result.actions, advances: result.advancesToReacquisitionTest,
    safetyFailures: result.failures.safety.length, distanceFailures: result.failures.distance.length,
    gainFailures: result.failures.gainCells.length, overallGain: result.failures.overallGain, elapsedSeconds }))
}
