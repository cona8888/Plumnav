import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { runM34 } from './lib/m34-locked-intake-agreement'

const output = resolve(process.env.M34_OUTPUT ?? 'research/results/m34-locked-intake-agreement-development.json')
const manifestOutput = resolve(process.env.M34_MANIFEST_OUTPUT ?? 'research/results/m34-locked-intake-agreement-development.complete.json')
const result = `${JSON.stringify(runM34(), null, 2)}\n`
await mkdir(dirname(output), { recursive: true })
await writeFile(output, result, { flag: 'wx' })
const manifest = { complete: true, purpose: 'M34 safety-restoration development; not confirmatory', result: output,
  resultSha256: createHash('sha256').update(result).digest('hex'), node: process.version,
  platform: process.platform, architecture: process.arch }
await writeFile(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify(manifest))
