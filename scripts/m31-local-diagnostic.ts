import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { runM31 } from './lib/m31-m30-diagnostics'

const output = resolve(process.env.M31_OUTPUT ?? 'research/results/m31-m30-failure-diagnostic.json')
const manifestOutput = resolve(process.env.M31_MANIFEST_OUTPUT ?? 'research/results/m31-m30-failure-diagnostic.complete.json')
const result = `${JSON.stringify(runM31(), null, 2)}\n`
await mkdir(dirname(output), { recursive: true })
await writeFile(output, result, { flag: 'wx' })
const manifest = {
  complete: true,
  purpose: 'M31 deterministic diagnostic audit; not a candidate pass',
  result: output,
  resultSha256: createHash('sha256').update(result).digest('hex'),
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
}
await writeFile(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify(manifest))
