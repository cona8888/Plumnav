/**
 * Real local multi-process coordinator for the source-present benchmark.
 *
 * Run with:
 *   pnpm benchmark:local -- --profile commissioning --output /private/tmp/plumenav-local-commission-run --workers 4
 */
import { spawn, type ChildProcess } from 'node:child_process'
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
import { fileURLToPath } from 'node:url'
import {
  createManifest,
  executeHeadlessBenchmarkShard,
  finalizeHeadlessBenchmark,
  prepareHeadlessBenchmark,
  selectManifestShard,
  type HeadlessShardResult,
  type ProfileName,
} from './headless-benchmark'

type CliOptions = {
  profile: ProfileName
  outputDirectory: string
  requestedWorkers: number
  dryRun: boolean
  resume: boolean
  recoverLock: boolean
  internalShardIndex: number | null
  internalShardCount: number | null
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const thisScript = fileURLToPath(import.meta.url)
const viteNodeCli = fileURLToPath(new URL('../node_modules/vite-node/vite-node.mjs', import.meta.url))
const LOCK_NAME = '.plumenav-coordinator.lock'
const WORKER_TOKEN_ENV = 'PLUMENAV_COORDINATOR_TOKEN'

type CoordinatorLockRecord = {
  schemaVersion: 'plumenav-coordinator-lock-v2'
  token: string
  pid: number
  hostname: string
  startedAtUtc: string
  recoveredLock?: {
    pid: number
    hostname: string
    startedAtUtc: string
  }
}

const stableJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const usage = `PlumeNav local sharded benchmark

Usage:
  pnpm benchmark:local -- [options]

Options:
  --profile <commissioning|m5-development>  Development-only worker profile (default: commissioning)
  --output <directory>       Output directory (default: benchmark-output/local-<profile>)
  --workers <integer>        Worker processes (default: 1)
  --dry-run                  Freeze and validate design without running cells
  --resume                   Reuse only cryptographically and semantically verified cells
  --recover-lock             Recover only a dead same-host coordinator lock
  --help                     Show this help
`

const requiredValue = (args: string[], index: number, flag: string) => {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

const parseArguments = (args: string[]): CliOptions & { help: boolean } => {
  let profile: ProfileName = 'commissioning'
  let output: string | null = null
  let requestedWorkers = 1
  let dryRun = false
  let resume = false
  let recoverLock = false
  let help = false
  let internalShardIndex: number | null = null
  let internalShardCount: number | null = null

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '--profile') {
      const value = requiredValue(args, index, argument)
      if (value !== 'commissioning' && value !== 'm5-development') {
        throw new Error(
          `The local coordinator permits only development-only commissioning or M5 profiles; received ${value}`,
        )
      }
      profile = value
      index += 1
    } else if (argument === '--output') {
      output = requiredValue(args, index, argument)
      index += 1
    } else if (argument === '--workers') {
      requestedWorkers = Number(requiredValue(args, index, argument))
      index += 1
    } else if (argument === '--dry-run') {
      dryRun = true
    } else if (argument === '--resume') {
      resume = true
    } else if (argument === '--recover-lock') {
      recoverLock = true
    } else if (argument === '--help' || argument === '-h') {
      help = true
    } else if (argument === '--internal-shard-index') {
      internalShardIndex = Number(requiredValue(args, index, argument))
      index += 1
    } else if (argument === '--internal-shard-count') {
      internalShardCount = Number(requiredValue(args, index, argument))
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (!Number.isInteger(requestedWorkers) || requestedWorkers < 1) {
    throw new Error(`--workers must be a positive integer, received ${requestedWorkers}`)
  }
  const internalCount = [internalShardIndex, internalShardCount].filter(
    (value) => value !== null,
  ).length
  if (internalCount === 1) throw new Error('Internal shard index and count must be supplied together')
  return {
    profile,
    outputDirectory: resolve(output ?? `benchmark-output/local-${profile}`),
    requestedWorkers,
    dryRun,
    resume,
    recoverLock,
    internalShardIndex,
    internalShardCount,
    help,
  }
}

const pathIsInside = (candidate: string, parent: string) => {
  const pathFromParent = relative(parent, candidate)
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !parse(pathFromParent).root)
}

const realTarget = async (target: string) => {
  let existing = target
  while (true) {
    try {
      const resolvedExisting = await realpath(existing)
      return resolve(resolvedExisting, relative(existing, target))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) return target
      existing = parent
    }
  }
}

