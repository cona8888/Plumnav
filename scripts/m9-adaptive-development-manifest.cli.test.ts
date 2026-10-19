import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeM9Manifest } from './m9-adaptive-development-manifest'

describe('M9 adaptive-viewpoint manifest writer', () => {
  it.runIf(process.env.M9_ADAPTIVE_DEVELOPMENT_WRITE === '1')('writes the frozen M9 design', async () => {
    const result = await writeM9Manifest(resolve(
      process.env.M9_ADAPTIVE_DEVELOPMENT_OUTPUT_DIR ??
        'research/protocols/m9_adaptive_viewpoint_development',
    ))
    expect(result.manifest.cells).toHaveLength(64)
    expect(result.manifest.design.plannedSimulationRuns).toBe(256)
  })
})
