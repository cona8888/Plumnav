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
const cli = join(root, 'scripts', 'local-m6-calibration.ts')
const runCli = (arguments_: string[]) => execFileAsync(process.execPath, [viteNode, cli, ...arguments_], {
  cwd: root,
  env: process.env,
  maxBuffer: 10 * 1024 * 1024,
})
const absent = async (path: string) => {
  try { await stat(path); return false } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

describe('local M6 calibration CLI safety', () => {
  it('rejects unsupported worker counts before creating output', async () => {
    const output = join(tmpdir(), `plumenav-m6-workers-${randomUUID()}`)
    await expect(runCli(['--output', output, '--workers', '4', '--dry-run']))
      .rejects.toThrow(/workers must be 1 or 6/)
    expect(await absent(output)).toBe(true)
  })

  it('rejects an internal worker without coordinator authorization', async () => {
    const output = join(tmpdir(), `plumenav-m6-worker-${randomUUID()}`)
    await expect(runCli([
      '--output', output, '--workers', '1',
      '--internal-shard-index', '0', '--internal-shard-count', '1',
    ])).rejects.toThrow(/coordinator authorization/)
  })

  it('refuses to recover a live same-host lock', async () => {
    const output = join(tmpdir(), `plumenav-m6-lock-${randomUUID()}`)
    await mkdir(output)
    const lockPath = join(output, '.plumenav-m6-coordinator.lock')
    const lock = `${JSON.stringify({
      schemaVersion: 'plumenav-m6-lock-v1', token: randomUUID(), pid: process.pid,
      hostname: hostname(), startedAtUtc: new Date().toISOString(),
    }, null, 2)}\n`
    await writeFile(lockPath, lock, 'utf8')
    try {
      await expect(runCli(['--output', output, '--workers', '1', '--dry-run', '--recover-lock']))
        .rejects.toThrow(/still alive/)
      expect(await readFile(lockPath, 'utf8')).toBe(lock)
    } finally { await rm(output, { recursive: true, force: true }) }
  })

  it('validates the complete frozen design in dry-run mode', async () => {
    const output = join(tmpdir(), `plumenav-m6-dry-${randomUUID()}`)
    try {
      const result = await runCli(['--output', output, '--workers', '6', '--dry-run'])
      expect(result.stdout).toContain('"status": "dry-run"')
      expect(result.stdout).toContain('"plannedCells": 256')
      expect(result.stdout).toContain('"plannedSimulationRuns": 1024')
      const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
      expect(manifest.manifestSha256).toBe('922b85eadb23f00f8a132acacda1d4b0a8910a4164dc14af3f79a16686aa7681')
      expect(manifest.cells).toHaveLength(256)
    } finally { await rm(output, { recursive: true, force: true }) }
  })
})
