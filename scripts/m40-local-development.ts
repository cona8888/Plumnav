import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { runM40 } from './lib/m40-sampling-audit'

const output = resolve(process.env.M40_OUTPUT ?? 'research/results/m40-contact-controller-development.json')
const sourcePaths = ['scripts/lib/m40-contact-controller.ts', 'scripts/lib/m40-sampling-audit.ts',
  'scripts/lib/m30-move-resense.ts', 'scripts/lib/m37-rapid-fixed-quad.ts',
  'research/protocols/m40_contact_controller_development.md']
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const sourceInventory = await Promise.all(sourcePaths.map(async (path) => ({ path, sha256: sha(await readFile(path)) })))
const started = Date.now()
const result = `${JSON.stringify(runM40(), null, 2)}\n`
await mkdir(dirname(output), { recursive: true })
await writeFile(output, result, { flag: 'wx' })
const manifest = { complete: true, purpose: 'M40 controller development and corrected sampling audit',
  result: output, resultSha256: sha(result), sourceInventory, elapsedSeconds: (Date.now() - started) / 1000,
  node: process.version, platform: process.platform, architecture: process.arch }
await writeFile(output.replace(/\.json$/, '.complete.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify(manifest))
