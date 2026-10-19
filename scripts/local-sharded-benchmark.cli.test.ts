import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const viteNode = join(root, 'node_modules', 'vite-node', 'vite-node.mjs')
const cli = join(root, 'scripts', 'local-sharded-benchmark.ts')

const runCli = (args: string[]) => execFileAsync(process.execPath, [viteNode, cli, ...args], {
  cwd: root,
  env: process.env,
  maxBuffer: 10 * 1024 * 1024,
})

const absent = async (path: string) => {
  try {
    await stat(path)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

describe('local sharded benchmark CLI safety', () => {
  it('rejects an impossible worker count before creating output', async () => {
    const output = join(tmpdir(), `plumenav-local-cap-${randomUUID()}`)
    await expect(runCli([
      '--profile', 'commissioning',
      '--output', output,
      '--workers', '999',
      '--dry-run',
    ])).rejects.toThrow(/permits at most/)
    expect(await absent(output)).toBe(true)
  })

  it('does not allow a hidden shard to run without coordinator authorization', async () => {
    const output = join(tmpdir(), `plumenav-local-worker-${randomUUID()}`)
    await expect(runCli([
      '--profile', 'commissioning',
      '--output', output,
      '--internal-shard-index', '0',
      '--internal-shard-count', '1',
    ])).rejects.toThrow(/coordinator authorization/)
  })

  it('refuses to recover a live same-host lock', async () => {
    const output = join(tmpdir(), `plumenav-local-lock-${randomUUID()}`)
    await mkdir(output)
    const lockPath = join(output, '.plumenav-coordinator.lock')
    const lock = `${JSON.stringify({
      schemaVersion: 'plumenav-coordinator-lock-v2',
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      startedAtUtc: new Date().toISOString(),
    }, null, 2)}\n`
    await writeFile(lockPath, lock, 'utf8')
    try {
      await expect(runCli([
        '--profile', 'commissioning',
        '--output', output,
        '--workers', '1',
        '--dry-run',
        '--recover-lock',
      ])).rejects.toThrow(/still alive/)
      expect(await readFile(lockPath, 'utf8')).toBe(lock)
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  })
})

const integrationEnabled = process.env.LOCAL_SHARD_INTEGRATION === '1'

describe('real local sharding equivalence', () => {
  it.runIf(integrationEnabled)(
    'matches one versus four workers and recomputes exactly one tampered cell',
    async () => {
      const first = join(tmpdir(), `plumenav-local-integration-w1-${randomUUID()}`)
      const parallel = join(tmpdir(), `plumenav-local-integration-w4-${randomUUID()}`)
      try {
        await runCli([
          '--profile', 'commissioning', '--output', first, '--workers', '1',
        ])
        await runCli([
          '--profile', 'commissioning', '--output', parallel, '--workers', '4',
        ])
        const firstMetadata = JSON.parse(await readFile(join(first, 'metadata.json'), 'utf8'))
        const parallelMetadata = JSON.parse(await readFile(join(parallel, 'metadata.json'), 'utf8'))
        expect(parallelMetadata.manifestSha256).toBe(firstMetadata.manifestSha256)
        expect(parallelMetadata.scientificResultsSha256)
          .toBe(firstMetadata.scientificResultsSha256)
        expect(await readFile(join(parallel, 'analysis.json'), 'utf8'))
          .toBe(await readFile(join(first, 'analysis.json'), 'utf8'))
        expect(await readFile(join(parallel, 'comparisons.csv'), 'utf8'))
          .toBe(await readFile(join(first, 'comparisons.csv'), 'utf8'))

        const manifest = JSON.parse(await readFile(join(parallel, 'manifest.json'), 'utf8'))
        const cellId = manifest.cells[0].id as string
        const csvPath = join(parallel, 'cells', `${cellId}.csv`)
        const lines = (await readFile(csvPath, 'utf8')).trimEnd().split('\n')
        const header = lines[0]!.split(',')
        const timingIndex = header.indexOf('mean_compute_ms')
        const values = lines[1]!.split(',')
        values[timingIndex] = String(Number(values[timingIndex]) + 1)
        lines[1] = values.join(',')
        await writeFile(csvPath, `${lines.join('\n')}\n`, 'utf8')

        const resumed = await runCli([
          '--profile', 'commissioning', '--output', parallel, '--workers', '4', '--resume',
        ])
        expect(resumed.stdout).toContain('"completedCells": 1')
        expect(resumed.stdout).toContain('"skippedCells": 23')
        const repairedMetadata = JSON.parse(await readFile(join(parallel, 'metadata.json'), 'utf8'))
        expect(repairedMetadata.scientificResultsSha256)
          .toBe(firstMetadata.scientificResultsSha256)
      } finally {
        await rm(first, { recursive: true, force: true })
        await rm(parallel, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
