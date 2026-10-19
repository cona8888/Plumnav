import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { batchResultsToCsv } from '../src/sim/batch'
import type { BatchResult } from '../src/sim/types'
import { runPhase2Pilot, loadAndValidatePhase2Manifest } from './phase2-pilot-runner'

describe('Phase 2 pilot runner', () => {
  it('validates the frozen manifest and supports a no-execution dry run', async () => {
    const result = await runPhase2Pilot({ outputDirectory: await mkdtemp(join(tmpdir(), 'phase2-pilot-')), dryRun: true })
    expect(result.dryRun).toBe(true)
    expect(result.plannedCells).toBe(80)
  })

  it('writes hashed cell artifacts and resumes only verified cells', async () => {
    const output = await mkdtemp(join(tmpdir(), 'phase2-pilot-'))
    const { manifest } = await loadAndValidatePhase2Manifest()
    let executions = 0
    const executeCell = async (cell: typeof manifest.cells[number]) => {
      executions += 1
      return [{
        algorithmId: cell.config.algorithmId,
        scenarioKind: cell.scenarioKind,
        seed: cell.config.seed,
        checkpointSeconds: 180,
        config: cell.config,
        observationModelVersion: cell.observationModelVersion,
        observationModelSeed: cell.config.observationModelSeed,
        metrics: { targetStatus: 'emitting' },
      } as unknown as BatchResult]
    }
    const first = await runPhase2Pilot({ outputDirectory: output, executeCell })
    expect(first.completedCells).toBe(80)
    expect(executions).toBe(80)
    const second = await runPhase2Pilot({ outputDirectory: output, executeCell })
    expect(second.skippedCells).toBe(80)
    expect(executions).toBe(80)
    const raw = await readFile(join(output, 'raw-results.csv'), 'utf8')
    expect(raw).toContain(batchResultsToCsv([]).split(',')[0])
    const rows = raw.trimEnd().split('\n')
    expect(rows[0]).toContain('scenario_id,cell_id,orientation_bin,replicate,method_arm')
    expect(rows[1]?.split(',')[2]).toBe(manifest.cells[0]?.pairingKey)
    const metadata = JSON.parse(await readFile(join(output, 'metadata.json'), 'utf8')) as {
      rawResultRows: number
      rawResultsSha256: string
      implementationSha256: string
    }
    const checksums = JSON.parse(await readFile(join(output, 'checksums.json'), 'utf8')) as {
      rawResultsSha256: string
      manifestFileSha256: string
      metadataFileSha256: string
    }
    expect(metadata.rawResultRows).toBe(80)
    expect(metadata.implementationSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(metadata.rawResultsSha256).toBe(createHash('sha256').update(raw).digest('hex'))
    expect(checksums.rawResultsSha256).toBe(metadata.rawResultsSha256)
    expect(checksums.manifestFileSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(checksums.metadataFileSha256).toMatch(/^[a-f0-9]{64}$/)

    const firstCell = manifest.cells[0]!
    const firstCsvPath = join(output, 'cells', `${firstCell.id}.csv`)
    const firstMetadataPath = join(output, 'cells', `${firstCell.id}.json`)
    const firstCsv = await readFile(firstCsvPath, 'utf8')
    const firstCsvRows = firstCsv.trimEnd().split('\n')
    const duplicatedCsv = `${firstCsv.trimEnd()}\n${firstCsvRows[1]}\n`
    const firstMetadata = JSON.parse(await readFile(firstMetadataPath, 'utf8')) as {
      csvSha256: string
      rawRows: number
    }
    firstMetadata.csvSha256 = createHash('sha256').update(duplicatedCsv).digest('hex')
    firstMetadata.rawRows = firstCell.config.checkpointSeconds.length
    await writeFile(firstCsvPath, duplicatedCsv, 'utf8')
    await writeFile(firstMetadataPath, `${JSON.stringify(firstMetadata, null, 2)}\n`, 'utf8')
    const repaired = await runPhase2Pilot({ outputDirectory: output, executeCell })
    expect(repaired.completedCells).toBe(1)
    expect(repaired.skippedCells).toBe(79)
    expect(executions).toBe(81)
    await rm(output, { recursive: true, force: true })
  })

  it('rejects a non-emitting result in the source-present pilot', async () => {
    const output = await mkdtemp(join(tmpdir(), 'phase2-pilot-'))
    await expect(runPhase2Pilot({
      outputDirectory: output,
      executeCell: async (cell) => [{
        algorithmId: cell.config.algorithmId,
        scenarioKind: cell.scenarioKind,
        seed: cell.config.seed,
        checkpointSeconds: 180,
        config: { ...cell.config, targetStatus: 'zero-emission' },
        observationModelVersion: cell.observationModelVersion,
        observationModelSeed: cell.config.observationModelSeed,
        metrics: {},
      } as unknown as BatchResult],
    })).rejects.toThrow('result identity does not match')
    await rm(output, { recursive: true, force: true })
  })
})
