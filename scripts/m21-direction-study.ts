import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runM21, M21_DESIGN, M21_FIELDS, M21_NUISANCES } from './lib/m21-direction-study'
export const M21_ROOT = 'research/evidence/m21_directional_component_2026-09-08'
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
if (process.env.M21_RUN === '1') {
  const inherited = JSON.parse(await readFile('research/evidence/m20_sensor_uncertainty_2026-09-08/design.json', 'utf8')).sourceInventory as Array<{ path: string; sha256: string }>
  const paths = [...inherited.map((e) => e.path), 'scripts/lib/m21-direction.ts', 'scripts/lib/m21-direction-study.ts',
    'scripts/m21-direction-study.ts', 'scripts/m21-direction.test.ts', 'research/protocols/m21_directional_component_protocol.md']
  const sources = await Promise.all(paths.map(async (path) => ({ path, data: await readFile(path) })))
  for (const e of inherited) if (hash(sources.find((s) => s.path === e.path)!.data) !== e.sha256) throw new Error(`Changed source ${e.path}`)
  await mkdir(M21_ROOT)
  const sourceInventory = []
  for (const s of sources) {
    const target = join(M21_ROOT, 'source-snapshot', s.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, s.data, { flag: 'wx' })
    sourceInventory.push({ path: s.path, bytes: s.data.length, sha256: hash(s.data) })
  }
  const write = async (name: string, value: unknown) => {
    const data = Buffer.from(JSON.stringify(value) + '\n'); await writeFile(join(M21_ROOT, name), data, { flag: 'wx' })
    return { path: name, bytes: data.length, sha256: hash(data) }
  }
  const inventory = [await write('design.json', { ...M21_DESIGN, fields: M21_FIELDS, nuisances: M21_NUISANCES, sourceInventory })]
  const start = performance.now(); const result = runM21(); const elapsedSeconds = (performance.now() - start) / 1000
  inventory.push(await write('results.json', result), await write('summary.json', result.summary),
    await write('runtime.json', { elapsedSeconds, peakRssBytes: process.resourceUsage().maxRSS * 1024, node: process.version, arch: process.arch }))
  await write('checksums.json', { complete: true, inventory })
  console.log(JSON.stringify({ complete: true, calibrations: result.calibrations.length, episodes: result.episodes.length,
    failingCells: result.summary.failures.length, advances: result.summary.advancesToFurtherComponentTest, elapsedSeconds }))
}
