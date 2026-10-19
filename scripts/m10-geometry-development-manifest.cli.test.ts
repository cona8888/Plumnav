import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeM10Manifest } from './m10-geometry-development-manifest'

describe('M10 geometry-conditioned manifest writer', () => {
  it.runIf(process.env.M10_GEOMETRY_DEVELOPMENT_WRITE === '1')('writes the frozen M10 design', async () => {
    const result = await writeM10Manifest(resolve(
      process.env.M10_GEOMETRY_DEVELOPMENT_OUTPUT_DIR ??
        'research/protocols/m10_geometry_conditioned_development',
    ))
    expect(result.manifest.cells).toHaveLength(64)
    expect(result.manifest.design.plannedSimulationRuns).toBe(256)
  })
})

