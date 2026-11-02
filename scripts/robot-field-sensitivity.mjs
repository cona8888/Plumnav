/** Print one CSV line per commissioning flight, including rejected calibrations. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const viteNode = join(root, 'node_modules', 'vite-node', 'vite-node.mjs')
const replay = join(root, 'scripts', 'robot-field-replay.ts')
function median(values) {
  if (!values.length) return ''
  const sorted = [...values].sort((a, b) => a - b)
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
}

const rows = [['commissioning_flight', 'status', 'rejection_reason', 'spaced_blank_readings', 'threshold_mV',
  'intended_search_flights', 'scored_flights', 'gas_positive_flights', 'no_hit_flights',
  'infotaxis_declarations', 'peak_declarations', 'gas_positive_infotaxis_median_error_m',
  'same_flights_peak_median_error_m']]
for (let flight = 1; flight <= 10; flight++) {
  const text = execFileSync(process.execPath, [viteNode, replay, '--commissioning-flight=' + flight],
    { cwd: root, encoding: 'utf8' })
  const { results, skipped, commissioning } = JSON.parse(text)
  const blank = commissioning.result
  const ids = [...results, ...skipped].map(r => r.flight)
  if (commissioning.flight !== flight || !skipped.some(r => r.flight === flight && r.reason === 'reserved-commissioning-flight') ||
      new Set(ids).size !== 10 || ids.length !== 10 || results.some(r => r.flight === flight) ||
      results.length !== (blank.status === 'ready' ? 9 : 0)) {
    throw new Error('Invalid held-out split for commissioning flight ' + flight)
  }
  const positive = results.filter(r => r.hits > 0)
  const evaluated = results.length > 0
  rows.push([flight, blank.status, blank.reason ?? '', blank.count, blank.threshold ?? '', 9, results.length,
    evaluated ? positive.length : '', evaluated ? results.length - positive.length : '',
    evaluated ? results.filter(r => r.infotaxisDeclared).length : '',
    evaluated ? results.filter(r => r.coverageDeclared).length : '',
    median(positive.map(r => r.infotaxisEstimateErrorM)), median(positive.map(r => r.alignedCoverage1HzErrorM))])
}
console.log(rows.map(row => row.join(',')).join('\n'))
