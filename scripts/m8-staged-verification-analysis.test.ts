import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  analyzeM8StagedVerification,
  exactM8McNemarP,
} from './m8-staged-verification-analysis'

describe('M8 staged-policy verification analysis', () => {
  it('computes the two-sided exact McNemar probability', () => {
    expect(exactM8McNemarP(0, 0)).toBe(1)
    expect(exactM8McNemarP(3, 0)).toBe(0.25)
    expect(exactM8McNemarP(6, 0)).toBe(0.03125)
    expect(exactM8McNemarP(2, 2)).toBe(1)
  })

  it('re-verifies M8 and applies all frozen proceed criteria deterministically', async () => {
    const root = resolve(import.meta.dirname, '..')
    const archive = join(root, 'research', 'evidence', 'm8_staged_policy_verification_2026-09-04')
    const output = await mkdtemp(join(tmpdir(), 'plumenav-m8-analysis-'))
    try {
      const first = await analyzeM8StagedVerification(archive, output)
      const second = await analyzeM8StagedVerification(archive, output)
      expect(second.analysisSha256).toBe(first.analysisSha256)
      expect(second.reportSha256).toBe(first.reportSha256)
      expect(first.analysisSha256).toBe('93427fe9558fdb9ec8ec39956dcc7ceff569c62182627b748c6a81b6d725f036')
      expect(first.reportSha256).toBe('a46930dbcb6c3384bfd4eb9f6539875d53c7b7f452e50f3c119e6e991bfa91e7')
      expect(first.proceedToNominalValidation).toBe(false)
      expect(first.failedCriteria).toEqual([
        'C1-staged-candidate-reach',
        'C2-paired-improvement',
        'C3-obstructed-candidate-reach',
      ])

      const analysis = JSON.parse(await readFile(join(output, 'm8-staged-verification-analysis.json'), 'utf8'))
      expect(analysis.verification.verified).toBe(true)
      expect(analysis.criteria.map((criterion: { passed: boolean }) => criterion.passed))
        .toEqual([false, false, false, true, true])
      expect(analysis.pairedTrustedCandidates).toMatchObject({
        pairs: 64,
        both: 0,
        neither: 61,
        stagedOnly: 3,
        legacyOnly: 0,
        stagedOnlyMinusLegacyOnly: 3,
        exactMcNemarP: 0.25,
      })
      expect(analysis.formationDiagnostics['emitting|staged-active'].trustedCandidateWorlds).toBe(3)
      expect(analysis.formationDiagnostics['emitting|legacy-active'].trustedCandidateWorlds).toBe(0)
      expect(analysis.byScenario['emitting|staged-active|open']).toMatchObject({
        rowsWithAtLeastOneRay: 27,
        rowsWithAtLeastTwoRays: 15,
        rowsWithAtLeastThreeRays: 3,
        trustedCandidateWorlds: 3,
      })
      expect(analysis.byScenario['emitting|staged-active|obstructed']).toMatchObject({
        rowsWithAtLeastOneRay: 3,
        rowsWithAtLeastTwoRays: 0,
        rowsWithAtLeastThreeRays: 0,
        trustedCandidateWorlds: 0,
      })
      expect(analysis.trustedCandidateDetails).toHaveLength(3)
      expect(analysis.outcomes.absent['staged-active'].spuriousDeclarations).toBe(0)

      const report = await readFile(join(output, 'm8-staged-verification-report.md'), 'utf8')
      expect(report).toContain('HALT — nominal validation remains sealed')
      expect(report).toContain('| C2 paired improvement | 3-0; difference 3; p=0.2500 |')
      expect(report).toContain('without relaxing declaration safeguards')
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  }, 20_000)
})
