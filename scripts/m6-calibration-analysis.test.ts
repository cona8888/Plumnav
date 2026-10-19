import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeM6Calibration } from './m6-calibration-analysis'

describe('M6 calibration analysis', () => {
  it('re-verifies the frozen archive and emits deterministic diagnostic outputs', async () => {
    const root = resolve(import.meta.dirname, '..')
    const archive = join(root, 'research', 'evidence', 'm6_quad_calibration_2026-09-03')
    const output = await mkdtemp(join(tmpdir(), 'plumenav-m6-analysis-'))
    try {
      const first = await analyzeM6Calibration(archive, output)
      const second = await analyzeM6Calibration(archive, output)
      expect(second.analysisSha256).toBe(first.analysisSha256)
      expect(second.reportSha256).toBe(first.reportSha256)
      expect(first.analysisSha256).toBe('7f711a82ce5747b30d10063764ba072d6dc3fce751fe616f2b9b80de6f2f001c')
      const analysis = JSON.parse(await readFile(join(output, 'm6-calibration-analysis.json'), 'utf8'))
      expect(analysis.verification.verified).toBe(true)
      expect(analysis.outcomes.emitting['quad-active'].proximitySuccesses).toBe(22)
      expect(analysis.outcomes.emitting['quad-passive'].proximitySuccesses).toBe(21)
      expect(analysis.outcomes.emitting['quad-zero-strength-sham'].proximitySuccesses).toBe(5)
      expect(analysis.outcomes.emitting.infotaxis.correctDeclarations).toBe(26)
      expect(analysis.outcomes.emitting.infotaxis.wrongDeclarations).toBe(69)
      expect(analysis.quadGateDiagnostics['emitting|quad-active'].candidateEvaluations).toBe(0)
      expect(analysis.pairedDiagnostics.emittingProximityActiveVsPassive.exactMcNemarP).toBe(1)
      const report = await readFile(join(output, 'm6-calibration-report.md'), 'utf8')
      expect(report).toContain('No trusted candidate was formed in any Quad run')
      expect(report).toContain('export provisional-ray count')
      expect(report).toContain('Development-only calibration evidence')
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  }, 20_000)
})
