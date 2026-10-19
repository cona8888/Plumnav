import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeM5DevelopmentManifest } from './m5-development-manifest'

const enabled = process.env.M5_DEVELOPMENT_WRITE === '1'

describe.skipIf(!enabled)('M5 development manifest writer', () => {
  it('writes the frozen development-only design', async () => {
    const outputDirectory = resolve(
      process.env.M5_DEVELOPMENT_OUTPUT_DIR ??
        'research/protocols/m5_development_screen',
    )
    const result = await writeM5DevelopmentManifest(outputDirectory)
    expect(result.manifest.cells).toHaveLength(128)
    expect(result.outputPath).toMatch(/m5-development-screen-manifest\.json$/)
  })
})
