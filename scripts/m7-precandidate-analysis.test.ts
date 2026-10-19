import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeM7Precandidate } from './m7-precandidate-analysis'

describe('M7 pre-candidate analysis', () => {
  it('re-verifies the archive and emits deterministic gate diagnostics', async () => {
    const root = resolve(import.meta.dirname, '..')
    const archive = join(root, 'research', 'evidence', 'm7_precandidate_diagnostic_2026-09-03')
    const output = await mkdtemp(join(tmpdir(), 'plumenav-m7-analysis-'))
    try {
      const first = await analyzeM7Precandidate(archive, output)
      const second = await analyzeM7Precandidate(archive, output)
      expect(second.analysisSha256).toBe(first.analysisSha256)
      expect(second.reportSha256).toBe(first.reportSha256)
      expect(first.analysisSha256).toBe('a22a01f8a56cea4b0886466b21eb427a531483f1c2e40de19fb37d9833d48696')
      const analysis = JSON.parse(await readFile(join(output, 'm7-precandidate-analysis.json'), 'utf8'))
      expect(analysis.verification.verified).toBe(true)
      const active = analysis.formationDiagnostics['emitting|quad-active']
      const passive = analysis.formationDiagnostics['emitting|quad-passive']
      expect(active.evaluations).toBe(423)
      expect(active.provisionalEvaluations).toBe(7)
      expect(active.rowsWithAtLeastThreeRays).toBe(1)
      expect(active.gates['ray-quality'].passes).toBe(7)
      expect(active.gates['ray-residual'].passes).toBe(7)
      expect(active.gates['ray-count'].passes).toBe(0)
      expect(active.gates['surface-support'].passes).toBe(0)
      expect(passive.rowsWithAtLeastTwoRays).toBe(6)
      expect(passive.rowsWithAtLeastThreeRays).toBe(0)
      expect(analysis.formationDiagnostics['absent|quad-active'].rowsWithAtLeastOneRay).toBe(0)
      expect(analysis.byScenario['emitting|quad-active|obstructed'].rowsWithAtLeastOneRay).toBe(0)
      const report = await readFile(join(output, 'm7-precandidate-report.md'), 'utf8')
      expect(report).toContain('only the frozen four-ray and candidate-local surface-support gates')
      expect(report).toContain('staged crosswind-triangulation candidate policy')
      expect(report).toContain('Development-only diagnostic evidence')
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  }, 20_000)
})
