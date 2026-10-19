import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runM23, M23_DESIGN } from './lib/m23-rotation-transfer'
export const M23_ROOT = 'research/evidence/m23_rotation_transfer_2026-09-09'
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
if (process.env.M23_RUN === '1') {
  const inherited = JSON.parse(await readFile('research/evidence/m22_recovery_2026-09-08/design.json', 'utf8')).sourceInventory as Array<{ path: string; sha256: string }>
  const paths = [...inherited.map((e) => e.path), 'scripts/m22-archive-verification.test.ts', 'scripts/lib/m23-rotation-transfer.ts',
    'scripts/m23-rotation-transfer.ts', 'scripts/m23-rotation-transfer.test.ts', 'research/protocols/m23_rotation_transfer_protocol.md']
  const sources = await Promise.all(paths.map(async (path) => ({ path, data: await readFile(path) })))
  for (const e of inherited) if (hash(sources.find((s) => s.path === e.path)!.data) !== e.sha256) throw new Error(`Changed inherited source ${e.path}`)
  await mkdir(M23_ROOT)
  const sourceInventory = []
  for (const s of sources) {
    const target = join(M23_ROOT, 'source-snapshot', s.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, s.data, { flag: 'wx' })
    sourceInventory.push({ path: s.path, bytes: s.data.length, sha256: hash(s.data) })
  }
  const write = async (name: string, value: unknown) => {
    const data = Buffer.from(JSON.stringify(value) + '\n'); await writeFile(join(M23_ROOT, name), data, { flag: 'wx' })
    return { path: name, bytes: data.length, sha256: hash(data) }
  }
  const inventory = [await write('design.json', { ...M23_DESIGN, sourceInventory })]
  const start = performance.now(); const result = runM23(); const elapsedSeconds = (performance.now() - start) / 1000
  inventory.push(await write('results.json', result), await write('summary.json', result.summary),
    await write('runtime.json', { elapsedSeconds, peakRssBytes: process.resourceUsage().maxRSS * 1024, node: process.version, arch: process.arch }))
  await write('checksums.json', { complete: true, inventory })
  console.log(JSON.stringify({ complete: true, episodes: result.episodes.length,
    aggregateFailures: result.summary.aggregateFailures.length, staticFailures: result.summary.staticFailures.length,
    advances: result.summary.advancesToExecutedActionTest, elapsedSeconds }))
}
