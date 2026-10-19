import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { idealReadings, surfaceDiagnostic } from './m11-confirmation-diagnostic'
import { createDefaultConfig } from '../src/sim/config'
import { SimulationEngine } from '../src/sim/engine'
import { QuadSoilSniffController, evaluateQuadDeclarationEvidence } from '../src/sim/algorithms/quadSoilSniff'
import type { AlgorithmStepInput } from '../src/sim/types'

const probe = (value: number, saturated = false) => {
  const engine = new SimulationEngine(createDefaultConfig('quad-sniff', 'open'))
  const shadow = new QuadSoilSniffController('active-suction', 'geometry-conditioned')
  shadow.reset(engine.environment)
  const input: AlgorithmStepInput = {
    time: 1, dt: 0.25, position: { x: 0.5, y: 0.5 }, heading: 0, distance: 0, observations: [],
    measurement: { time: 1, concentration: value, hit: value >= 0.1, valid: true,
      wind: { x: 0.05, y: 0 }, sampleMode: 'quad-return',
      quadSniff: { scanId: 1, phase: 'return', forward: { x: 1, y: 0 }, strength: 0.78,
        samplingMode: 'active-suction', progress: 1, channels: [], readings: idealReadings(value, saturated) } },
  }
  return surfaceDiagnostic(shadow, input, 0.025)
}

describe('M11 evaluation-only confirmation diagnostics', () => {
  it('verifies the completed diagnostic artifacts and exact replay acceptance', async () => {
    const directory = resolve(import.meta.dirname, '../research/evidence/m11_confirmation_diagnostic_2026-09-05')
    const checksums = JSON.parse(await readFile(join(directory, 'checksums.json'), 'utf8'))
    expect(checksums.complete).toBe(true)
    expect(checksums.inventory).toHaveLength(14)
    for (const entry of checksums.inventory) {
      const bytes = await readFile(join(directory, entry.path))
      expect(bytes.length).toBe(entry.bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
    }
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'))
    expect(summary.stationary).toHaveLength(8)
    expect(summary.traces).toHaveLength(2)
    expect(summary.stationary.filter((r: { armId: string }) => r.armId === 'geometry-active')
      .every((r: { accepted: number; saturated: number }) => r.accepted === 0 && r.saturated === 0)).toBe(true)
    expect(summary.traces.every((r: { matchedScientificColumns: number; failedConfirmations: number }) =>
      r.matchedScientificColumns === 178 && r.failedConfirmations === 0)).toBe(true)
  })

  it('uses the actual frozen surface acceptance path for ideal uniform channels', () => {
    expect(probe(0.8).surfaceAccepted).toBe(true)
    expect(probe(0.8).surfaceScore).toBeCloseTo(0.78, 12)
    expect(probe(0.1).surfaceAccepted).toBe(false)
    expect(probe(1.5, true).surfaceAccepted).toBe(false)
  })

  it('distinguishes attainable full declaration from missing surface support', () => {
    const input = { ray: { quality: 1, residual: 0 }, stability: { count: 4, span: 4, radius: 0 },
      surface: { count: 2, meanScore: 0.78 }, passive: { coreCount: 6, coreHits: 6, ringCount: 5, coreMean: 0.8, contrast: 0.5 },
      secondsSincePassiveHit: 0, distanceToCandidate: 0 }
    expect(evaluateQuadDeclarationEvidence(input).ready).toBe(true)
    expect(evaluateQuadDeclarationEvidence({ ...input, surface: { count: 0, meanScore: 0 } }).ready).toBe(false)
  })
})
