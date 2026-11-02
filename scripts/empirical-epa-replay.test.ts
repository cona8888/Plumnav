import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('rejects plausible replacement observations carrying the official workbook digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plumnav-replay-'))
  const rows = Array.from({ length: 12 }, (_, i) => {
    const row = i + 3
    const cells = ['ABC', 'EFG', 'IJK'].flatMap(columns =>
      [35, -78 + i * 1e-6, i === 4 ? 885.3 : 2].map((value, j) => ({ cell: columns[j] + String(row), value })))
    return { row, cells }
  })
  const file = join(dir, 'structure.json')
  try {
    writeFileSync(file, JSON.stringify({ schemaVersion: 'public-methane-workbook-structure-v1',
      sha256: 'd408f8d7b9b0630132720ad069095230f442a6d24a8be159a8558bdb4b9e1b4d',
      sheets: [{ name: 'Methane Transects Data Set', rows }] }))
    const run = spawnSync(process.execPath, [resolve('node_modules/vite-node/vite-node.mjs'),
      resolve('scripts/empirical-epa-replay.ts'), file], { encoding: 'utf8' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('Controlled-release cells differ')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
