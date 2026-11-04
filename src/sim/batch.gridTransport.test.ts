import { describe, expect, it } from 'vitest'
import { batchResultsToCsv, runBatch, summarizeBatch } from './batch'
import { createDefaultConfig } from './config'
import { SimulationEngine } from './engine'
import { GridPlume } from './gridPlume'
import type { GridTransportVersion, SimulationConfig } from './types'

const gridConfig = (): SimulationConfig => ({
  ...createDefaultConfig('coverage', 'open'),
  physicsMode: 'grid',
  gridResolution: 32,
  physicsStepSeconds: 0.05,
  durationSeconds: 0.5,
  checkpointSeconds: [0.25, 0.5],
  sensorNoise: 0,
})

describe('versioned grid transport reporting', () => {
  it('uses conservative transport for new configurations and legacy transport when the version is absent', () => {
    const config = gridConfig()
    const current = new SimulationEngine(config)
    const historical = new SimulationEngine({ ...config, gridTransportVersion: undefined })
    expect(current.plume).toBeInstanceOf(GridPlume)
    expect((current.plume as GridPlume).transportVersion).toBe('conservative-upwind-v1')
    expect((historical.plume as GridPlume).transportVersion).toBe('legacy-semi-lagrangian-v1')
    expect(() => new SimulationEngine({ ...config,
      gridTransportVersion: 'unknown-solver' as GridTransportVersion })).toThrow(/gridTransportVersion/)
  })

  it('exports a balanced budget for each checkpoint rather than repeating the final budget', async () => {
    const { results } = await runBatch(gridConfig(), ['coverage'], ['open'], 1)
    expect(results).toHaveLength(2)
    const [first, last] = results
    expect(first!.gridMassBudget!.time).toBe(0.25)
    expect(last!.gridMassBudget!.time).toBe(0.5)
    expect(last!.gridMassBudget!.injectedMass).toBeGreaterThan(first!.gridMassBudget!.injectedMass)
    for (const result of results) {
      const b = result.gridMassBudget!
      const expected = b.initialMass + b.injectedMass - b.decayLossMass - b.boundaryOutflowMass -
        b.upperClippingLossMass + b.lowerClippingGainMass
      expect(Math.abs(b.currentMass - expected)).toBeLessThan(1e-12)
      expect(Math.abs(b.balanceResidual)).toBeLessThan(1e-12)
    }
    const [header, ...rows] = batchResultsToCsv(results).split('\n').map(line => line.split(','))
    for (const [index, row] of rows.entries()) {
      expect(row).toHaveLength(header!.length)
      expect(row[header!.indexOf('grid_transport_version')]).toBe('conservative-upwind-v1')
      expect(row[header!.indexOf('grid_transport_scope')]).toBe('prescribed-velocity-scalar-transport')
      expect(Number(row[header!.indexOf('grid_mass_budget_time_s')])).toBe(results[index]!.checkpointSeconds)
      expect(Number(row[header!.indexOf('grid_current_mass')])).toBe(results[index]!.gridMassBudget!.currentMass)
    }
  })

  it('marks historical output as nonconservative without inventing a mass budget', async () => {
    const { results } = await runBatch({ ...gridConfig(), gridTransportVersion: undefined }, ['coverage'], ['open'], 1)
    expect(results.every(result => result.gridMassBudget === null)).toBe(true)
    const [header, row] = batchResultsToCsv(results).split('\n').map(line => line.split(','))
    expect(row![header!.indexOf('grid_transport_version')]).toBe('legacy-semi-lagrangian-v1')
    expect(row![header!.indexOf('grid_transport_scope')]).toBe('qualitative-nonconservative')
    expect(row![header!.indexOf('grid_current_mass')]).toBe('')
  })

  it('keeps transport versions, resolutions and requested steps in separate summary groups', async () => {
    const { results } = await runBatch(gridConfig(), ['coverage'], ['open'], 1)
    const reference = results[0]!
    const groups = summarizeBatch([
      reference,
      { ...reference, config: { ...reference.config, gridTransportVersion: undefined } },
      { ...reference, config: { ...reference.config, gridResolution: 64 } },
      { ...reference, config: { ...reference.config, physicsStepSeconds: 0.025 } },
      { ...reference, config: { ...reference.config, physicsMode: 'filament' } },
    ])
    expect(groups).toHaveLength(5)
    expect(groups.every(group => group.runs === 1)).toBe(true)
    expect(groups[0]!.gridTransportVersion).toBe('conservative-upwind-v1')
    expect(groups[1]!.gridTransportVersion).toBe('legacy-semi-lagrangian-v1')
    expect(groups[4]!.gridTransportVersion).toBeNull()
  })

  it('rejects export of a grid budget from a different checkpoint', async () => {
    const { results } = await runBatch(gridConfig(), ['coverage'], ['open'], 1)
    const earlier = { ...results[0]!, gridMassBudget: results[1]!.gridMassBudget }
    expect(() => batchResultsToCsv([earlier])).toThrow(/budget time/)
  })
})
