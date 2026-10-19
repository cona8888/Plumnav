import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {join, resolve, dirname} from 'node:path'
import {gzipSync} from 'node:zlib'
import {arch, platform} from 'node:os'
import {DESIGN, makeTrace, pilotSpecs, sensorModels} from './lib/outdoor-detectability'

const sources = ['scripts/lib/outdoor-detectability.ts', 'scripts/run-outdoor-detectability.ts',
  'scripts/test-outdoor-detectability.ts', 'scripts/audit-outdoor-detectability.py',
  'scripts/test-outdoor-detectability-audit.py', 'src/sim/halfspaceTransport.ts',
  'research/protocols/outdoor_detectability_v1_2026-09-22.md',
  'outputs/run-outdoor-detectability.mjs', 'outputs/outdoor-detectability.meta.json']
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const sourceHashes = () => sources.map(file => ({file, sha256: sha(readFileSync(file))}))
const originalBundle = 'aws/build/stage2i-20260921-v2/bundle.json'
function frozenStatus() {
  const bundle = JSON.parse(readFileSync(originalBundle, 'utf8'))
  if (bundle.frozenSources.length !== 141) throw Error('Original source inventory mismatch')
  const hashes = bundle.frozenSources.map((row: {original: string; sha256: string}) => {
    if (sha(readFileSync(row.original)) !== row.sha256) throw Error(`Original science changed: ${row.original}`)
    return {file: row.original, sha256: row.sha256}
  })
  return {bundle: originalBundle, bundleSha256: sha(readFileSync(originalBundle)), hashes}
}
const specs = pilotSpecs()
if (process.argv.length === 3 && process.argv[2] === '--plan') {
  console.log(JSON.stringify({design: DESIGN, sensors: sensorModels(), specs, primaryOutcomes: 1152,
    independentWorldsPerSetting: 4, paidLaunchAuthorized: false}, null, 2)); process.exit(0)
}
if (process.argv.length !== 4 || process.argv[2] !== '--output') throw Error('Usage: run-outdoor-detectability --output NEW_DIRECTORY (pilot only)')
const output = resolve(process.argv[3]!), started = performance.now()
const before = sourceHashes(), frozen = frozenStatus()
// Exclusive creation protects diagnostic failures and any earlier result.
mkdirSync(output)
const write = (name: string, value: unknown) => writeFileSync(join(output, name), JSON.stringify(value) + '\n', {flag: 'wx'})
mkdirSync(join(output, 'source-snapshot'))
for (const row of before) {
  const target = join(output, 'source-snapshot', row.file)
  mkdirSync(dirname(target), {recursive: true})
  writeFileSync(target, readFileSync(row.file), {flag: 'wx'})
}
write('manifest.json', {schemaVersion: DESIGN.version, createdAt: new Date().toISOString(),
  mode: 'development-pilot', campaignEnabled: false, design: DESIGN, sensors: sensorModels(), specs,
  sourceHashes: before, frozenStage2i: frozen, runtime: {node: process.version, arch: arch(), platform: platform()},
  claimBoundary: 'Model-conditional ground point/extractive sensing; no physical validation, localisation or minimum-detectable-rate claim.'})
try {
  const files: {file: string; sha256: string; bytes: number; seconds: number}[] = []
  for (let i = 0; i < specs.length; i++) {
    const start = performance.now(), trace = makeTrace(specs[i]!)
    const file = `trace-${String(i).padStart(3, '0')}.json.gz`, bytes = gzipSync(JSON.stringify(trace))
    writeFileSync(join(output, file), bytes, {flag: 'wx'})
    const receipt = {file, sha256: sha(bytes), bytes: bytes.length, seconds: (performance.now() - start) / 1000}
    files.push(receipt); write(`trace-${String(i).padStart(3, '0')}.receipt.json`, receipt)
    console.log(JSON.stringify({finished: i + 1, expected: specs.length, spec: specs[i], seconds: receipt.seconds}))
  }
  if (JSON.stringify(before) !== JSON.stringify(sourceHashes())) throw Error('Sources changed during pilot')
  frozenStatus()
  write('execution-complete.json', {executionComplete: true, independentlyAccepted: false,
    manifestSha256: sha(readFileSync(join(output, 'manifest.json'))), files,
    seconds: (performance.now() - started) / 1000, originalScientificFilesUnchanged: 141})
  console.log(JSON.stringify({executionComplete: true, independentlyAccepted: false, output, seconds: (performance.now() - started) / 1000}))
} catch (error) {
  write('failure.json', {failed: true, diagnosticOnly: true, message: String(error)})
  throw error
}
