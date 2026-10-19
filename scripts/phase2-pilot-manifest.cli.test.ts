import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writePhase2PilotManifest } from './phase2-pilot-manifest'

const enabled = process.env.PHASE2_PILOT_WRITE === '1'
const outputDirectory = resolve(
  process.env.PHASE2_PILOT_OUTPUT_DIR ??
    'research/protocols/phase2_development_pilot',
)

describe('Phase 2 development pilot manifest writer', () => {
  it.runIf(enabled)('writes only when explicitly enabled', async () => {
    const written = await writePhase2PilotManifest(outputDirectory)
    expect(written.manifest.cells).toHaveLength(80)
    expect(written.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
  })
})
