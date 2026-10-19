import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { runM35 } from './lib/m35-staged-repeated-sniff'

const output = resolve(process.env.M35_OUTPUT ?? 'research/results/m35-staged-repeated-sniff-development.json')
const manifestOutput = resolve(process.env.M35_MANIFEST_OUTPUT ?? 'research/results/m35-staged-repeated-sniff-development.complete.json')
const result = `${JSON.stringify(runM35(), null, 2)}\n`
await mkdir(dirname(output), { recursive: true })
await writeFile(output, result, { flag: 'wx' })
const manifest = { complete: true, purpose: 'M35 staged repeated-sniff development; not confirmatory', result: output,
  resultSha256: createHash('sha256').update(result).digest('hex'), node: process.version,
  platform: process.platform, architecture: process.arch }
await writeFile(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify(manifest))
