import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { runM36 } from './lib/m36-quadratic-temporal'

const output = resolve(process.env.M36_OUTPUT ?? 'research/results/m36-quadratic-temporal-development.json')
const manifestOutput = resolve(process.env.M36_MANIFEST_OUTPUT ?? 'research/results/m36-quadratic-temporal-development.complete.json')
const result = `${JSON.stringify(runM36(), null, 2)}\n`
await mkdir(dirname(output), { recursive: true })
await writeFile(output, result, { flag: 'wx' })
const manifest = { complete: true, purpose: 'M36 quadratic temporal development; not confirmatory', result: output,
  resultSha256: createHash('sha256').update(result).digest('hex'), node: process.version,
  platform: process.platform, architecture: process.arch }
await writeFile(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify(manifest))
