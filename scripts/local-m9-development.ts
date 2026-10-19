/** Mac-first coordinator for the frozen 256-run M9 adaptive-viewpoint development. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { availableParallelism, homedir, hostname } from 'node:os'
import { dirname, join, parse, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  executeM9Shard,
  finalizeM9Verification,
  prepareM9Verification,
  selectM9Shard,
  type M9ShardResult,
} from './m9-sharded-development'

type Options = {
  outputDirectory: string
  workers: number
  dryRun: boolean
  resume: boolean
  recoverLock: boolean
  internalShardIndex: number | null
  internalShardCount: number | null
  help: boolean
}
type LockRecord = {
  schemaVersion: 'plumenav-m9-lock-v1'
  token: string
  pid: number
  hostname: string
  startedAtUtc: string
}
type MemorySnapshot = {
  capturedAtUtc: string
  freeMemoryPercent: number
  swapouts: number
  swapins: number
  pageouts: number
}

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const thisScript = fileURLToPath(import.meta.url)
const viteNode = fileURLToPath(new URL('../node_modules/vite-node/vite-node.mjs', import.meta.url))
const LOCK_NAME = '.plumenav-m9-coordinator.lock'
const TOKEN_ENV = 'PLUMENAV_M9_COORDINATOR_TOKEN'
const RSS_LIMIT_BYTES = 48 * 1024 ** 3
const ALLOWED_WORKERS = new Set([1, 6])
const stableJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const usage = `PlumeNav M9 adaptive-viewpoint development\n\nUsage: vite-node scripts/local-m9-development.ts [options]\n\n  --output <directory>  Fresh or resumable output directory\n  --workers <1|6>       Worker processes (default: 6)\n  --dry-run             Freeze and validate the 64-cell/256-run design only\n  --resume              Reuse only fully verified four-arm cells\n  --recover-lock        Recover only a dead same-host lock\n`

const requiredValue = (arguments_: string[], index: number, flag: string) => {
  const value = arguments_[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}
const parseArguments = (arguments_: string[]): Options => {
  let outputDirectory = resolve('/private/tmp/plumenav-m9-adaptive-development-2026-09-04')
  let workers = 6
  let dryRun = false
  let resume = false
  let recoverLock = false
  let internalShardIndex: number | null = null
  let internalShardCount: number | null = null
  let help = false
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!
    if (argument === '--output') {
      outputDirectory = resolve(requiredValue(arguments_, index, argument)); index += 1
    } else if (argument === '--workers') {
      workers = Number(requiredValue(arguments_, index, argument)); index += 1
    } else if (argument === '--dry-run') dryRun = true
    else if (argument === '--resume') resume = true
    else if (argument === '--recover-lock') recoverLock = true
    else if (argument === '--help' || argument === '-h') help = true
    else if (argument === '--internal-shard-index') {
      internalShardIndex = Number(requiredValue(arguments_, index, argument)); index += 1
    } else if (argument === '--internal-shard-count') {
      internalShardCount = Number(requiredValue(arguments_, index, argument)); index += 1
    } else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!ALLOWED_WORKERS.has(workers)) throw new Error('--workers must be 1 or 6')
  if ((internalShardIndex === null) !== (internalShardCount === null)) {
    throw new Error('Internal shard index/count must be supplied together')
  }
  if (internalShardIndex !== null &&
      (!Number.isInteger(internalShardIndex) || !Number.isInteger(internalShardCount) ||
       internalShardCount !== workers || internalShardIndex < 0 || internalShardIndex >= internalShardCount!)) {
    throw new Error('Invalid internal shard index/count')
  }
  return { outputDirectory, workers, dryRun, resume, recoverLock, internalShardIndex, internalShardCount, help }
}

const exists = async (path: string) => {
  try { await stat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
const pathInside = (candidate: string, parent: string) => {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith('..') && !parse(path).root)
}
const realTarget = async (target: string) => {
  let existing = target
  while (true) {
    try { return resolve(await realpath(existing), relative(existing, target)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) return target
      existing = parent
    }
  }
}
const assertSafeOutput = async (output: string) => {
  const absolute = resolve(output)
  const resolved = await realTarget(absolute)
  if ([parse(absolute).root, resolve(homedir()), resolve(projectRoot)].includes(absolute)) {
    throw new Error(`Unsafe M9 output directory: ${absolute}`)
  }
  for (const root of ['research/evidence', 'research/protocols', 'release', 'outputs'].map((path) => join(projectRoot, path))) {
    const resolvedRoot = await realTarget(root)
    if (pathInside(absolute, root) || pathInside(resolved, resolvedRoot)) {
      throw new Error(`M9 output may not be written inside ${root}`)
    }
  }
}
const assertOutputMode = async (options: Options) => {
  if (!(await exists(options.outputDirectory))) return
  const entries = (await readdir(options.outputDirectory)).filter((entry) => entry !== LOCK_NAME)
  if (entries.length && !options.resume) throw new Error('M9 output is not empty; choose a fresh directory or pass --resume')
  if (entries.length && !entries.includes('manifest.json')) throw new Error('Cannot resume without an M9 manifest')
}
const atomicWrite = async (path: string, contents: string) => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try { await writeFile(temporary, contents, 'utf8'); await rename(temporary, path) } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}
const readLock = async (path: string) => {
  const lock = JSON.parse(await readFile(path, 'utf8')) as Partial<LockRecord>
  if (lock.schemaVersion !== 'plumenav-m9-lock-v1' || typeof lock.token !== 'string' ||
      !Number.isInteger(lock.pid) || typeof lock.hostname !== 'string' || typeof lock.startedAtUtc !== 'string') {
    throw new Error('Malformed M9 lock; refusing recovery')
  }
  return lock as LockRecord
}
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
const acquireLock = async (options: Options) => {
  await mkdir(options.outputDirectory, { recursive: true })
  const lockPath = join(options.outputDirectory, LOCK_NAME)
  if (options.recoverLock && await exists(lockPath)) {
    const oldLock = await readLock(lockPath)
    if (oldLock.hostname !== hostname()) throw new Error('Refusing cross-host M9 lock recovery')
    if (alive(oldLock.pid)) throw new Error(`M9 coordinator PID ${oldLock.pid} is still alive`)
    const claim = `${lockPath}.recovering-${process.pid}-${randomUUID()}`
    await rename(lockPath, claim)
    await unlink(claim)
  }
  const token = randomUUID()
  let handle
  try { handle = await open(lockPath, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`M9 output is locked: ${(await readFile(lockPath, 'utf8')).trim()}`)
    }
    throw error
  }
  try {
    await handle.writeFile(stableJson({
      schemaVersion: 'plumenav-m9-lock-v1', token, pid: process.pid,
      hostname: hostname(), startedAtUtc: new Date().toISOString(),
    }))
  } finally { await handle.close() }
  return {
    token,
    release: async () => {
      try { if ((await readLock(lockPath)).token === token) await unlink(lockPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
  }
}

const parseCounter = (text: string, label: string) => {
  const match = text.match(new RegExp(`^${label}:\\s+([0-9]+)\\.?`, 'm'))
  if (!match) throw new Error(`vm_stat did not report ${label}`)
  return Number(match[1])
}
const memorySnapshot = async (): Promise<MemorySnapshot> => {
  const [pressure, virtualMemory] = await Promise.all([
    execFileAsync('/usr/bin/memory_pressure', ['-Q']),
    execFileAsync('/usr/bin/vm_stat'),
  ])
  const match = pressure.stdout.match(/free percentage:\s*([0-9]+)/i)
  if (!match) throw new Error('memory_pressure did not report free-memory percentage')
  return {
    capturedAtUtc: new Date().toISOString(),
    freeMemoryPercent: Number(match[1]),
    pageouts: parseCounter(virtualMemory.stdout, 'Pageouts'),
    swapins: parseCounter(virtualMemory.stdout, 'Swapins'),
    swapouts: parseCounter(virtualMemory.stdout, 'Swapouts'),
  }
}
const processTreeRss = async () => {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,rss='])
  const rows = stdout.trim().split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row) => row.length === 3 && row.every(Number.isFinite))
    .map((row) => ({ pid: row[0]!, ppid: row[1]!, rss: row[2]! }))
  const descendants = new Set([process.pid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid); changed = true
      }
    }
  }
  return {
    bytes: rows.filter((row) => descendants.has(row.pid)).reduce((sum, row) => sum + row.rss * 1024, 0),
    processCount: descendants.size,
  }
}
const streamLines = (stream: NodeJS.ReadableStream, consume: (line: string) => void) => {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) if (line) consume(line)
  })
  stream.on('end', () => { if (pending) consume(pending) })
}

const runChild = (options: Options, shardIndex: number, token: string, children: Set<ChildProcess>) =>
  new Promise<M9ShardResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      viteNode, thisScript, '--output', options.outputDirectory, '--workers', String(options.workers),
      '--internal-shard-index', String(shardIndex), '--internal-shard-count', String(options.workers),
    ], {
      cwd: projectRoot,
      env: { ...process.env, [TOKEN_ENV]: token },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.add(child)
    let result: M9ShardResult | null = null
    streamLines(child.stdout!, (line) => {
      try {
        const event = JSON.parse(line) as { event?: string; cellId?: string; status?: string; result?: M9ShardResult }
        if (event.event === 'progress') {
          process.stdout.write(`m9 worker ${shardIndex + 1}/${options.workers}: ${event.cellId} ${event.status}\n`)
        } else if (event.event === 'complete' && event.result) result = event.result
        else process.stdout.write(`m9 worker ${shardIndex + 1}/${options.workers}: ${line}\n`)
      } catch { process.stdout.write(`m9 worker ${shardIndex + 1}/${options.workers}: ${line}\n`) }
    })
    streamLines(child.stderr!, (line) => process.stderr.write(`m9 worker ${shardIndex + 1}/${options.workers}: ${line}\n`))
    child.once('error', rejectPromise)
    child.once('close', (code, signal) => {
      children.delete(child)
      if (code === 0 && result) resolvePromise(result)
      else rejectPromise(new Error(`M9 worker ${shardIndex} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`))
    })
  })
const authorizeInternalWorker = async (options: Options) => {
  const token = process.env[TOKEN_ENV]
  if (!token) throw new Error('M9 internal worker requires coordinator authorization')
  const lock = await readLock(join(options.outputDirectory, LOCK_NAME))
  if (lock.token !== token || lock.pid !== process.ppid || !alive(lock.pid)) {
    throw new Error('M9 worker authorization does not match active coordinator')
  }
}
const runInternal = async (options: Options) => {
  await authorizeInternalWorker(options)
  const result = await executeM9Shard({
    outputDirectory: options.outputDirectory,
    shardIndex: options.internalShardIndex!,
    shardCount: options.internalShardCount!,
    onProgress: (progress) => process.stdout.write(`${JSON.stringify({ event: 'progress', ...progress })}\n`),
  })
  process.stdout.write(`${JSON.stringify({ event: 'complete', result })}\n`)
}

const runCoordinator = async (options: Options) => {
  if (options.workers > availableParallelism()) throw new Error('Requested M9 workers exceed available CPU parallelism')
  await assertSafeOutput(options.outputDirectory)
  await assertOutputMode(options)
  const lock = await acquireLock(options)
  const children = new Set<ChildProcess>()
  const abort = new AbortController()
  let interrupted = false
  let resourceError: Error | null = null
  let monitoring = false
  let peakAggregateRssBytes = 0
  let peakProcessCount = 1
  const pressureSamples: Array<unknown> = []
  let consecutiveLowMemorySamples = 0
  const interrupt = (signal: NodeJS.Signals) => {
    interrupted = true
    abort.abort(new Error(`M9 coordinator interrupted by ${signal}`))
    for (const child of children) child.kill('SIGTERM')
  }
  const onInterrupt = () => interrupt('SIGINT')
  const onTerminate = () => interrupt('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  const monitor = async () => {
    let lastPressureSample = 0
    while (monitoring) {
      try {
        const rss = await processTreeRss()
        peakAggregateRssBytes = Math.max(peakAggregateRssBytes, rss.bytes)
        peakProcessCount = Math.max(peakProcessCount, rss.processCount)
        if (rss.bytes >= RSS_LIMIT_BYTES) throw new Error('M9 process tree reached 48 GiB RSS stop limit')
        if (Date.now() - lastPressureSample >= 5000) {
          const memory = await memorySnapshot()
          pressureSamples.push({ capturedAtUtc: memory.capturedAtUtc, freeMemoryPercent: memory.freeMemoryPercent })
          consecutiveLowMemorySamples = memory.freeMemoryPercent < 20 ? consecutiveLowMemorySamples + 1 : 0
          if (consecutiveLowMemorySamples >= 2) throw new Error('M9 observed free memory below 20% twice')
          lastPressureSample = Date.now()
        }
      } catch (error) {
        resourceError = error instanceof Error ? error : new Error(String(error))
        abort.abort(resourceError)
        for (const child of children) child.kill('SIGTERM')
        break
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }

  let childPromises: Promise<M9ShardResult>[] = []
  let monitorPromise: Promise<void> | null = null
  const started = new Date()
  const sessionId = randomUUID()
  let executionPath: string | null = null
  let record: Record<string, unknown> | null = null
  try {
    const beforeMemory = options.dryRun ? null : await memorySnapshot()
    const prepared = await prepareM9Verification(options.outputDirectory, options.resume)
    const assignments = Array.from({ length: options.workers }, (_, shardIndex) => {
      const cellIds = selectM9Shard(prepared.manifest.cells, shardIndex, options.workers)
        .map((cell) => cell.id)
      return { shardIndex, cellIds, plannedRuns: cellIds.length * 4 }
    })
    await mkdir(join(options.outputDirectory, 'executions'), { recursive: true })
    executionPath = join(options.outputDirectory, 'executions', `${sessionId}.json`)
    record = {
      schemaVersion: 'local-m9-execution-v1', sessionId,
      status: options.dryRun ? 'dry-run' : 'running', startedAtUtc: started.toISOString(),
      manifestSha256: prepared.manifestSha256,
      implementationSha256: prepared.implementationSha256,
      runtime: prepared.runtime, runtimeFingerprint: prepared.runtimeFingerprint,
      requestedWorkers: options.workers, actualWorkers: options.dryRun ? 0 : options.workers,
      assignments,
      plannedCells: prepared.manifest.cells.length,
      plannedSimulationRuns: prepared.manifest.design.plannedSimulationRuns,
      resume: options.resume, invocation: process.argv.slice(2),
      resourcePolicy: {
        rssSamplingIntervalMs: 250, pressureSamplingIntervalMs: 5000,
        rssStopBytes: RSS_LIMIT_BYTES, freeMemoryStopPercent: 20,
      },
      beforeMemory,
    }
    await atomicWrite(executionPath, stableJson(record))
    if (options.dryRun) {
      process.stdout.write(stableJson({
        status: 'dry-run', outputDirectory: options.outputDirectory,
        manifestSha256: prepared.manifestSha256,
        plannedCells: prepared.manifest.cells.length,
        plannedSimulationRuns: prepared.manifest.design.plannedSimulationRuns,
      }))
      return
    }
    monitoring = true
    monitorPromise = monitor()
    childPromises = Array.from({ length: options.workers }, (_, shardIndex) =>
      runChild(options, shardIndex, lock.token, children))
    const shardResults = await Promise.all(childPromises)
    if (resourceError || abort.signal.aborted) throw resourceError ?? abort.signal.reason
    const afterMemory = await memorySnapshot()
    if (beforeMemory && afterMemory.swapouts > beforeMemory.swapouts) {
      throw new Error('M9 run caused swapouts; campaign rejected')
    }
    const finalized = await finalizeM9Verification(options.outputDirectory, abort.signal)
    monitoring = false
    if (monitorPromise) await monitorPromise
    record = {
      ...record, status: 'complete', completedAtUtc: new Date().toISOString(),
      wallSeconds: (Date.now() - started.getTime()) / 1000,
      shardResults, afterMemory, pressureSamples, peakAggregateRssBytes, peakProcessCount,
      scientificResultsSha256: finalized.scientificResultsSha256,
      rawResultsSha256: finalized.rawResultsSha256,
    }
    await atomicWrite(executionPath, stableJson(record))
    process.stdout.write(stableJson({
      status: 'complete', outputDirectory: options.outputDirectory, workers: options.workers,
      wallSeconds: record.wallSeconds, peakAggregateRssBytes, peakProcessCount,
      completedCells: shardResults.reduce((sum, result) => sum + result.completedCells, 0),
      skippedCells: shardResults.reduce((sum, result) => sum + result.skippedCells, 0),
      completedSimulationRuns: finalized.rawResultRows,
      manifestSha256: finalized.manifestSha256,
      scientificResultsSha256: finalized.scientificResultsSha256,
      rawResultsSha256: finalized.rawResultsSha256,
    }))
  } catch (error) {
    for (const child of children) child.kill('SIGTERM')
    await Promise.allSettled(childPromises)
    monitoring = false
    if (monitorPromise) await monitorPromise
    if (record && executionPath) {
      await atomicWrite(executionPath, stableJson({
        ...record,
        status: resourceError ? 'resource-limit' : interrupted ? 'interrupted' : 'failed',
        completedAtUtc: new Date().toISOString(),
        wallSeconds: (Date.now() - started.getTime()) / 1000,
        pressureSamples, peakAggregateRssBytes, peakProcessCount,
        error: resourceError?.message ?? (error instanceof Error ? error.message : String(error)),
      })).catch(() => undefined)
    }
    throw error
  } finally {
    monitoring = false
    if (monitorPromise) await monitorPromise
    for (const child of children) child.kill('SIGTERM')
    await Promise.allSettled(childPromises)
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
    await lock.release()
  }
}

const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) { process.stdout.write(usage); return }
  if (options.internalShardIndex !== null) await runInternal(options)
  else await runCoordinator(options)
}
main().catch((error) => {
  process.stderr.write(`M9 development failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
