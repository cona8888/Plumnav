/** Read locally recorded, already time-aligned sensor data. No source labels are required. */
import { readFileSync } from 'node:fs'
import { BlankBaseline } from '../src/sim/baseline'
import { estimateCurtainBearing } from '../src/sim/curtainBearing'

const [mode, file] = process.argv.slice(2)
if (!file || process.argv.length !== 4 || (mode !== 'blank' && mode !== 'bearing')) {
  throw new Error('Usage: pnpm field:analyze <blank|bearing> record.json')
}
const record = JSON.parse(readFileSync(file, 'utf8'))
if (!Array.isArray(record?.samples) || !record.samples.length) throw new Error('Expected a nonempty array of samples')
if (mode === 'blank') {
  if (typeof record.signalUnit !== 'string' || !record.signalUnit.trim()) throw new Error('Specify the gas channel unit')
  const baseline = new BlankBaseline(record.policy)
  for (const sample of record.samples) {
    if (typeof sample?.inReference !== 'boolean' || typeof sample.valid !== 'boolean' ||
        (sample.clipped !== undefined && typeof sample.clipped !== 'boolean') ||
        (sample.contaminated !== undefined && typeof sample.contaminated !== 'boolean')) throw new Error('Invalid blank reading flags')
    baseline.observe(sample)
  }
  console.log(JSON.stringify({ signalUnit: record.signalUnit, ...baseline.finish() }, null, 2))
} else {
  console.log(JSON.stringify(estimateCurtainBearing(record.samples, record.wind, record.minimumEnhancementPpm), null, 2))
}
