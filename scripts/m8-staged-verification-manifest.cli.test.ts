import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeM8Manifest } from './m8-staged-verification-manifest'

describe('M8 staged-policy manifest writer', () => {
  it.runIf(process.env.M8_STAGED_VERIFICATION_WRITE === '1')('writes the frozen M8 design', async () => {
    const result = await writeM8Manifest(resolve(
      process.env.M8_STAGED_VERIFICATION_OUTPUT_DIR ?? 'research/protocols/m8_staged_policy_verification',
    ))
    expect(result.manifest.cells).toHaveLength(128)
    expect(result.manifest.design.plannedSimulationRuns).toBe(512)
  })
})
