import { readFileSync } from 'node:fs'
import { createDefaultConfig } from '../src/sim/config'
import { GSL_REFERENCE_DESIGN } from '../src/sim/physicalDesign'
import { benchSetup, parseBenchCsv, runBenchCalibration, syntheticBenchTraces, withCalibratedSIInlet } from './field-sensor-calibration'

const args = process.argv.slice(2)
if (args.length && args.length !== 2 && args.length !== 3) {
  throw new Error('Usage: vite-node scripts/field-sensor-calibration.cli.ts [training.csv holdout.csv [bench-setup.json]]')
}
const design = { ...GSL_REFERENCE_DESIGN, referenceWindMetresPerSecond: 0.02 }
if (args[2]) {
  const settings = JSON.parse(readFileSync(args[2], 'utf8'))
  const keys = Object.keys(benchSetup(design))
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      Object.keys(settings).some(k => !keys.includes(k) || !Number.isFinite(settings[k])) ||
      keys.some(k => !(k in settings))) throw new Error('Supply all four numeric bench setup fields as documented')
  Object.assign(design, settings)
}
const { training, holdout } = args.length
  ? { training: parseBenchCsv(readFileSync(args[0], 'utf8')), holdout: parseBenchCsv(readFileSync(args[1], 'utf8')) }
  : syntheticBenchTraces()
const result = runBenchCalibration(training, holdout, design)
const config = withCalibratedSIInlet(createDefaultConfig('quad-sniff-refine', 'open'), result.fit, design)
console.log(JSON.stringify({
  dataSource: args.length ? { training: args[0], holdout: args[1] } : 'manufactured RK4 pulse traces with independent noise seeds',
  ...result,
  settlingSeconds: config.localInletSampling!.inspection.settlingSeconds,
  dwellSeconds: config.localInletSampling!.inspection.dwellSeconds,
}, null, 2))
