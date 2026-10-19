import { describe, expect, it } from 'vitest'
import { createConvergenceRobustnessManifest } from './convergence-robustness-manifest'
import { GridPlume } from '../src/sim/gridPlume'
import { createScenario } from '../src/sim/scenarios'

describe('convergence and robustness manifest', () => {
  it('is deterministic, development-only, and preserves paired layouts across levels', () => {
    const manifest = createConvergenceRobustnessManifest()
    expect(createConvergenceRobustnessManifest()).toEqual(manifest)
    expect(manifest.partition).toBe('development')
    expect(manifest.layoutsPerVariant).toBe(16)
    expect([...new Set(manifest.cells.filter((cell) => cell.study === 'grid-resolution').map((cell) => cell.value))]).toEqual([48, 96, 128, 192])
    expect([...new Set(manifest.cells.filter((cell) => cell.study === 'time-step').map((cell) => cell.value))]).toEqual([0.05, 0.025, 0.0125])
    expect(new Set(manifest.cells.filter((cell) => cell.study === 'time-step').map((cell) => cell.config.fixedDt))).toEqual(new Set([0.25]))
    expect(new Set(manifest.cells.filter((cell) => cell.study === 'time-step').map((cell) => cell.config.physicsStepSeconds))).toEqual(new Set([0.05, 0.025, 0.0125]))
    for (const cell of manifest.cells.filter((candidate) => candidate.study === 'time-step' || candidate.study === 'grid-resolution')) {
      const plume = new GridPlume(createScenario(cell.scenarioKind, cell.config.seed, cell.config), cell.config.seed, {
        resolution: cell.config.gridResolution,
        stepSeconds: cell.config.physicsStepSeconds,
      })
      expect(plume.stepSeconds).toBe(cell.study === 'time-step' ? cell.value : 0.0125)
    }
    const gridKeys = manifest.cells.filter((cell) => cell.sweepId === 'grid-resolution').map((cell) => cell.pairingKey)
    expect(new Set(gridKeys).size).toBe(16)
    expect(manifest.executableSweeps.map((sweep) => sweep.id)).toContain('channel-correlation')
    expect(manifest.executableSweeps.map((sweep) => sweep.id)).toContain('channel-crosstalk')
    expect(manifest.placeholderSweeps.map((sweep) => sweep.id)).not.toContain('channel-correlation')
  })
})
