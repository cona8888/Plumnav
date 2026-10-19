import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { runM39 } from './lib/m39-contact-observability'

const output = resolve(process.env.M39_OUTPUT ?? 'research/results/m39-contact-observability-audit.json')
const manifestOutput = resolve(process.env.M39_MANIFEST_OUTPUT ?? 'research/results/m39-contact-observability-audit.complete.json')
const result = `${JSON.stringify(runM39(), null, 2)}\n`
await mkdir(dirname(output), { recursive: true })
await writeFile(output, result, { flag: 'wx' })
const manifest = { complete: true, purpose: 'M39 contact/observability audit; diagnostic only', result: output,
  resultSha256: createHash('sha256').update(result).digest('hex'), node: process.version,
  platform: process.platform, architecture: process.arch }
await writeFile(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify(manifest))
