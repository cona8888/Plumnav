/** Offline replay of versioned measurement inputs and the separate simulated holdout. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const directory = dirname(fileURLToPath(import.meta.url))
const root = dirname(directory)
const viteNode = join(root, 'node_modules', 'vite-node', 'vite-node.mjs')
const read = (path) => readFileSync(join(directory, path), 'utf8')

function replay(script, args = []) {
  return execFileSync(process.execPath, [viteNode, join(root, 'scripts', script), ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 8 * 1024 * 1024,
  })
}

function compare(expected, actual, label) {
  if (expected === actual) return
  if (typeof expected === 'number' && typeof actual === 'number' && Number.isFinite(actual) &&
      Math.abs(actual - expected) <= 1e-8 + 1e-12 * Math.abs(expected)) return
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object' &&
      Array.isArray(expected) === Array.isArray(actual)) {
    const keys = Object.keys(expected)
    if (keys.length === Object.keys(actual).length && keys.every(key => Object.hasOwn(actual, key))) {
      for (const key of keys) compare(expected[key], actual[key], `${label}.${key}`)
      return
    }
  }
  throw new Error(`${label}: expected ${JSON.stringify(expected).slice(0,140)}, got ${JSON.stringify(actual).slice(0,140)}`)
}

// Compare deterministic CSV text exactly, allowing only numerical roundoff in the numeric tables.
// The decision log contains unrestricted quoted text; its entire line must match.
function compareCsv(expected, actual, name) {
  const reference = expected.trimEnd().split(/\r?\n/)
  const rows = actual.trimEnd().split(/\r?\n/)
  compare(reference.length, rows.length, `${name} rows`)
  reference.forEach((row, i) => {
    if (row === rows[i]) return
    if (!i || name === 'decisions.csv') throw new Error(`${name}:${i + 1}: text mismatch`)
    const parse = line => line.split(',').map(cell => cell !== '' && Number.isFinite(Number(cell)) ? Number(cell) : cell)
    compare(parse(row), parse(rows[i]), `${name}:${i + 1}`)
  })
}

const checks = read('SHA256SUMS').trimEnd().split(/\r?\n/)
for (const line of checks) {
  const match = /^([a-f0-9]{64})  ((?:data|expected|synthetic|examples)\/[A-Za-z0-9_./-]+)$/.exec(line)
  if (!match || match[2].split('/').includes('..')) throw new Error(`Malformed SHA256SUMS entry: ${line}`)
  const [, expected, path] = match
  const digest = createHash('sha256').update(readFileSync(join(directory, path))).digest('hex')
  if (expected !== digest) throw new Error(`Input/reference checksum mismatch: ${path}`)
}
console.log(`Node ${process.versions.node}: verified ${checks.length} file checksums`)

const campaigns = {
  epfl: 'robot-field-replay.ts', blackpool: 'blackpool-field-replay.ts',
  matrix: 'methane-field-matrix.ts', epa: 'empirical-epa-replay.ts',
}
for (const [id, script] of Object.entries(campaigns)) {
  const actual = JSON.parse(replay(script))
  compare(JSON.parse(read(`expected/${id}.json`)), actual, id)
  console.log(`${id}: ${actual.results.length} scored flights, surveys or passes match the reference`)
}

const sensitivity = execFileSync(process.execPath, [join(root, 'scripts', 'robot-field-sensitivity.mjs')], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
})
compareCsv(read('data/epfl/commissioning-sensitivity.csv'), sensitivity, 'commissioning-sensitivity.csv')
console.log('EPFL transfer: all ten commissioning choices and their held-out results match the reference')

const work = mkdtempSync(join(tmpdir(), 'plumnav-holdout-'))
try {
  const output = resolve(work, 'survey') // the mission runner creates a fresh directory
  replay('validate-fitting-survey.ts', ['--holdout', output])
  for (const name of ['missions.csv', 'decisions.csv', 'visits.csv', 'verification-visits.csv', 'readings.csv']) {
    const path = `synthetic/fitting-holdout/${name}`
    const reference = name === 'readings.csv' ? gunzipSync(readFileSync(join(directory, `${path}.gz`))).toString('utf8') : read(path)
    compareCsv(reference, readFileSync(join(output, name), 'utf8'), name)
  }
  console.log('simulated fitting holdout: all 12 mission outcomes, visits and sensor traces match the reference')
} finally {
  rmSync(work, { recursive: true, force: true })
}
