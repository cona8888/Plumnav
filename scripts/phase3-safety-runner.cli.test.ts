import { describe, expect, it } from 'vitest'
import { runPhase3Safety } from './phase3-safety-runner'

const enabled = process.env.PHASE3_SAFETY_RUN === '1'
const dryRun = process.env.PHASE3_SAFETY_DRY_RUN !== '0'

describe('Phase 3 safety execution harness', () => {
  it.runIf(enabled)('validates and optionally executes the frozen safety manifest', async () => {
    const result = await runPhase3Safety({ outputDirectory: process.env.PHASE3_SAFETY_OUTPUT_DIR ?? 'benchmark-output/phase3-source-absent-safety', manifestPath: process.env.PHASE3_SAFETY_MANIFEST_PATH ?? 'research/protocols/phase3_source_absent_safety/phase3-source-absent-safety-manifest.json', dryRun })
    expect(result.plannedCells).toBe(256)
    expect(result.dryRun).toBe(dryRun)
  })
})