const assertSafeOutputDirectory = async (outputDirectory: string) => {
  const absolute = resolve(outputDirectory)
  const resolvedTarget = await realTarget(absolute)
  const exactForbidden = [parse(absolute).root, resolve(homedir()), resolve(projectRoot)]
  if (exactForbidden.includes(absolute) || exactForbidden.includes(resolvedTarget)) {
    throw new Error(`Refusing unsafe benchmark output directory: ${absolute}`)
  }
  const protectedRoots = [
    join(projectRoot, 'research', 'evidence'),
    join(projectRoot, 'research', 'protocols'),
    join(projectRoot, 'release'),
    join(projectRoot, 'outputs'),
  ]
  for (const protectedRoot of protectedRoots) {
    const resolvedProtectedRoot = await realTarget(protectedRoot)
    if (
      pathIsInside(absolute, protectedRoot) ||
      pathIsInside(resolvedTarget, resolvedProtectedRoot)
    ) {
      throw new Error(`Benchmark output may not be written inside protected path ${protectedRoot}`)
    }
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

const assertOutputMode = async (options: CliOptions) => {
  if (!(await exists(options.outputDirectory))) return
  const entries = (await readdir(options.outputDirectory)).filter((entry) => entry !== LOCK_NAME)
  if (entries.length === 0) return
  if (!options.resume) {
    throw new Error('Output directory is not empty; choose a fresh directory or pass --resume')
  }
  if (!entries.includes('manifest.json')) {
    throw new Error('Refusing --resume in a non-empty directory without a benchmark manifest')
  }
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

const readCoordinatorLock = async (lockPath: string) => {
  const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<CoordinatorLockRecord>
  if (
    parsed.schemaVersion !== 'plumenav-coordinator-lock-v2' ||
    typeof parsed.token !== 'string' || parsed.token.length === 0 ||
    !Number.isInteger(parsed.pid) || (parsed.pid ?? 0) < 1 ||
    typeof parsed.hostname !== 'string' ||
    typeof parsed.startedAtUtc !== 'string'
  ) {
    throw new Error('Coordinator lock is malformed; refusing automatic recovery')
  }
  return parsed as CoordinatorLockRecord
}

const processIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const acquireCoordinatorLock = async (options: CliOptions) => {
  await mkdir(options.outputDirectory, { recursive: true })
  const lockPath = join(options.outputDirectory, LOCK_NAME)
  let recoveredLock: CoordinatorLockRecord | undefined
  if (options.recoverLock && await exists(lockPath)) {
    const recorded = await readCoordinatorLock(lockPath)
    if (recorded.hostname !== hostname()) {
      throw new Error(
        `Lock belongs to host ${recorded.hostname}; cross-host recovery is not automatic`,
      )
    }
    if (processIsAlive(recorded.pid)) {
      throw new Error(`Coordinator PID ${recorded.pid} is still alive; refusing to steal its lock`)
    }
    const recoveredPath = `${lockPath}.recovering-${process.pid}-${randomUUID()}`
    await rename(lockPath, recoveredPath)
    recoveredLock = recorded
    await unlink(recoveredPath)
  }
  const token = randomUUID()
  let handle
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const owner = await readFile(lockPath, 'utf8').catch(() => 'unreadable lock')
      throw new Error(`Another coordinator owns this output directory. Lock: ${owner.trim()}`)
    }
    throw error
  }
  const record: CoordinatorLockRecord = {
    schemaVersion: 'plumenav-coordinator-lock-v2',
    token,
    pid: process.pid,
    hostname: hostname(),
    startedAtUtc: new Date().toISOString(),
    ...(recoveredLock
      ? {
          recoveredLock: {
            pid: recoveredLock.pid,
            hostname: recoveredLock.hostname,
            startedAtUtc: recoveredLock.startedAtUtc,
          },
        }
      : {}),
  }
  try {
    await handle.writeFile(stableJson(record))
  } finally {
    await handle.close()
  }
  return {
    path: lockPath,
    token,
    release: async () => {
      try {
        const current = await readCoordinatorLock(lockPath)
        if (current.token === token) await unlink(lockPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
  }
}

const assertAuthorizedInternalWorker = async (options: CliOptions) => {
  const suppliedToken = process.env[WORKER_TOKEN_ENV]
  if (!suppliedToken) throw new Error('Internal shard mode requires coordinator authorization')
  const lock = await readCoordinatorLock(join(options.outputDirectory, LOCK_NAME))
  if (
    lock.token !== suppliedToken ||
    lock.hostname !== hostname() ||
    lock.pid !== process.ppid ||
    !processIsAlive(lock.pid)
  ) {
    throw new Error('Internal shard authorization does not match the active coordinator lock')
  }
}

const streamLines = (
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
) => {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) if (line) onLine(line)
  })
  stream.on('end', () => {
    if (pending) onLine(pending)
  })
}

const runChildShard = (
  options: CliOptions,
  shardIndex: number,
  shardCount: number,
  children: Set<ChildProcess>,
  coordinatorToken: string,
) => new Promise<HeadlessShardResult>((resolvePromise, rejectPromise) => {
  const child = spawn(process.execPath, [
    viteNodeCli,
    thisScript,
    '--profile',
    options.profile,
    '--output',
    options.outputDirectory,
    '--internal-shard-index',
    String(shardIndex),
    '--internal-shard-count',
    String(shardCount),
  ], {
    cwd: projectRoot,
    env: { ...process.env, [WORKER_TOKEN_ENV]: coordinatorToken },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  let finalResult: HeadlessShardResult | null = null
  streamLines(child.stdout!, (line) => {
    try {
      const event = JSON.parse(line) as {
        event?: string
        cellId?: string
        status?: string
        result?: HeadlessShardResult
      }
      if (event.event === 'progress') {
        process.stdout.write(`worker ${shardIndex + 1}/${shardCount}: ${event.cellId} ${event.status}\n`)
      } else if (event.event === 'complete' && event.result) {
        finalResult = event.result
      } else {
        process.stdout.write(`worker ${shardIndex + 1}/${shardCount}: ${line}\n`)
      }
    } catch {
      process.stdout.write(`worker ${shardIndex + 1}/${shardCount}: ${line}\n`)
    }
  })
  streamLines(child.stderr!, (line) => {
    process.stderr.write(`worker ${shardIndex + 1}/${shardCount}: ${line}\n`)
  })
  child.once('error', (error) => {
    children.delete(child)
    rejectPromise(error)
  })
  // `close` waits for stdout/stderr to drain, so the final structured result
  // cannot be lost behind an earlier process `exit` event.
  child.once('close', (code, signal) => {
    children.delete(child)
    if (code === 0 && finalResult) resolvePromise(finalResult)
    else rejectPromise(new Error(
      `Worker ${shardIndex} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
    ))
  })
})

const runInternalShard = async (options: CliOptions) => {
  await assertAuthorizedInternalWorker(options)
  const shardIndex = options.internalShardIndex!
  const shardCount = options.internalShardCount!
  const result = await executeHeadlessBenchmarkShard({
    profile: options.profile,
    outputDirectory: options.outputDirectory,
    shardIndex,
    shardCount,
    onProgress: (progress) => {
      process.stdout.write(`${JSON.stringify({ event: 'progress', ...progress })}\n`)
    },
  })
  process.stdout.write(`${JSON.stringify({ event: 'complete', result })}\n`)
}

const runCoordinator = async (options: CliOptions) => {
  const plannedCells = createManifest(options.profile).cells.length
  const maximumWorkers = Math.min(plannedCells, availableParallelism())
  if (options.requestedWorkers > maximumWorkers) {
    throw new Error(
      `Requested ${options.requestedWorkers} workers; this run permits at most ${maximumWorkers}`,
    )
  }
  await assertSafeOutputDirectory(options.outputDirectory)
  await assertOutputMode(options)
  const lock = await acquireCoordinatorLock(options)
  const children = new Set<ChildProcess>()
  const abortController = new AbortController()
  let interruptedSignal: NodeJS.Signals | null = null
  let shardPromises: Array<Promise<HeadlessShardResult>> = []
  const interrupt = (signal: NodeJS.Signals) => {
    interruptedSignal = signal
    abortController.abort(new Error(`Coordinator interrupted by ${signal}`))
    for (const child of children) child.kill('SIGTERM')
  }
  const throwIfInterrupted = () => {
    if (abortController.signal.aborted) {
      throw abortController.signal.reason instanceof Error
        ? abortController.signal.reason
        : new Error(`Coordinator interrupted by ${interruptedSignal ?? 'signal'}`)
    }
  }
  const interruptWithSigint = () => interrupt('SIGINT')
  const interruptWithSigterm = () => interrupt('SIGTERM')
  process.on('SIGINT', interruptWithSigint)
  process.on('SIGTERM', interruptWithSigterm)
  const sessionId = randomUUID()
  const startedAt = new Date()
  let executionPath: string | null = null
  let execution: Record<string, unknown> | null = null
  try {
    const context = await prepareHeadlessBenchmark({
      profile: options.profile,
      outputDirectory: options.outputDirectory,
      resume: options.resume,
    })
    throwIfInterrupted()
    const workerCount = options.requestedWorkers
    const assignments = Array.from({ length: workerCount }, (_, shardIndex) => ({
      shardIndex,
      cellIds: selectManifestShard(context.manifest.cells, shardIndex, workerCount)
        .map((cell) => cell.id),
    }))
    await mkdir(join(options.outputDirectory, 'executions'), { recursive: true })
    executionPath = join(options.outputDirectory, 'executions', `${sessionId}.json`)
    execution = {
      schemaVersion: 'headless-local-execution-v1',
      sessionId,
      status: options.dryRun ? 'dry-run' : 'running',
      startedAtUtc: startedAt.toISOString(),
      profile: options.profile,
      outputDirectory: options.outputDirectory,
      manifestSha256: context.manifestSha256,
      implementationSha256: context.implementationSha256,
      runtime: context.runtime,
      runtimeFingerprint: context.runtimeFingerprint,
      invocation: process.argv.slice(2),
      requestedWorkers: options.requestedWorkers,
      actualWorkers: options.dryRun ? 0 : workerCount,
      resume: options.resume,
      assignments: options.dryRun ? [] : assignments,
    }
    await atomicWrite(executionPath, stableJson(execution))
    throwIfInterrupted()
    if (options.dryRun) {
      process.stdout.write(`${stableJson({
        status: 'dry-run',
        outputDirectory: options.outputDirectory,
        manifestSha256: context.manifestSha256,
        plannedCells: context.manifest.cells.length,
        plannedSimulationRuns: context.plannedSimulationRuns,
      })}`)
      return
    }

    shardPromises = Array.from({ length: workerCount }, (_, shardIndex) =>
      runChildShard(options, shardIndex, workerCount, children, lock.token))
    const shardResults = await Promise.all(shardPromises)
    throwIfInterrupted()
    const finalized = await finalizeHeadlessBenchmark(
      options.profile,
      options.outputDirectory,
      abortController.signal,
    )
    throwIfInterrupted()
    const completedAt = new Date()
    execution = {
      ...execution,
      status: 'complete',
      completedAtUtc: completedAt.toISOString(),
      wallSeconds: (completedAt.getTime() - startedAt.getTime()) / 1000,
      shardResults,
      scientificResultsSha256: finalized.scientificResultsSha256,
      rawResultsSha256: finalized.rawResultsSha256,
      analysisSha256: finalized.analysisSha256,
      comparisonsSha256: finalized.comparisonsSha256,
    }
    await atomicWrite(executionPath, stableJson(execution))
    process.stdout.write(stableJson({
      status: 'complete',
      outputDirectory: options.outputDirectory,
      workers: workerCount,
      wallSeconds: execution.wallSeconds,
      completedCells: shardResults.reduce((sum, result) => sum + result.completedCells, 0),
      skippedCells: shardResults.reduce((sum, result) => sum + result.skippedCells, 0),
      manifestSha256: finalized.manifestSha256,
      scientificResultsSha256: finalized.scientificResultsSha256,
      rawResultsSha256: finalized.rawResultsSha256,
    }))
  } catch (error) {
    for (const child of children) child.kill('SIGTERM')
    await Promise.allSettled(shardPromises)
    if (execution && executionPath) {
      const failedAt = new Date()
      await atomicWrite(executionPath, stableJson({
        ...execution,
        status: interruptedSignal ? 'interrupted' : 'failed',
        completedAtUtc: failedAt.toISOString(),
        wallSeconds: (failedAt.getTime() - startedAt.getTime()) / 1000,
        error: error instanceof Error ? error.message : String(error),
      })).catch(() => undefined)
    }
    throw error
  } finally {
    process.off('SIGINT', interruptWithSigint)
    process.off('SIGTERM', interruptWithSigterm)
    for (const child of children) child.kill('SIGTERM')
    await Promise.allSettled(shardPromises)
    await lock.release()
  }
}

const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage)
    return
  }
  if (options.internalShardIndex !== null) await runInternalShard(options)
  else await runCoordinator(options)
}

main().catch((error) => {
  process.stderr.write(`Local benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
