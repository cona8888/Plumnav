import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'
import {gunzipSync} from 'node:zlib'
import {join} from 'node:path'
import {makeTrace} from './lib/outdoor-detectability'

if (process.argv.length !== 3) throw Error('Usage: check-outdoor-reproducibility PILOT_DIRECTORY')
const root = process.argv[2]!
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
for (const row of manifest.sourceHashes) assert.equal(sha(readFileSync(row.file)), row.sha256)
const original = JSON.parse(gunzipSync(readFileSync(join(root, 'trace-000.json.gz'))).toString())
const start = performance.now(), repeated = makeTrace(original.spec)
assert.deepEqual(repeated, original)
const result = {passed: true, scope: 'complete first primary history, not every campaign case',
  regeneratedInletRows: repeated.inlet.length, regeneratedSensorHistories: repeated.measurements.length,
  manifestSha256: sha(readFileSync(join(root, 'manifest.json'))),
  traceSha256: sha(readFileSync(join(root, 'trace-000.json.gz'))),
  checkerSourceSha256: sha(readFileSync('scripts/check-outdoor-reproducibility.ts')),
  checkedAt: new Date().toISOString(), seconds: (performance.now() - start) / 1000}
writeFileSync(join(root, 'reproducibility.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'})
console.log(JSON.stringify(result))
