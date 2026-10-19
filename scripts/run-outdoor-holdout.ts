import {fork} from 'node:child_process'
import type {ChildProcess} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync, mkdirSync, appendFileSync} from 'node:fs'
import {join, dirname, resolve} from 'node:path'
import {gzipSync} from 'node:zlib'
import {fileURLToPath} from 'node:url'
import {arch, platform, cpus, totalmem, freemem} from 'node:os'
import {DESIGN, makeTrace, HalfspaceField} from './lib/outdoor-detectability'
import {HOLDOUT, holdoutSpecs} from './lib/outdoor-holdout-design'

const PILOT = 'research/results/outdoor_detectability_pilot_v2_2026-09-22'
const files = ['scripts/lib/outdoor-holdout-design.ts', 'scripts/run-outdoor-holdout.ts',
  'scripts/audit-outdoor-holdout.py', 'scripts/lib/outdoor_holdout_statistics.py',
  'scripts/test-outdoor-holdout.ts', 'scripts/test-outdoor-holdout.py',
  'research/protocols/outdoor_detectability_holdout_execution_v1_2026-09-22.md',
  'outputs/run-outdoor-holdout.mjs', 'outputs/outdoor-holdout.meta.json']
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const sha = (p: string) => hash(readFileSync(p))
function checkPilot() {
  const closure = read(join(PILOT, 'closure.json')), manifest = read(join(PILOT, 'manifest.json'))
  if (!closure.accepted || closure.manifestSha256 !== sha(join(PILOT, 'manifest.json')) ||
    closure.auditSha256 !== sha(join(PILOT, 'audit.json'))) throw Error('Pilot closure invalid')
  for (const row of [...manifest.sourceHashes, ...manifest.frozenStage2i.hashes])
    if (sha(row.file) !== row.sha256) throw Error(`Frozen input changed: ${row.file}`)
  return {directory: PILOT, closureSha256: sha(join(PILOT, 'closure.json')), manifest}
}
type Receipt = {index: number; file: string; sha256: string; bytes: number; startedMs: number; endedMs: number;
  seconds: number; pid: number; userCpuMicroseconds: number; systemCpuMicroseconds: number; rssBytes: number}
