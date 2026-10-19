import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeM7Manifest } from './m7-precandidate-manifest'

describe('M7 pre-candidate manifest writer', () => {
  it.runIf(process.env.M7_PRE_CANDIDATE_WRITE === '1')('writes the frozen M7 design', async () => {
    const result = await writeM7Manifest(resolve(
      process.env.M7_PRE_CANDIDATE_OUTPUT_DIR ?? 'research/protocols/m7_precandidate_diagnostic',
    ))
    expect(result.manifest.cells).toHaveLength(64)
    expect(result.manifest.design.plannedSimulationRuns).toBe(192)
  })
})
