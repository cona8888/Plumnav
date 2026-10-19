import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { runM37 } from './lib/m37-rapid-fixed-quad'

const output = resolve(process.env.M37_OUTPUT ?? 'research/results/m37-rapid-fixed-quad-development.json')
const manifestOutput = resolve(process.env.M37_MANIFEST_OUTPUT ?? 'research/results/m37-rapid-fixed-quad-development.complete.json')
const result = `${JSON.stringify(runM37(), null, 2)}\n`
await mkdir(dirname(output), { recursive: true })
await writeFile(output, result, { flag: 'wx' })
const manifest = { complete: true, purpose: 'M37 rapid fixed-heading quad development; not confirmatory', result: output,
  resultSha256: createHash('sha256').update(result).digest('hex'), node: process.version,
  platform: process.platform, architecture: process.arch }
await writeFile(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify(manifest))