const [flag, argument, outputArg, smokeArg] = process.argv.slice(2)
if (flag === '--worker') {
  if (!argument || outputArg) throw Error('Worker argument mismatch')
  const directory = argument, manifest = read(join(directory, 'manifest.json'))
  process.on('message', (message: {index?: number; stop?: boolean}) => {
    if (message.stop) {process.disconnect!(); return}
    const index = message.index!
    if (!Number.isInteger(index) || !manifest.specs[index]) throw Error('Unknown worker index')
    const startedMs = Date.now(), cpu = process.cpuUsage(), trace = makeTrace(manifest.specs[index])
    const field = new HalfspaceField(trace.fieldSettings)
    const sourceProbes = HOLDOUT.sourceProbeTimesSeconds.flatMap(t => HOLDOUT.sourceProbeOffsetsMetres.map(([dx, dy]) => {
      const point = {x: trace.world.source.x + dx, y: trace.world.source.y + dy, z: DESIGN.inletHeightMetres}
      return {t, ...point, referenceExcessPpm: trace.ppmPerKgM3 * field.concentrationAt(point, DESIGN.sourceAgeSeconds + t)}
    }))
    const name = `trace-${String(index).padStart(3, '0')}`, bytes = gzipSync(JSON.stringify({...trace, sourceProbes}))
    writeFileSync(join(directory, `${name}.json.gz`), bytes, {flag: 'wx'})
    const used = process.cpuUsage(cpu), endedMs = Date.now()
    const receipt: Receipt = {index, file: `${name}.json.gz`, sha256: hash(bytes), bytes: bytes.length,
      startedMs, endedMs, seconds: (endedMs - startedMs) / 1000, pid: process.pid,
      userCpuMicroseconds: used.user, systemCpuMicroseconds: used.system, rssBytes: process.memoryUsage().rss}
    writeFileSync(join(directory, `${name}.receipt.json`), JSON.stringify(receipt) + '\n', {flag: 'wx'})
    process.send!({receipt})
  })
  process.send!({ready: true, pid: process.pid})
} else {
  if (flag !== '--mode' || !['smoke', 'campaign'].includes(argument ?? '') || !outputArg ||
    (argument === 'campaign' ? !smokeArg : !!smokeArg)) throw Error('Usage: --mode smoke NEW_DIRECTORY | --mode campaign NEW_DIRECTORY ACCEPTED_SMOKE_DIRECTORY')
  const mode = argument as 'smoke' | 'campaign', output = resolve(outputArg), pilot = checkPilot()
  const sourceHashes = [...pilot.manifest.sourceHashes, ...files.map(file => ({file, sha256: sha(file)}))]
  let smokeEvidence = null
  if (mode === 'campaign') {
    const smoke = read(join(smokeArg!, 'audit.json'))
    const smokeManifest = read(join(smokeArg!, 'manifest.json'))
    if (!smoke.accepted || smoke.mode !== 'smoke' || !smoke.compatibilityPassed ||
      smoke.maxConcurrentWorkers !== 4 || smoke.manifestSha256 !== sha(join(smokeArg!, 'manifest.json')) ||
      JSON.stringify(smokeManifest.sourceHashes) !== JSON.stringify(sourceHashes)) throw Error('Same-source four-worker smoke not accepted')
    smokeEvidence = {directory: resolve(smokeArg!), auditSha256: sha(join(smokeArg!, 'audit.json'))}
  }
  mkdirSync(output)
  const write = (name: string, data: unknown) => writeFileSync(join(output, name), JSON.stringify(data) + '\n', {flag: 'wx'})
  for (const row of sourceHashes) {
    const target = join(output, 'source-snapshot', row.file)
    mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, readFileSync(row.file), {flag: 'wx'})
  }
  const specs = holdoutSpecs(mode), startedMs = Date.now()
  const manifest = {schemaVersion: HOLDOUT.version, mode, createdAt: new Date(startedMs).toISOString(),
    design: DESIGN, holdout: HOLDOUT, specs, sourceHashes, pilot, smokeEvidence,
    runtime: {node: process.version, arch: arch(), platform: platform(), cpus: cpus().length,
      totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), supervisorPid: process.pid},
    maxRuntimeSeconds: HOLDOUT.maxRuntimeSeconds, workers: HOLDOUT.workers}
  write('manifest.json', manifest)
  const children: ChildProcess[] = [], receipts: Receipt[] = [], exits: {pid: number; code: number}[] = []
  const event = (data: object) => appendFileSync(join(output, 'execution-events.jsonl'), JSON.stringify({at: Date.now(), ...data}) + '\n')
  let next = 0, failed = false
  try {
    await new Promise<void>((accept, reject) => {
      const abort = (error: Error) => {
        if (failed) return
        failed = true; clearTimeout(timeout)
        for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
        reject(error)
      }
      const timeout = setTimeout(() => abort(Error('One-hour local runtime cap exceeded')), HOLDOUT.maxRuntimeSeconds * 1000)
      const assign = (child: ChildProcess) => {
        if (failed) return
        if (next < specs.length) {const index = next++; event({assigned: index, pid: child.pid}); child.send({index})}
        else child.send({stop: true})
      }
      for (let i = 0; i < HOLDOUT.workers; i++) {
        const child = fork(fileURLToPath(import.meta.url), ['--worker', output], {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1'},
        })
        children.push(child)
        child.stderr!.on('data', (chunk: Buffer) => appendFileSync(join(output, `worker-${i}.stderr.log`), chunk))
        child.on('error', abort)
        child.on('message', (message: {ready?: boolean; pid?: number; receipt?: Receipt}) => {
          if (message.ready) {event({started: true, worker: i, pid: message.pid}); assign(child)}
          else if (message.receipt) {
            receipts.push(message.receipt); event({completed: message.receipt.index, pid: child.pid})
            if (receipts.length % 16 === 0 || receipts.length === specs.length)
              console.log(JSON.stringify({finished: receipts.length, expected: specs.length, seconds: (Date.now() - startedMs)/1000}))
            assign(child)
          } else abort(Error('Unknown worker message'))
        })
        child.on('exit', (code, signal) => {
          event({exited: true, pid: child.pid, code, signal})
          if (code !== 0) {abort(Error(`Worker ${child.pid} exited ${code}/${signal}`)); return}
          exits.push({pid: child.pid!, code})
          if (exits.length === HOLDOUT.workers) {
            clearTimeout(timeout)
            if (receipts.length !== specs.length) reject(Error('Incomplete case set')); else accept()
          }
        })
      }
    })
    receipts.sort((a, b) => a.index - b.index)
    if (receipts.some((r, i) => r.index !== i)) throw Error('Duplicate or missing case index')
    for (const row of sourceHashes) if (sha(row.file) !== row.sha256) throw Error('Source changed during run')
    checkPilot()
    write('execution-complete.json', {executionComplete: true, independentlyAccepted: false,
      manifestSha256: sha(join(output, 'manifest.json')), files: receipts, exits,
      seconds: (Date.now() - startedMs)/1000, eventLogSha256: sha(join(output, 'execution-events.jsonl'))})
    console.log(JSON.stringify({executionComplete: true, independentlyAccepted: false, mode, output, seconds: (Date.now()-startedMs)/1000}))
  } catch (error) {write('failure.json', {failed: true, diagnosticOnly: true, error: String(error)}); throw error}
}
