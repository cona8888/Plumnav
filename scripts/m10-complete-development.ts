/** Preserve the frozen source, then verify/archive/analyze a completed M10 run. */
import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyM10Results } from './m10-verify-results'
import { analyzeM10GeometryDevelopment } from './m10-geometry-development-analysis'

const root = fileURLToPath(new URL('../', import.meta.url))
const run = '/private/tmp/plumenav-m10-geometry-development-2026-09-05'
const archive = join(root, 'research/evidence/m10_geometry_conditioned_development_2026-09-05')
const analysis = join(root, 'research/analysis/m10_geometry_conditioned_development_2026-09-05')
const snapshot = join(root, 'research/protocols/m10_geometry_conditioned_development/source-snapshot')
const expectedImplementation = '32f91bb29ff00426358c5cceb6bd21475a95524144b602ae8ba12a2fff17b1c4'
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const exists = async (path: string) => stat(path).then(() => true).catch((error) => {
  if (error.code === 'ENOENT') return false
  throw error
})
const freezeSource = async () => {
  const implementation = JSON.parse(await readFile(join(run, 'implementation.json'), 'utf8')) as {
    implementationSha256: string
    files: Array<{ path: string; bytes: number; sha256: string }>
  }
  if (implementation.implementationSha256 !== expectedImplementation) throw new Error('Unexpected M10 implementation')
  const digest = createHash('sha256')
  for (const entry of implementation.files) {
    if (entry.path.startsWith('/') || entry.path.split('/').includes('..')) throw new Error('Unsafe source path')
    const destination = join(snapshot, entry.path)
    const source = await exists(destination) ? destination : join(root, entry.path)
    const bytes = await readFile(source)
    if (bytes.byteLength !== entry.bytes || sha(bytes) !== entry.sha256) throw new Error(`Frozen source mismatch: ${entry.path}`)
    digest.update(entry.path); digest.update('\0'); digest.update(bytes); digest.update('\0')
    if (source !== destination) {
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
    }
  }
  if (digest.digest('hex') !== expectedImplementation) throw new Error('Reconstructed implementation digest mismatch')
  return { files: implementation.files.length, implementationSha256: expectedImplementation, snapshot }
}

const complete = async () => {
  const executions = await Promise.all((await readdir(join(run, 'executions')))
    .filter((name) => name.endsWith('.json'))
    .map(async (name) => JSON.parse(await readFile(join(run, 'executions', name), 'utf8'))))
  const execution = executions.filter((item) => item.status === 'complete')
    .sort((a, b) => b.completedAtUtc.localeCompare(a.completedAtUtc))[0]
  if (!execution) throw new Error('M10 coordinator has not recorded successful completion')
  if (execution.actualWorkers !== 6 || execution.afterMemory.swapouts > execution.beforeMemory.swapouts ||
      execution.peakAggregateRssBytes >= execution.resourcePolicy.rssStopBytes) {
    throw new Error('M10 execution resource acceptance failed')
  }
  const frozenSource = await freezeSource()
  const verification = await verifyM10Results(run)
  if (await exists(archive)) {
    const existing = await verifyM10Results(archive)
    if (existing.rawResultsSha256 !== verification.rawResultsSha256) throw new Error('Existing M10 archive differs')
  } else {
    await cp(run, archive, { recursive: true, errorOnExist: true, force: false })
  }
  await cp(snapshot, join(archive, 'source-snapshot'), { recursive: true, force: false })
  const archivedVerification = await verifyM10Results(archive)
  await writeFile(join(archive, 'independent-verification.json'), `${JSON.stringify(archivedVerification, null, 2)}\n`)
  const result = await analyzeM10GeometryDevelopment(archive, analysis)
  const analysisSource = join(archive, 'analysis-source')
  await mkdir(analysisSource, { recursive: true })
  for (const name of ['m10-verify-results.ts', 'm10-geometry-development-analysis.ts',
    'm10-geometry-development-analysis.test.ts', 'm10-complete-development.ts']) {
    await copyFile(join(root, 'scripts', name), join(analysisSource, name))
  }
  return { ...result, archive, frozenSource, wallSeconds: execution.wallSeconds,
    peakAggregateRssBytes: execution.peakAggregateRssBytes, verification: archivedVerification }
}

const mode = process.argv.at(-1)
const action = mode === '--freeze-source' ? freezeSource : mode === '--complete' ? complete : null
if (!action) throw new Error('Use --freeze-source or --complete')
action().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
