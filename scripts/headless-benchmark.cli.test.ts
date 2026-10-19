import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { runHeadlessBenchmark } from './headless-benchmark'

const requestedProfile = process.env.BENCHMARK_PROFILE
const profile = requestedProfile === 'full' || requestedProfile === 'pilot' || requestedProfile === 'ci'
  ? requestedProfile
  : 'commissioning'
const dryRun = process.env.BENCHMARK_DRY_RUN !== '0'
const outputDirectory = resolve(process.env.BENCHMARK_OUTPUT_DIR ?? `benchmark-output/${profile}`)
const enabled = process.env.BENCHMARK_RUN === '1'

describe('headless benchmark runner', () => {
  it.runIf(enabled)('creates a deterministic manifest and runs only when explicitly enabled', async () => {
    const result = await runHeadlessBenchmark({ profile, outputDirectory, dryRun })
    expect(result.manifest.cells.length).toBeGreaterThan(0)
    expect(result.plannedSimulationRuns).toBeGreaterThan(0)
  }, 1_200_000)
})
