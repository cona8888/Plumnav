import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeM6CalibrationManifest } from './m6-calibration-manifest'

const enabled = process.env.M6_CALIBRATION_WRITE === '1'

describe.skipIf(!enabled)('M6 calibration manifest writer', () => {
  it('writes the frozen development-only calibration design', async () => {
    const outputDirectory = resolve(
      process.env.M6_CALIBRATION_OUTPUT_DIR ??
        'research/protocols/m6_quad_calibration',
    )
    const result = await writeM6CalibrationManifest(outputDirectory)
    expect(result.manifest.cells).toHaveLength(256)
    expect(result.manifest.design.plannedSimulationRuns).toBe(1024)
    expect(result.outputPath).toMatch(/m6-calibration-manifest\.json$/)
  })
})
