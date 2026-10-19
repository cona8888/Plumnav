/** Mac-only coordinator for the isolated 96² grid commissioning campaign. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { availableParallelism, homedir, hostname } from 'node:os'
import { dirname, join, parse, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  createGridCommissioningManifest,
  executeGridCommissioningShard,
  finalizeGridCommissioning,
  prepareGridCommissioning,
  selectGridShard,
  type GridShardResult,
} from './grid-commissioning'

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
  schemaVersion: 'plumenav-grid-lock-v1'
  token: string
  pid: number
  hostname: string
  startedAtUtc: string
}

type MemorySnapshot = {
  capturedAtUtc: string
  freeMemoryPercent: number
  pageouts: number
  swapins: number
  swapouts: number
}

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const thisScript = fileURLToPath(import.meta.url)
const viteNode = fileURLToPath(new URL('../node_modules/vite-node/vite-node.mjs', import.meta.url))
const LOCK_NAME = '.plumenav-grid-coordinator.lock'
const TOKEN_ENV = 'PLUMENAV_GRID_COORDINATOR_TOKEN'
const RSS_LIMIT_BYTES = 48 * 1024 ** 3
const ALLOWED_WORKERS = new Set([1, 2, 4, 6])
const stableJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const usage = `PlumeNav 96² grid commissioning

Usage:
  vite-node scripts/local-grid-commissioning.ts [options]

Options:
  --output <directory>  Fresh or resumable output directory
  --workers <1|2|4|6>   Worker processes (default: 1)
  --dry-run             Freeze/validate design only
  --resume              Reuse only fully verified cells
  --recover-lock        Recover only a dead same-host lock
  --help                 Show this help
`

const requiredValue = (args: string[], index: number, flag: string) => {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

const parseArguments = (args: string[]): Options => {
  let outputDirectory = resolve('/private/tmp/plumenav-grid-commissioning')
  let workers = 1
  let dryRun = false
  let resume = false
  let recoverLock = false
  let internalShardIndex: number | null = null
  let internalShardCount: number | null = null
  let help = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '--output') {
      outputDirectory = resolve(requiredValue(args, index, argument))
      index += 1
    } else if (argument === '--workers') {
      workers = Number(requiredValue(args, index, argument))
      index += 1
    } else if (argument === '--dry-run') dryRun = true
    else if (argument === '--resume') resume = true
    else if (argument === '--recover-lock') recoverLock = true
    else if (argument === '--help' || argument === '-h') help = true
    else if (argument === '--internal-shard-index') {
      internalShardIndex = Number(requiredValue(args, index, argument))
      index += 1
    } else if (argument === '--internal-shard-count') {
      internalShardCount = Number(requiredValue(args, index, argument))
      index += 1
    } else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!ALLOWED_WORKERS.has(workers)) throw new Error('--workers must be one of 1, 2, 4, or 6')
  if ((internalShardIndex === null) !== (internalShardCount === null)) {
    throw new Error('Internal shard index/count must be supplied together')
  }
  return {
    outputDirectory,
    workers,
    dryRun,
    resume,
    recoverLock,
    internalShardIndex,
    internalShardCount,
    help,
  }
}

const exists = async (path: string) => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const pathInside = (candidate: string, parent: string) => {
  const fromParent = relative(parent, candidate)
  return fromParent === '' || (!fromParent.startsWith('..') && !parse(fromParent).root)
}

const realTarget = async (target: string) => {
  let existing = target
  while (true) {
    try {
      return resolve(await realpath(existing), relative(existing, target))
    } catch (error) {
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
    throw new Error(`Unsafe grid output directory: ${absolute}`)
  }
  const protectedRoots = [
    join(projectRoot, 'research', 'evidence'),
    join(projectRoot, 'research', 'protocols'),
    join(projectRoot, 'release'),
    join(projectRoot, 'outputs'),
  ]
  for (const protectedRoot of protectedRoots) {
    const protectedReal = await realTarget(protectedRoot)
    if (pathInside(absolute, protectedRoot) || pathInside(resolved, protectedReal)) {
      throw new Error(`Grid output may not be written inside ${protectedRoot}`)
    }
  }
}

const assertOutputMode = async (options: Options) => {
  if (!(await exists(options.outputDirectory))) return
  const entries = (await readdir(options.outputDirectory)).filter((entry) => entry !== LOCK_NAME)
  if (entries.length === 0) return
  if (!options.resume) throw new Error('Grid output is not empty; choose a fresh directory or pass --resume')
  if (!entries.includes('manifest.json')) throw new Error('Cannot resume a directory without a grid manifest')
}

const atomicWrite = async (path: string, contents: string) => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

const readLock = async (path: string) => {
  const lock = JSON.parse(await readFile(path, 'utf8')) as Partial<LockRecord>
  if (
    lock.schemaVersion !== 'plumenav-grid-lock-v1' ||
    typeof lock.token !== 'string' || !Number.isInteger(lock.pid) ||
    typeof lock.hostname !== 'string' || typeof lock.startedAtUtc !== 'string'
  ) throw new Error('Malformed grid coordinator lock; refusing recovery')
  return lock as LockRecord
}

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const acquireLock = async (options: Options) => {
  await mkdir(options.outputDirectory, { recursive: true })
  const path = join(options.outputDirectory, LOCK_NAME)
  if (options.recoverLock && await exists(path)) {
    const stale = await readLock(path)
    if (stale.hostname !== hostname()) throw new Error('Refusing cross-host grid lock recovery')
    if (processAlive(stale.pid)) throw new Error(`Grid coordinator PID ${stale.pid} is still alive`)
    const claim = `${path}.recovering-${process.pid}-${randomUUID()}`
    await rename(path, claim)
    await unlink(claim)
  }
  const token = randomUUID()
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Grid output is locked: ${(await readFile(path, 'utf8')).trim()}`)
    }
    throw error
  }
  const record: LockRecord = {
    schemaVersion: 'plumenav-grid-lock-v1',
    token,
    pid: process.pid,
    hostname: hostname(),
    startedAtUtc: new Date().toISOString(),
  }
  try {
    await handle.writeFile(stableJson(record))
  } finally {
    await handle.close()
  }
  return {
    token,
    release: async () => {
      try {
        if ((await readLock(path)).token === token) await unlink(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
  }
}

const parseCounter = (text: string, label: string) => {
  const matched = text.match(new RegExp(`^${label}:\\s+([0-9]+)\\.?`, 'm'))
  if (!matched) throw new Error(`vm_stat did not report ${label}`)
  return Number(matched[1])
}

const memorySnapshot = async (): Promise<MemorySnapshot> => {
  const [pressure, vm] = await Promise.all([
    execFileAsync('/usr/bin/memory_pressure', ['-Q'], { maxBuffer: 1024 * 1024 }),
    execFileAsync('/usr/bin/vm_stat', [], { maxBuffer: 1024 * 1024 }),
  ])
  const free = pressure.stdout.match(/free percentage:\s*([0-9]+)/i)
  if (!free) throw new Error('memory_pressure did not report free-memory percentage')
  return {
    capturedAtUtc: new Date().toISOString(),
    freeMemoryPercent: Number(free[1]),
    pageouts: parseCounter(vm.stdout, 'Pageouts'),
    swapins: parseCounter(vm.stdout, 'Swapins'),
    swapouts: parseCounter(vm.stdout, 'Swapouts'),
  }
}

const processTreeRss = async () => {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], {
    maxBuffer: 4 * 1024 * 1024,
  })
  const rows = stdout.trim().split(/\r?\n/).map((line) => {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number)
    return { pid, ppid, rss }
  }).filter((row) => Number.isFinite(row.pid) && Number.isFinite(row.ppid) && Number.isFinite(row.rss))
  const descendants = new Set([process.pid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid)
        changed = true
      }
    }
  }
  return {
    bytes: rows.filter((row) => descendants.has(row.pid))
      .reduce((sum, row) => sum + row.rss * 1024, 0),
    processCount: descendants.size,
  }
}

const streamLines = (stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) if (line) onLine(line)
  })
  stream.on('end', () => { if (pending) onLine(pending) })
}

const runChild = (
  options: Options,
  shardIndex: number,
  shardCount: number,
  token: string,
  children: Set<ChildProcess>,
) => new Promise<GridShardResult>((resolvePromise, rejectPromise) => {
  const child = spawn(process.execPath, [
    viteNode,
    thisScript,
    '--output', options.outputDirectory,
    '--workers', String(options.workers),
    '--internal-shard-index', String(shardIndex),
    '--internal-shard-count', String(shardCount),
  ], {
    cwd: projectRoot,
    env: { ...process.env, [TOKEN_ENV]: token },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  let result: GridShardResult | null = null
  streamLines(child.stdout!, (line) => {
    try {
      const event = JSON.parse(line) as {
        event?: string
        cellId?: string
        status?: string
        result?: GridShardResult
      }
      if (event.event === 'progress') {
        process.stdout.write(`grid worker ${shardIndex + 1}/${shardCount}: ${event.cellId} ${event.status}\n`)
      } else if (event.event === 'complete' && event.result) result = event.result
      else process.stdout.write(`grid worker ${shardIndex + 1}/${shardCount}: ${line}\n`)
    } catch {
      process.stdout.write(`grid worker ${shardIndex + 1}/${shardCount}: ${line}\n`)
    }
  })
  streamLines(child.stderr!, (line) => process.stderr.write(
    `grid worker ${shardIndex + 1}/${shardCount}: ${line}\n`,
  ))
  child.once('error', rejectPromise)
  child.once('close', (code, signal) => {
    children.delete(child)
    if (code === 0 && result) resolvePromise(result)
    else rejectPromise(new Error(
      `Grid worker ${shardIndex} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
    ))
  })
})

const authorizeWorker = async (options: Options) => {
  const token = process.env[TOKEN_ENV]
  if (!token) throw new Error('Grid internal worker requires coordinator authorization')
  const lock = await readLock(join(options.outputDirectory, LOCK_NAME))
  if (lock.token !== token || lock.pid !== process.ppid || !processAlive(lock.pid)) {
    throw new Error('Grid worker authorization does not match the active coordinator')
  }
}

const runInternal = async (options: Options) => {
  await authorizeWorker(options)
  const result = await executeGridCommissioningShard({
    outputDirectory: options.outputDirectory,
    shardIndex: options.internalShardIndex!,
    shardCount: options.internalShardCount!,
    onProgress: (progress) => process.stdout.write(
      `${JSON.stringify({ event: 'progress', ...progress })}\n`,
    ),
  })
  process.stdout.write(`${JSON.stringify({ event: 'complete', result })}\n`)
}

const runCoordinator = async (options: Options) => {
  const design = createGridCommissioningManifest()
  if (options.workers > Math.min(design.cells.length, availableParallelism())) {
    throw new Error('Requested grid workers exceed cells or available CPU parallelism')
  }
  await assertSafeOutput(options.outputDirectory)
  await assertOutputMode(options)
  const lock = await acquireLock(options)
  const children = new Set<ChildProcess>()
  const abortController = new AbortController()
  let interrupted: NodeJS.Signals | null = null
  let resourceError: Error | null = null
  let promises: Array<Promise<GridShardResult>> = []
  let monitoring = false
  let peakAggregateRssBytes = 0
  let peakProcessCount = 1
  const pressureSamples: Array<{ capturedAtUtc: string; freeMemoryPercent: number }> = []
  let consecutiveLowPressure = 0
  const interrupt = (signal: NodeJS.Signals) => {
    interrupted = signal
    abortController.abort(new Error(`Grid coordinator interrupted by ${signal}`))
    for (const child of children) child.kill('SIGTERM')
  }
  const onSigint = () => interrupt('SIGINT')
  const onSigterm = () => interrupt('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  const throwIfAborted = () => {
    if (resourceError) throw resourceError
    if (abortController.signal.aborted) throw abortController.signal.reason
  }
  const sampleLoop = async () => {
    let lastPressure = 0
    while (monitoring) {
      try {
        const rss = await processTreeRss()
        peakAggregateRssBytes = Math.max(peakAggregateRssBytes, rss.bytes)
        peakProcessCount = Math.max(peakProcessCount, rss.processCount)
        if (rss.bytes >= RSS_LIMIT_BYTES) {
          resourceError = new Error('Grid process tree reached the 48 GiB RSS stop limit')
          abortController.abort(resourceError)
          for (const child of children) child.kill('SIGTERM')
          break
        }
        if (Date.now() - lastPressure >= 5_000) {
          const pressure = await memorySnapshot()
          pressureSamples.push({
            capturedAtUtc: pressure.capturedAtUtc,
            freeMemoryPercent: pressure.freeMemoryPercent,
          })
          consecutiveLowPressure = pressure.freeMemoryPercent < 20
            ? consecutiveLowPressure + 1
            : 0
          if (consecutiveLowPressure >= 2) {
            resourceError = new Error('Grid run observed free memory below 20% twice')
            abortController.abort(resourceError)
            for (const child of children) child.kill('SIGTERM')
            break
          }
          lastPressure = Date.now()
        }
      } catch (error) {
        resourceError = error instanceof Error ? error : new Error(String(error))
        abortController.abort(resourceError)
        for (const child of children) child.kill('SIGTERM')
        break
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }

  const sessionId = randomUUID()
  const startedAt = new Date()
  let executionPath: string | null = null
  let execution: Record<string, unknown> | null = null
  let monitorPromise: Promise<void> | null = null
  try {
    const beforeMemory = options.dryRun ? null : await memorySnapshot()
    const context = await prepareGridCommissioning(options.outputDirectory, options.resume)
    throwIfAborted()
    await mkdir(join(options.outputDirectory, 'executions'), { recursive: true })
    executionPath = join(options.outputDirectory, 'executions', `${sessionId}.json`)
    const assignments = Array.from({ length: options.workers }, (_, shardIndex) => ({
      shardIndex,
      cellIds: selectGridShard(context.manifest.cells, shardIndex, options.workers)
        .map((cell) => cell.id),
    }))
    execution = {
      schemaVersion: 'local-grid-execution-v1',
      sessionId,
      status: options.dryRun ? 'dry-run' : 'running',
      startedAtUtc: startedAt.toISOString(),
      manifestSha256: context.manifestSha256,
      implementationSha256: context.implementationSha256,
      runtime: context.runtime,
      runtimeFingerprint: context.runtimeFingerprint,
      requestedWorkers: options.workers,
      actualWorkers: options.dryRun ? 0 : options.workers,
      assignments: options.dryRun ? [] : assignments,
      resume: options.resume,
      invocation: process.argv.slice(2),
      resourcePolicy: {
        rssSamplingIntervalMs: 250,
        pressureSamplingIntervalMs: 5_000,
        rssStopBytes: RSS_LIMIT_BYTES,
        freeMemoryStopPercent: 20,
      },
      beforeMemory,
    }
    await atomicWrite(executionPath, stableJson(execution))
    if (options.dryRun) {
      process.stdout.write(stableJson({
        status: 'dry-run',
        outputDirectory: options.outputDirectory,
        manifestSha256: context.manifestSha256,
        plannedCells: context.manifest.cells.length,
      }))
      return
    }
    monitoring = true
    monitorPromise = sampleLoop()
    promises = Array.from({ length: options.workers }, (_, shardIndex) =>
      runChild(options, shardIndex, options.workers, lock.token, children))
    const shardResults = await Promise.all(promises)
    throwIfAborted()
    const afterWorkersMemory = await memorySnapshot()
    if (beforeMemory && afterWorkersMemory.swapouts > beforeMemory.swapouts) {
      throw new Error('Grid run caused swapouts; commissioning trial rejected')
    }
    const finalized = await finalizeGridCommissioning(
      options.outputDirectory,
      abortController.signal,
    )
    throwIfAborted()
    monitoring = false
    await monitorPromise
    const completedAt = new Date()
    execution = {
      ...execution,
      status: 'complete',
      completedAtUtc: completedAt.toISOString(),
      wallSeconds: (completedAt.getTime() - startedAt.getTime()) / 1000,
      shardResults,
      afterMemory: afterWorkersMemory,
      pressureSamples,
      peakAggregateRssBytes,
      peakProcessCount,
      scientificResultsSha256: finalized.scientificResultsSha256,
      rawResultsSha256: finalized.rawResultsSha256,
    }
    await atomicWrite(executionPath, stableJson(execution))
    process.stdout.write(stableJson({
      status: 'complete',
      outputDirectory: options.outputDirectory,
      workers: options.workers,
      wallSeconds: execution.wallSeconds,
      peakAggregateRssBytes,
      peakProcessCount,
      completedCells: shardResults.reduce((sum, item) => sum + item.completedCells, 0),
      skippedCells: shardResults.reduce((sum, item) => sum + item.skippedCells, 0),
      manifestSha256: finalized.manifestSha256,
      scientificResultsSha256: finalized.scientificResultsSha256,
      rawResultsSha256: finalized.rawResultsSha256,
    }))
  } catch (error) {
    for (const child of children) child.kill('SIGTERM')
    await Promise.allSettled(promises)
    monitoring = false
    if (monitorPromise) await monitorPromise
    if (execution && executionPath) {
      const completedAt = new Date()
      await atomicWrite(executionPath, stableJson({
        ...execution,
        status: resourceError ? 'resource-limit' : interrupted ? 'interrupted' : 'failed',
        completedAtUtc: completedAt.toISOString(),
        wallSeconds: (completedAt.getTime() - startedAt.getTime()) / 1000,
        pressureSamples,
        peakAggregateRssBytes,
        peakProcessCount,
        error: resourceError?.message ?? (error instanceof Error ? error.message : String(error)),
      })).catch(() => undefined)
    }
    throw error
  } finally {
    monitoring = false
    if (monitorPromise) await monitorPromise
    for (const child of children) child.kill('SIGTERM')
    await Promise.allSettled(promises)
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    await lock.release()
  }
}

const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage)
    return
  }
  if (options.internalShardIndex !== null) await runInternal(options)
  else await runCoordinator(options)
}

main().catch((error) => {
  process.stderr.write(`Grid commissioning failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
