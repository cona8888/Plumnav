import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  analyzeM9AdaptiveDevelopment,
  exactM9McNemarP,
} from './m9-adaptive-development-analysis'

describe('M9 adaptive-viewpoint development analysis', () => {
  it('computes the two-sided exact McNemar probability', () => {
    expect(exactM9McNemarP(0, 0)).toBe(1)
    expect(exactM9McNemarP(3, 0)).toBe(0.25)
    expect(exactM9McNemarP(6, 0)).toBe(0.03125)
    expect(exactM9McNemarP(2, 2)).toBe(1)
  })

  it('re-verifies M9 and applies all frozen proceed criteria deterministically', async () => {
    const root = resolve(import.meta.dirname, '..')
    const archive = join(root, 'research', 'evidence', 'm9_adaptive_viewpoint_development_2026-09-04')
    const output = await mkdtemp(join(tmpdir(), 'plumenav-m9-analysis-'))
    try {
      const first = await analyzeM9AdaptiveDevelopment(archive, output)
      const second = await analyzeM9AdaptiveDevelopment(archive, output)
      expect(second.analysisSha256).toBe(first.analysisSha256)
      expect(second.reportSha256).toBe(first.reportSha256)
      expect(first.analysisSha256).toBe('22521f48ecb45743313223a35fce70a264391e21441d589b30dc1a81435d4660')
      expect(first.reportSha256).toBe('59c542f3963d83431cfcda343602c083e825e186b8f7c191cfac3c34c1f1cbdd')
      expect(first.proceedToNominalValidation).toBe(false)
      expect(first.failedCriteria).toEqual([
        'C1-adaptive-candidate-reach',
        'C2-paired-improvement',
        'C3-obstructed-candidate-reach',
        'C4-passive-confirmation-progression',
        'C5-correct-native-declaration',
      ])

      const analysis = JSON.parse(await readFile(join(output, 'm9-adaptive-development-analysis.json'), 'utf8'))
      expect(analysis.verification.verified).toBe(true)
      expect(analysis.criteria.map((criterion: { passed: boolean }) => criterion.passed))
        .toEqual([false, false, false, false, false, true, true])
      expect(analysis.pairedTrustedCandidates).toMatchObject({
        pairs: 32,
        both: 1,
        neither: 27,
        adaptiveOnly: 2,
        stagedOnly: 2,
        adaptiveOnlyMinusStagedOnly: 0,
        exactMcNemarP: 1,
      })
      expect(analysis.formationDiagnostics['emitting|adaptive-active']).toMatchObject({
        rowsWithAtLeastOneRay: 17,
        rowsWithAtLeastTwoRays: 14,
        rowsWithAtLeastThreeRays: 8,
        trustedCandidateWorlds: 3,
      })
      expect(analysis.formationDiagnostics['emitting|staged-active']).toMatchObject({
        rowsWithAtLeastOneRay: 17,
        rowsWithAtLeastTwoRays: 9,
        rowsWithAtLeastThreeRays: 3,
        trustedCandidateWorlds: 3,
      })
      expect(analysis.byScenario['emitting|adaptive-active|obstructed'].trustedCandidateWorlds).toBe(1)
      expect(analysis.declarationDiagnostics['emitting|adaptive-active'].gates).toMatchObject({
        'passive-core-count': { rowsWithAnyPass: 3 },
        'passive-ring-count': { rowsWithAnyPass: 3 },
        'surface-count': { rowsWithAnyPass: 0 },
        'passive-core-mean': { rowsWithAnyPass: 0 },
        'aggregate-score': { rowsWithAnyPass: 0 },
      })
      expect(analysis.outcomes.emitting['adaptive-active']).toMatchObject({
        correctDeclarations: 0,
        wrongDeclarations: 0,
      })
      expect(analysis.outcomes.absent['adaptive-active'].spuriousDeclarations).toBe(0)

      const report = await readFile(join(output, 'm9-adaptive-development-report.md'), 'utf8')
      expect(report).toContain('HALT — nominal validation remains sealed')
      expect(report).toContain('| C2 paired improvement | 2-2; difference 0; p=1.0000 |')
      expect(report).toContain('| C6 absent safety | 0/32 spurious | 0/32 | PASS |')
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  }, 20_000)
})
