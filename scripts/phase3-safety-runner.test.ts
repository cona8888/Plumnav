import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BatchResult } from '../src/sim/types'
import { loadAndValidatePhase3Manifest, runPhase3Safety } from './phase3-safety-runner'

describe('Phase 3 safety runner', () => {
  it('dry-runs the exact canonical safety design without outcomes', async () => {
    const output = await mkdtemp(join(tmpdir(), 'phase3-safety-'))
    const result = await runPhase3Safety({ outputDirectory: output, dryRun: true })
    expect(result.plannedCells).toBe(256)
    expect(result.completedCells).toBe(0)
    await rm(output, { recursive: true, force: true })
  })

  it('hashes and resumes raw condition-separated artifacts', async () => {
    const output = await mkdtemp(join(tmpdir(), 'phase3-safety-'))
    const { manifest } = await loadAndValidatePhase3Manifest()
    let calls = 0
    const executeCell = async (cell: typeof manifest.cells[number]) => {
      calls += 1
      return [{
        algorithmId: cell.algorithmId,
        scenarioKind: cell.scenarioKind,
        seed: cell.config.seed,
        checkpointSeconds: 180,
        config: cell.config,
        observationModelVersion: cell.observationModelVersion,
        observationModelSeed: cell.config.observationModelSeed,
        metrics: {
          targetStatus: cell.condition,
          terminalOutcome: cell.condition === 'absent'
            ? 'correct-rejection-at-deadline'
            : 'deadline-nondeclaration-present',
          normalizedError: cell.condition === 'absent' ? null : 0.3,
          normalizedPathOverhead: cell.condition === 'absent' ? null : 1.2,
          spuriousDeclaration: false,
          correctRejection: cell.condition === 'absent' ? true : null,
          correctAbstention: false,
        },
      } as unknown as BatchResult]
    }
    const first = await runPhase3Safety({ outputDirectory: output, executeCell })
    expect(first.completedCells).toBe(256); expect(calls).toBe(256)
    const second = await runPhase3Safety({ outputDirectory: output, executeCell })
    expect(second.skippedCells).toBe(256); expect(calls).toBe(256)
    const raw = await readFile(join(output, 'raw-results.csv'), 'utf8')
    const firstColumns = raw.trimEnd().split('\n')[1]?.split(',')
    expect(firstColumns?.[2]).toBe(manifest.cells[0]?.analysisPairingKey)
    expect(firstColumns?.[4]).toBe(manifest.cells[0]?.counterfactualPairingKey)
    const checksums = JSON.parse(await readFile(join(output, 'checksums.json'), 'utf8')) as {
      manifestFileSha256: string
      metadataFileSha256: string
      rawResultsSha256: string
    }
    expect(checksums.rawResultsSha256).toBe(createHash('sha256').update(raw).digest('hex'))
    expect(checksums.manifestFileSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(checksums.metadataFileSha256).toMatch(/^[a-f0-9]{64}$/)

    const firstCell = manifest.cells[0]!
    const csvPath = join(output, 'cells', `${firstCell.id}.csv`)
    const metadataPath = join(output, 'cells', `${firstCell.id}.json`)
    const csv = await readFile(csvPath, 'utf8')
    const csvRows = csv.trimEnd().split('\n')
    const duplicatedCsv = `${csv.trimEnd()}\n${csvRows[1]}\n`
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      csvSha256: string
      rawRows: number
    }
    metadata.csvSha256 = createHash('sha256').update(duplicatedCsv).digest('hex')
    metadata.rawRows = firstCell.config.checkpointSeconds.length
    await writeFile(csvPath, duplicatedCsv, 'utf8')
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    const repaired = await runPhase3Safety({ outputDirectory: output, executeCell })
    expect(repaired.completedCells).toBe(1)
    expect(repaired.skippedCells).toBe(255)
    expect(calls).toBe(257)

    expect(firstCell.condition).toBe('absent')
    const repairedCsv = await readFile(csvPath, 'utf8')
    const repairedLines = repairedCsv.trimEnd().split('\n')
    const header = repairedLines[0]!.split(',')
    const persistedRow = repairedLines[1]!.split(',')
    persistedRow[header.indexOf('source_x_normalized')] = '0.5'
    const semanticallyTamperedCsv = `${header.join(',')}\n${persistedRow.join(',')}\n`
    const repairedMetadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      csvSha256: string
    }
    repairedMetadata.csvSha256 = createHash('sha256').update(semanticallyTamperedCsv).digest('hex')
    await writeFile(csvPath, semanticallyTamperedCsv, 'utf8')
    await writeFile(metadataPath, `${JSON.stringify(repairedMetadata, null, 2)}\n`, 'utf8')
    const semanticsRepaired = await runPhase3Safety({ outputDirectory: output, executeCell })
    expect(semanticsRepaired.completedCells).toBe(1)
    expect(semanticsRepaired.skippedCells).toBe(255)
    expect(calls).toBe(258)
    await rm(output, { recursive: true, force: true })
  })

  it('rejects a result whose truth condition differs from its manifest cell', async () => {
    const output = await mkdtemp(join(tmpdir(), 'phase3-safety-'))
    await expect(runPhase3Safety({
      outputDirectory: output,
      executeCell: async (cell) => [{
        algorithmId: cell.algorithmId,
        scenarioKind: cell.scenarioKind,
        seed: cell.config.seed,
        checkpointSeconds: 180,
        config: { ...cell.config, targetStatus: cell.condition === 'absent' ? 'zero-emission' : 'absent' },
        observationModelVersion: cell.observationModelVersion,
        observationModelSeed: cell.config.observationModelSeed,
        metrics: { targetStatus: cell.condition === 'absent' ? 'zero-emission' : 'absent' },
      } as unknown as BatchResult],
    })).rejects.toThrow('result identity does not match')
    await rm(output, { recursive: true, force: true })
  })
})
