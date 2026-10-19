/** Development-only search for a positive simple-case endpoint control. */
import { SimulationEngine } from '../src/sim/engine'
import { createDefaultConfig } from '../src/sim/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const records: unknown[] = []
for (const algorithmId of ['coverage', 'surge-cast', 'infotaxis', 'quad-passive', 'quad-sniff-staged', 'quad-sniff', 'quad-sniff-wind'] as const) {
  let best = { seed: 0, error: Number.POSITIVE_INFINITY, success: false }
  for (let index = 0; index < 24; index += 1) {
    const config = createDefaultConfig(algorithmId, 'open')
    config.seed = 70_000 + index * 7_919
    config.sourceSeed = 80_000 + index * 15_485_863
    config.controllerSeed = 90_000 + index * 104_729
    config.observationModelSeed = 100_000 + index * 1_000_003
    config.durationSeconds = 300
    config.checkpointSeconds = [300]
    config.stopOnNativeDeclaration = false
    config.sensorNoise = 0
    config.windNoise = 0
    const engine = new SimulationEngine(config)
    engine.runToCompletion()
    const metric = engine.getFrame().checkpoints[300]!
    records.push({ algorithmId, index, config, metric })
    if ((metric.normalizedError ?? Number.POSITIVE_INFINITY) < best.error) {
      best = { seed: index, error: metric.normalizedError!, success: metric.success! }
    }
  }
  process.stdout.write(`${algorithmId}: ${JSON.stringify(best)}\n`)
}
const outputIndex = process.argv.indexOf('--output')
if (outputIndex >= 0) {
  const output = resolve(process.argv[outputIndex + 1]!)
  await mkdir(output, { recursive: true })
  await writeFile(resolve(output, 'development-control-search.json'), `${JSON.stringify({
    status: 'development-only endpoint search; selected cases must not enter the locked benchmark',
    testedSeedsPerAlgorithm: 24,
    durationSeconds: 300,
    sensorNoise: 0,
    windNoise: 0,
    records,
  }, null, 2)}\n`)
}
