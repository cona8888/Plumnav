import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runM20, M20_DESIGN } from './lib/m20-sensor-audit'
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
export const M20_ROOT = 'research/evidence/m20_sensor_uncertainty_2026-09-08'
if (process.env.M20_AUDIT_RUN === '1') {
  const inherited = JSON.parse(await readFile('research/evidence/m19_scan_order_2026-09-08/design.json', 'utf8')).sourceInventory as Array<{ path: string; sha256: string; bytes: number }>
  const sources = [...inherited.map((e) => e.path), 'scripts/lib/m20-sensor-audit.ts', 'scripts/m20-sensor-audit.ts',
    'scripts/m20-sensor-audit.test.ts', 'research/protocols/m20_sensor_uncertainty_protocol.md']
  const buffers = await Promise.all(sources.map(async (path) => ({ path, data: await readFile(path) })))
  for (const e of inherited) if (hash(buffers.find((b) => b.path === e.path)!.data) !== e.sha256) throw new Error(`Changed inherited source: ${e.path}`)
  await mkdir(M20_ROOT) // Intentionally refuse existing archive.
  const inventory = []
  for (const b of buffers) {
    const path = join(M20_ROOT, 'source-snapshot', b.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, b.data, { flag: 'wx' })
    inventory.push({ path: b.path, bytes: b.data.length, sha256: hash(b.data) })
  }
  const write = async (name: string, value: unknown) => {
    const data = Buffer.from(JSON.stringify(value, null, 2) + '\n'); await writeFile(join(M20_ROOT, name), data, { flag: 'wx' })
    return { path: name, bytes: data.length, sha256: hash(data) }
  }
  const design = await write('design.json', { ...M20_DESIGN, sourceInventory: inventory })
  const start = performance.now(); const result = runM20(); const elapsedSeconds = (performance.now() - start) / 1000
  const output = await write('results.json', result)
  const runtime = await write('runtime.json', { elapsedSeconds, peakRssBytes: process.resourceUsage().maxRSS * 1024, node: process.version, arch: process.arch })
  await write('checksums.json', { complete: true, inventory: [design, output, runtime] })
  console.log(JSON.stringify({ complete: true, quadConditions: result.quad.length, centralConditions: result.central.length, elapsedSeconds }))
}
