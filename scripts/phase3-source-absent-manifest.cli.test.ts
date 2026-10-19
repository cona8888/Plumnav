import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writePhase3SafetyManifest } from './phase3-source-absent-manifest'

const enabled = process.env.PHASE3_SAFETY_WRITE === '1'
const outputDirectory = resolve(
  process.env.PHASE3_SAFETY_OUTPUT_DIR ??
    'research/protocols/phase3_source_absent_safety',
)

describe('Phase 3 source-absent safety manifest writer', () => {
  it.runIf(enabled)('writes only when explicitly enabled', async () => {
    const written = await writePhase3SafetyManifest(outputDirectory)
    expect(written.manifest.cells).toHaveLength(256)
    expect(written.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
  })
})
