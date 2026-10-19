import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runPhase2Pilot } from './phase2-pilot-runner'

const enabled = process.env.PHASE2_PILOT_RUN === '1'
const dryRun = process.env.PHASE2_PILOT_DRY_RUN !== '0'
const outputDirectory = resolve(
  process.env.PHASE2_PILOT_RUN_OUTPUT_DIR ?? 'benchmark-output/phase2-development-pilot',
)
const manifestPath = resolve(
  process.env.PHASE2_PILOT_MANIFEST_PATH ??
    'research/protocols/phase2_development_pilot/phase2-pilot-manifest.json',
)

describe('Phase 2 development pilot execution', () => {
  it.runIf(enabled)('validates and optionally executes the frozen manifest', async () => {
    const result = await runPhase2Pilot({ outputDirectory, manifestPath, dryRun })
    expect(result.plannedCells).toBe(80)
    expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.dryRun).toBe(dryRun)
  })
})
