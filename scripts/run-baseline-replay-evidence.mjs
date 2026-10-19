/**
 * Execute all 18 development comparator replays and archive exact evidence.
 *
 * A successful runner means the archive is complete and internally valid. It
 * does not mean every scientific assertion passed: pass/fail/not-executable is
 * preserved separately from evidence tier and from canonical promotion.
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BASELINE_REPLAY_INDEX_SCHEMA_VERSION,
  EXPECTED_BASELINE_REPLAY_FIXTURE_IDS,
  buildBundleAssertions,
  collectReplayProvenance,
  contentSha256,
  createFixtureResult,
  loadCanonicalJsonArtifact,
  loadCapturedFixture,
  semanticSha256,
  sha256Bytes,
  stableReplayJson,
  validateProtocolCatalog,
  validateVitestFixtureReport,
} from './baseline-replay-evidence-lib.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_REPOSITORY_ROOT = resolve(scriptDirectory, '..')
export const DEFAULT_BASELINE_REPLAY_OUTPUT_DIRECTORY = join(
  DEFAULT_REPOSITORY_ROOT,
  'research/evidence/baseline_replay',
)

const fixtureFiles = Object.freeze([
  'scripts/baseline-replay-reactive.test.ts',
  'scripts/baseline-replay-bayesian.test.ts',
])

const spawnAndWait = (executable, arguments_, options) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, options)
    const stdout = []
    const stderr = []
    child.stdout?.on('data', (chunk) => {
      stdout.push(Buffer.from(chunk))
      process.stdout.write(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr.push(Buffer.from(chunk))
      process.stderr.write(chunk)
    })
    child.once('error', reject)
    child.once('close', (code, signal) => resolvePromise({
      code,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    }))
  })

export const executeBaselineReplayHarness = async ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  captureDirectory,
  reportPath,
  runId,
}) => {
  await mkdir(captureDirectory, { recursive: true })
  const executable = process.execPath
  const arguments_ = [
    join(repositoryRoot, 'node_modules/vitest/vitest.mjs'),
    '--config',
    join(repositoryRoot, 'scripts/vitest.headless.config.ts'),
    'run',
    ...fixtureFiles.map((path) => join(repositoryRoot, path)),
    '--reporter=json',
    `--outputFile=${reportPath}`,
  ]
  const result = await spawnAndWait(
    executable,
    arguments_,
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        BASELINE_REPLAY_CAPTURE_DIR: captureDirectory,
        BASELINE_REPLAY_RUN_ID: runId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  return {
    ...result,
    invocation: {
      executable,
      arguments: arguments_,
      cwd: repositoryRoot,
      environment: {
        BASELINE_REPLAY_CAPTURE_DIR: captureDirectory,
        BASELINE_REPLAY_RUN_ID: runId,
      },
    },
  }
}

const writeAtomic = async (path, bytes) => {
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, bytes)
  await rename(temporaryPath, path)
}

const writeCanonicalArtifact = async (path, value) => {
  const bytes = stableReplayJson(value)
  await writeAtomic(path, bytes)
  return {
    path,
    fileSha256: sha256Bytes(bytes),
    semanticSha256: semanticSha256(value),
    byteLength: Buffer.byteLength(bytes),
  }
}

const writeExactArtifact = async (path, bytes) => {
  const exactBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  await writeAtomic(path, exactBytes)
  const reread = await readFile(path)
  if (!reread.equals(exactBytes)) throw new Error(`Destination verification failed for ${path}`)
  return {
    path,
    fileSha256: sha256Bytes(reread),
    byteLength: reread.byteLength,
  }
}

const provenanceInventories = (provenance) => [
  provenance.implementation,
  provenance.fixtureDefinitions,
  provenance.runner,
  provenance.diagnosticAdapter,
  provenance.protocol,
  provenance.dependencies,
  provenance.executionConfiguration,
]

const readExecutionSourceSnapshot = async (repositoryRoot, provenance) => {
  const byPath = new Map()
  for (const inventory of provenanceInventories(provenance)) {
    for (const descriptor of inventory.files) byPath.set(descriptor.path, descriptor)
  }
  const snapshot = []
  for (const [path, descriptor] of [...byPath.entries()].sort(([first], [second]) =>
    first < second ? -1 : first > second ? 1 : 0)) {
    const bytes = await readFile(join(repositoryRoot, path))
    const digest = sha256Bytes(bytes)
    if (digest !== descriptor.sha256 || bytes.byteLength !== descriptor.byteLength) {
      throw new Error(`Execution source changed while snapshotting ${path}`)
    }
    snapshot.push({ path, bytes, sha256: digest, byteLength: bytes.byteLength })
  }
  return snapshot
}

const resultWithDigest = (result) => ({
  ...result,
  resultSemanticSha256: contentSha256(result, ['resultSemanticSha256']),
})

const countFixtureVerdicts = (results) => results.reduce(
  (counts, result) => {
    counts[result.summary.fixtureVerdict] += 1
    return counts
  },
  { pass: 0, fail: 0, 'not-executable': 0 },
)

const countAssertionVerdicts = (results) => results
  .flatMap((result) => result.assertions)
  .reduce(
    (counts, assertion) => {
      counts[assertion.status] += 1
      return counts
    },
    { pass: 0, fail: 0, 'not-executable': 0 },
  )

const markdownSummary = (index, results, bundleAssertions) => {
  const rows = results.map((result) =>
    `| ${result.fixture.fixtureId} | ${result.fixture.algorithmId} | ${result.summary.fixtureVerdict} | ${result.summary.requiredPass} | ${result.summary.requiredFail} | ${result.summary.requiredNotExecutable} |`,
  )
  const commonRows = bundleAssertions.assertions.map((assertion) =>
    `| ${assertion.id} | ${assertion.status} | ${assertion.reasonCode ?? '—'} |`,
  )
  return `${[
    '# Baseline comparator replay evidence',
    '',
    `**Index semantic SHA-256:** \`${index.indexSemanticSha256}\`  `,
    `**Generated:** ${index.generatedAtUtc}  `,
    '**Evidence tier:** development behaviour only',
    '',
    index.claimBoundary,
    '',
    `The 18 evidence harnesses executed successfully. Their 54 scientific assertions yielded **${index.summary.fixtureAssertions.pass} pass, ${index.summary.fixtureAssertions.fail} fail, and ${index.summary.fixtureAssertions['not-executable']} not executable**. This is not a performance benchmark and no algorithm was promoted to a canonical reproduction.`,
    '',
    '| Fixture | Controller | Verdict | Passed | Failed | Not executable |',
    '|---|---|---:|---:|---:|---:|',
    ...rows,
    '',
    '## Bundle-level contract',
    '',
    '| Assertion | Status | Reason |',
    '|---|---|---|',
    ...commonRows,
    '',
    '## Interpretation',
    '',
    '- A fixture `pass` establishes only the stated checked-in development contract.',
    '- A `fail` is an executed counterexample; it is not a missing prerequisite.',
    '- `not-executable` identifies an unavailable declared state/reference/terminal trace and is never counted as a pass.',
    '- The 54 fixture assertions are produced by the hashed local fixture harness and are not independently recomputed as a complete assertion set from the archive.',
    '- The six bundle assertions are recomputed from archived artifacts by a separately versioned explicit evaluator; this is independent software-contract evaluation, not a canonical-source oracle.',
    '- No canonical-source oracle was executed.',
    '- No localization error, success rate, runtime ranking, superiority result, field validation, or buried-leak transfer result was produced.',
    '',
  ].join('\n')}\n`
}

export const buildBaselineReplayEvidenceArchive = async ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  captureDirectory,
  vitestReport,
  execution,
  provenance,
  sourceSnapshot = [],
  generatedAtUtc = new Date().toISOString(),
}) => {
  if (execution.code !== 0 || execution.signal !== null) {
    throw new Error(
      `Replay harness process was unsuccessful (code=${execution.code}, signal=${execution.signal})`,
    )
  }
  const protocolPath = join(
    repositoryRoot,
    'research/protocols/baseline_replay_fixture_protocol.json',
  )
  const protocol = JSON.parse(await readFile(protocolPath, 'utf8'))
  const catalogue = validateProtocolCatalog(protocol)
  const vitestResults = validateVitestFixtureReport(vitestReport)
  const capturedFixtures = []
  for (const fixtureId of EXPECTED_BASELINE_REPLAY_FIXTURE_IDS) {
    capturedFixtures.push(await loadCapturedFixture({
      captureDirectory,
      fixtureId,
      specification: catalogue.fixtures.get(fixtureId),
    }))
  }
  if (capturedFixtures.some((fixture) => fixture.runId !== execution.runId)) {
    throw new Error('One or more captured fixtures are not bound to the executed replay run ID')
  }
  const results = capturedFixtures.map((captured) => createFixtureResult({
    captured,
    provenance,
    vitestResult: vitestResults.get(captured.fixtureId),
  }))
  const bundleAssertions = buildBundleAssertions(
    capturedFixtures,
    catalogue.commonAssertions,
    catalogue.informationMatrix,
  )
  const fixtureVerdicts = countFixtureVerdicts(results)
  const fixtureAssertions = countAssertionVerdicts(results)
  const harnessStatuses = [...vitestResults.values()].reduce(
    (counts, result) => {
      const status = result.status === 'passed' ? 'passed' : 'failed'
      counts[status] += 1
      return counts
    },
    { passed: 0, failed: 0 },
  )
  const indexCore = {
    schemaVersion: BASELINE_REPLAY_INDEX_SCHEMA_VERSION,
    generatedAtUtc,
    partition: 'development',
    evidenceTier: 'development-behavior',
    claimLabel: 'development-behavior-only',
    claimBoundary:
      'This archive validates only declared behavior of the checked-in development controllers. It contains no canonical-equivalence, algorithm-superiority, safety-performance, field-validity, or application-transfer result.',
    canonicalPromotionAwarded: false,
    performanceOutcomesExecuted: false,
    assertionEvaluation: {
      verdictProducer: 'split-fixture-harness-and-explicit-artifact-evaluator',
      exactInputsAndOutputsArchived: true,
      independentlyRecomputedFromArchive: false,
      fixtureAssertions: {
        verdictProducer: 'versioned-local-fixture-harness',
        assertionCount: 54,
        independentlyRecomputedFromArchive: false,
      },
      bundleAssertions: {
        verdictProducer: 'separately-versioned-explicit-artifact-evaluator',
        assertionCount: 6,
        independentlyRecomputedFromArchive: true,
        evaluatorCasesExplicitlyDeclared: true,
        heldOutTruthContentBound: true,
        terminalEvaluatorOutputMaterialized: true,
      },
      canonicalSourceOracleExecuted: false,
      claimConsequence:
        'Fixture and bundle verdicts are development software-contract checks and cannot promote a comparator or support a performance claim.',
    },
    execution: {
      runId: execution.runId,
      exitCode: execution.code,
      signal: execution.signal,
      reportSuccess: vitestReport.success,
      preExecutionProvenanceSha256: execution.preExecutionProvenanceSha256,
      postExecutionProvenanceSha256: execution.postExecutionProvenanceSha256,
      sourceStableAcrossExecution: true,
    },
    protocol: provenance.protocol,
    provenance,
    summary: {
      expectedFixtures: 18,
      expectedFixtureAssertions: 54,
      expectedBundleAssertions: 6,
      harnessStatuses,
      fixtureVerdicts,
      fixtureAssertions,
      bundleAssertionVerdict: bundleAssertions.summary,
    },
  }
  return {
    indexCore,
    results,
    bundleAssertions,
    capturedFixtures,
    provenance,
    sourceSnapshot,
    vitestReport,
    execution,
  }
}

export const writeBaselineReplayEvidenceArchive = async ({
  archive,
  outputDirectory = DEFAULT_BASELINE_REPLAY_OUTPUT_DIRECTORY,
}) => {
  const artifactsDirectory = join(outputDirectory, 'artifacts')
  const resultsDirectory = join(outputDirectory, 'results')
  await mkdir(artifactsDirectory, { recursive: true })
  await mkdir(resultsDirectory, { recursive: true })

  for (const captured of archive.capturedFixtures) {
    for (const [suffix, artifact] of Object.entries(captured.artifacts)) {
      if (artifact === null) continue
      const written = await writeExactArtifact(
        join(artifactsDirectory, `${captured.fixtureId}.${suffix}.json`),
        artifact.bytes,
      )
      if (written.fileSha256 !== artifact.fileSha256 ||
          written.byteLength !== artifact.byteLength) {
        throw new Error(`Captured artifact changed before archive write: ${captured.fixtureId}.${suffix}`)
      }
    }
  }

  const sourceSnapshotDescriptors = []
  for (const source of archive.sourceSnapshot) {
    const relativePath = `source-snapshot/${source.path}`
    const destination = join(outputDirectory, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    const written = await writeExactArtifact(destination, source.bytes)
    if (written.fileSha256 !== source.sha256 || written.byteLength !== source.byteLength) {
      throw new Error(`Source snapshot verification failed for ${source.path}`)
    }
    sourceSnapshotDescriptors.push({
      sourcePath: source.path,
      path: relativePath,
      fileSha256: written.fileSha256,
      byteLength: written.byteLength,
    })
  }

  const vitestReportPath = join(outputDirectory, 'vitest-report.json')
  const vitestReportWritten = await writeCanonicalArtifact(
    vitestReportPath,
    archive.vitestReport,
  )
  const stdoutPath = join(outputDirectory, 'runner-stdout.log')
  const stdoutWritten = await writeExactArtifact(stdoutPath, archive.execution.stdout)
  const stderrPath = join(outputDirectory, 'runner-stderr.log')
  const stderrWritten = await writeExactArtifact(stderrPath, archive.execution.stderr)
  const executionDocument = {
    schemaVersion: 'gsl-baseline-replay-execution-v1',
    runId: archive.execution.runId,
    invocation: archive.execution.invocation,
    exitCode: archive.execution.code,
    signal: archive.execution.signal,
    reportSuccess: archive.vitestReport.success,
    preExecutionProvenanceSha256: archive.execution.preExecutionProvenanceSha256,
    postExecutionProvenanceSha256: archive.execution.postExecutionProvenanceSha256,
    sourceStableAcrossExecution: true,
    logs: {
      stdout: {
        path: 'runner-stdout.log',
        fileSha256: stdoutWritten.fileSha256,
        byteLength: stdoutWritten.byteLength,
      },
      stderr: {
        path: 'runner-stderr.log',
        fileSha256: stderrWritten.fileSha256,
        byteLength: stderrWritten.byteLength,
      },
    },
  }
  const executionPath = join(outputDirectory, 'execution.json')
  const executionWritten = await writeCanonicalArtifact(executionPath, executionDocument)

  const provenancePath = join(outputDirectory, 'provenance.json')
  const provenanceWritten = await writeCanonicalArtifact(provenancePath, archive.provenance)
  const bundleAssertionsDocument = {
    schemaVersion: 'gsl-baseline-replay-bundle-assertions-v1',
    scope: 'one complete 18-fixture development evidence bundle',
    assertions: archive.bundleAssertions.assertions,
    summary: archive.bundleAssertions.summary,
  }
  const bundleAssertionsPath = join(outputDirectory, 'bundle-assertions.json')
  const bundleAssertionsWritten = await writeCanonicalArtifact(
    bundleAssertionsPath,
    bundleAssertionsDocument,
  )
  const terminalEvaluatorPath = join(outputDirectory, 'terminal-evaluator.json')
  const terminalEvaluatorWritten = await writeCanonicalArtifact(
    terminalEvaluatorPath,
    archive.bundleAssertions.terminalEvaluatorArtifact,
  )

  const resultDescriptors = []
  const writtenResults = []
  for (const result of archive.results) {
    const withDigest = resultWithDigest(result)
    const relativePath = `results/${result.fixture.fixtureId}.result.json`
    const written = await writeCanonicalArtifact(
      join(outputDirectory, relativePath),
      withDigest,
    )
    resultDescriptors.push({
      fixtureId: result.fixture.fixtureId,
      path: relativePath,
      fileSha256: written.fileSha256,
      semanticSha256: written.semanticSha256,
      byteLength: written.byteLength,
      fixtureVerdict: result.summary.fixtureVerdict,
    })
    writtenResults.push(withDigest)
  }

  const indexWithoutDigest = {
    ...archive.indexCore,
    archiveArtifacts: {
      provenance: {
        path: 'provenance.json',
        fileSha256: provenanceWritten.fileSha256,
        semanticSha256: provenanceWritten.semanticSha256,
        byteLength: provenanceWritten.byteLength,
      },
      bundleAssertions: {
        path: 'bundle-assertions.json',
        fileSha256: bundleAssertionsWritten.fileSha256,
        semanticSha256: bundleAssertionsWritten.semanticSha256,
        byteLength: bundleAssertionsWritten.byteLength,
      },
      terminalEvaluator: {
        path: 'terminal-evaluator.json',
        fileSha256: terminalEvaluatorWritten.fileSha256,
        semanticSha256: terminalEvaluatorWritten.semanticSha256,
        byteLength: terminalEvaluatorWritten.byteLength,
      },
      execution: {
        path: 'execution.json',
        fileSha256: executionWritten.fileSha256,
        semanticSha256: executionWritten.semanticSha256,
        byteLength: executionWritten.byteLength,
      },
      vitestReport: {
        path: 'vitest-report.json',
        fileSha256: vitestReportWritten.fileSha256,
        semanticSha256: vitestReportWritten.semanticSha256,
        byteLength: vitestReportWritten.byteLength,
      },
      sourceSnapshot: sourceSnapshotDescriptors,
      fixtureResults: resultDescriptors,
    },
  }
  const index = {
    ...indexWithoutDigest,
    indexSemanticSha256: contentSha256(indexWithoutDigest, [
      'generatedAtUtc',
      'indexSemanticSha256',
    ]),
  }
  const indexPath = join(outputDirectory, 'development-behavior-replay.json')
  await writeCanonicalArtifact(indexPath, index)
  const markdownPath = join(outputDirectory, 'development-behavior-replay.md')
  await writeAtomic(markdownPath, markdownSummary(
    index,
    writtenResults,
    bundleAssertionsDocument,
  ))
  const allArchiveFiles = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((first, second) => first.name < second.name ? -1 : first.name > second.name ? 1 : 0)
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name !== 'SHA256SUMS') allArchiveFiles.push(path)
    }
  }
  await visit(outputDirectory)
  const checksumLines = []
  for (const path of allArchiveFiles) {
    const bytes = await readFile(path)
    checksumLines.push(`${sha256Bytes(bytes)}  ${relative(outputDirectory, path).replaceAll('\\', '/')}`)
  }
  const checksumBytes = `${checksumLines.join('\n')}\n`
  const checksumPath = join(outputDirectory, 'SHA256SUMS')
  await writeExactArtifact(checksumPath, checksumBytes)
  return {
    index,
    indexPath,
    markdownPath,
    checksumPath,
    checksumFileSha256: sha256Bytes(checksumBytes),
    checksummedFileCount: checksumLines.length,
  }
}

export const verifyBaselineReplayChecksumManifest = async (outputDirectory) => {
  const checksumPath = join(outputDirectory, 'SHA256SUMS')
  const checksumBytes = await readFile(checksumPath)
  const lines = checksumBytes.toString('utf8').trimEnd().split('\n').filter(Boolean)
  const seen = new Set()
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    if (!match) throw new Error(`Malformed SHA256SUMS line: ${line}`)
    const [, expected, relativePath] = match
    if (relativePath.startsWith('/') || relativePath.split('/').includes('..') ||
        seen.has(relativePath) || relativePath === 'SHA256SUMS') {
      throw new Error(`Unsafe or duplicate SHA256SUMS path: ${relativePath}`)
    }
    seen.add(relativePath)
    const bytes = await readFile(join(outputDirectory, relativePath))
    if (sha256Bytes(bytes) !== expected) {
      throw new Error(`SHA-256 mismatch for ${relativePath}`)
    }
  }
  const actualFiles = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name !== 'SHA256SUMS') {
        actualFiles.push(relative(outputDirectory, path).replaceAll('\\', '/'))
      }
    }
  }
  await visit(outputDirectory)
  actualFiles.sort()
  const declaredFiles = [...seen].sort()
  if (stableReplayJson(actualFiles) !== stableReplayJson(declaredFiles)) {
    throw new Error('SHA256SUMS does not enumerate the exact archive file inventory')
  }
  return {
    checksumFileSha256: sha256Bytes(checksumBytes),
    checksummedFileCount: lines.length,
  }
}

const checkedArchivePath = (outputDirectory, relativePath) => {
  if (typeof relativePath !== 'string' || relativePath === '' ||
      relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
    throw new Error(`Unsafe replay archive path ${relativePath}`)
  }
  return join(outputDirectory, relativePath)
}

const verifyCanonicalDescriptor = async (outputDirectory, descriptor) => {
  const artifact = await loadCanonicalJsonArtifact(
    checkedArchivePath(outputDirectory, descriptor.path),
  )
  if (artifact.fileSha256 !== descriptor.fileSha256 ||
      artifact.semanticSha256 !== descriptor.semanticSha256 ||
      artifact.byteLength !== descriptor.byteLength) {
    throw new Error(`Archive descriptor mismatch for ${descriptor.path}`)
  }
  return artifact.data
}

const verifyExactDescriptor = async (outputDirectory, descriptor) => {
  const bytes = await readFile(checkedArchivePath(outputDirectory, descriptor.path))
  if (sha256Bytes(bytes) !== descriptor.fileSha256 ||
      bytes.byteLength !== descriptor.byteLength) {
    throw new Error(`Archive byte descriptor mismatch for ${descriptor.path}`)
  }
  return bytes
}

export const verifyBaselineReplayEvidenceArchive = async (outputDirectory) => {
  const checksums = await verifyBaselineReplayChecksumManifest(outputDirectory)
  const indexArtifact = await loadCanonicalJsonArtifact(join(
    outputDirectory,
    'development-behavior-replay.json',
  ))
  const index = indexArtifact.data
  if (index.schemaVersion !== BASELINE_REPLAY_INDEX_SCHEMA_VERSION ||
      index.indexSemanticSha256 !== contentSha256(index, [
        'generatedAtUtc',
        'indexSemanticSha256',
      ])) {
    throw new Error('Replay index schema or semantic self-digest is invalid')
  }
  if (index.canonicalPromotionAwarded !== false ||
      index.performanceOutcomesExecuted !== false ||
      index.claimLabel !== 'development-behavior-only') {
    throw new Error('Replay index exceeds the permitted development claim boundary')
  }
  const provenance = await verifyCanonicalDescriptor(
    outputDirectory,
    index.archiveArtifacts.provenance,
  )
  if (stableReplayJson(index.provenance) !== stableReplayJson(provenance)) {
    throw new Error('Replay index provenance differs from provenance.json')
  }
  const execution = await verifyCanonicalDescriptor(
    outputDirectory,
    index.archiveArtifacts.execution,
  )
  const vitestReport = await verifyCanonicalDescriptor(
    outputDirectory,
    index.archiveArtifacts.vitestReport,
  )
  const vitestResults = validateVitestFixtureReport(vitestReport)
  if (execution.exitCode !== 0 || execution.signal !== null ||
      execution.reportSuccess !== true || execution.sourceStableAcrossExecution !== true ||
      execution.runId !== index.execution.runId) {
    throw new Error('Replay execution record is not a successful source-stable run')
  }
  const provenanceSha256 = semanticSha256(provenance)
  if (execution.preExecutionProvenanceSha256 !== provenanceSha256 ||
      execution.postExecutionProvenanceSha256 !== provenanceSha256 ||
      index.execution.preExecutionProvenanceSha256 !== provenanceSha256 ||
      index.execution.postExecutionProvenanceSha256 !== provenanceSha256) {
    throw new Error('Replay pre/post provenance bindings are inconsistent')
  }
  await verifyExactDescriptor(outputDirectory, execution.logs.stdout)
  await verifyExactDescriptor(outputDirectory, execution.logs.stderr)

  const expectedSourceFiles = new Map()
  for (const inventory of provenanceInventories(provenance)) {
    for (const descriptor of inventory.files) expectedSourceFiles.set(descriptor.path, descriptor)
  }
  const archivedSourceFiles = new Map()
  for (const descriptor of index.archiveArtifacts.sourceSnapshot) {
    if (archivedSourceFiles.has(descriptor.sourcePath)) {
      throw new Error(`Duplicate source snapshot ${descriptor.sourcePath}`)
    }
    const expected = expectedSourceFiles.get(descriptor.sourcePath)
    if (!expected || descriptor.path !== `source-snapshot/${descriptor.sourcePath}` ||
        descriptor.fileSha256 !== expected.sha256 ||
        descriptor.byteLength !== expected.byteLength) {
      throw new Error(`Source snapshot descriptor mismatch for ${descriptor.sourcePath}`)
    }
    await verifyExactDescriptor(outputDirectory, descriptor)
    archivedSourceFiles.set(descriptor.sourcePath, descriptor)
  }
  if (stableReplayJson([...archivedSourceFiles.keys()].sort()) !==
      stableReplayJson([...expectedSourceFiles.keys()].sort())) {
    throw new Error('Source snapshot does not cover the exact execution-source inventory')
  }

  const protocolSnapshotPath = checkedArchivePath(
    outputDirectory,
    'source-snapshot/research/protocols/baseline_replay_fixture_protocol.json',
  )
  const protocol = JSON.parse(await readFile(protocolSnapshotPath, 'utf8'))
  const catalogue = validateProtocolCatalog(protocol)
  const resultDescriptors = new Map()
  for (const descriptor of index.archiveArtifacts.fixtureResults) {
    if (resultDescriptors.has(descriptor.fixtureId)) {
      throw new Error(`Duplicate fixture-result descriptor ${descriptor.fixtureId}`)
    }
    resultDescriptors.set(descriptor.fixtureId, descriptor)
  }
  const capturedFixtures = []
  const rebuiltResults = []
  for (const fixtureId of EXPECTED_BASELINE_REPLAY_FIXTURE_IDS) {
    const descriptor = resultDescriptors.get(fixtureId)
    if (!descriptor) throw new Error(`Missing fixture-result descriptor ${fixtureId}`)
    const storedResult = await verifyCanonicalDescriptor(outputDirectory, descriptor)
    if (storedResult.resultSemanticSha256 !== contentSha256(
      storedResult,
      ['resultSemanticSha256'],
    )) {
      throw new Error(`${fixtureId} result semantic self-digest is invalid`)
    }
    const captured = await loadCapturedFixture({
      captureDirectory: join(outputDirectory, 'artifacts'),
      fixtureId,
      specification: catalogue.fixtures.get(fixtureId),
    })
    if (captured.runId !== execution.runId) {
      throw new Error(`${fixtureId} capture run ID differs from execution.json`)
    }
    const rebuilt = resultWithDigest(createFixtureResult({
      captured,
      provenance,
      vitestResult: vitestResults.get(fixtureId),
    }))
    if (stableReplayJson(storedResult) !== stableReplayJson(rebuilt) ||
        descriptor.fixtureVerdict !== rebuilt.summary.fixtureVerdict) {
      throw new Error(`${fixtureId} stored result differs from rebuilt captured evidence`)
    }
    capturedFixtures.push(captured)
    rebuiltResults.push(rebuilt)
  }
  if (resultDescriptors.size !== EXPECTED_BASELINE_REPLAY_FIXTURE_IDS.length) {
    throw new Error('Unexpected extra fixture-result descriptors exist')
  }
  const bundleDocument = await verifyCanonicalDescriptor(
    outputDirectory,
    index.archiveArtifacts.bundleAssertions,
  )
  const rebuiltBundle = buildBundleAssertions(
    capturedFixtures,
    catalogue.commonAssertions,
    catalogue.informationMatrix,
  )
  const terminalEvaluatorDescriptor = index.archiveArtifacts.terminalEvaluator
  const terminalEvaluatorDocument = terminalEvaluatorDescriptor === undefined
    ? null
    : await verifyCanonicalDescriptor(outputDirectory, terminalEvaluatorDescriptor)
  if (
    terminalEvaluatorDocument === null &&
    capturedFixtures.some((fixture) => fixture.evaluatorCases !== null)
  ) {
    throw new Error('Declared evaluator cases require a terminal evaluator artifact')
  }
  if (stableReplayJson(bundleDocument.assertions) !== stableReplayJson(rebuiltBundle.assertions) ||
      stableReplayJson(bundleDocument.summary) !== stableReplayJson(rebuiltBundle.summary) ||
      (terminalEvaluatorDocument !== null &&
       stableReplayJson(terminalEvaluatorDocument) !==
        stableReplayJson(rebuiltBundle.terminalEvaluatorArtifact))) {
    throw new Error('Stored bundle assertions differ from recomputed capture invariants')
  }
  const fixtureVerdicts = countFixtureVerdicts(rebuiltResults)
  const fixtureAssertions = countAssertionVerdicts(rebuiltResults)
  if (stableReplayJson(index.summary.fixtureVerdicts) !== stableReplayJson(fixtureVerdicts) ||
      stableReplayJson(index.summary.fixtureAssertions) !== stableReplayJson(fixtureAssertions) ||
      stableReplayJson(index.summary.bundleAssertionVerdict) !==
        stableReplayJson(rebuiltBundle.summary)) {
    throw new Error('Replay index summaries differ from rebuilt results')
  }
  return {
    indexSemanticSha256: index.indexSemanticSha256,
    checksumFileSha256: checksums.checksumFileSha256,
    checksummedFileCount: checksums.checksummedFileCount,
    fixtureAssertions,
    fixtureVerdicts,
    bundleAssertionVerdict: rebuiltBundle.summary,
  }
}

const main = async () => {
  const repositoryRoot = DEFAULT_REPOSITORY_ROOT
  const workingDirectory = await mkdtemp(join(tmpdir(), 'plumenav-replay-evidence-'))
  const captureDirectory = join(workingDirectory, 'capture')
  const reportPath = join(workingDirectory, 'vitest-report.json')
  let stagingDirectory = null
  try {
    const runId = randomUUID()
    const preExecutionProvenance = await collectReplayProvenance(repositoryRoot)
    const sourceSnapshot = await readExecutionSourceSnapshot(
      repositoryRoot,
      preExecutionProvenance,
    )
    const execution = await executeBaselineReplayHarness({
      repositoryRoot,
      captureDirectory,
      reportPath,
      runId,
    })
    if (execution.code !== 0 || execution.signal !== null) {
      throw new Error(
        `Replay harness failed; no valid archive was published (code=${execution.code}, signal=${execution.signal})`,
      )
    }
    const vitestReport = JSON.parse(await readFile(reportPath, 'utf8'))
    validateVitestFixtureReport(vitestReport)
    const postExecutionProvenance = await collectReplayProvenance(repositoryRoot)
    const preExecutionProvenanceSha256 = semanticSha256(preExecutionProvenance)
    const postExecutionProvenanceSha256 = semanticSha256(postExecutionProvenance)
    if (preExecutionProvenanceSha256 !== postExecutionProvenanceSha256) {
      throw new Error('Execution-sensitive source/provenance changed during replay; no archive was published')
    }
    const boundExecution = {
      ...execution,
      runId,
      preExecutionProvenanceSha256,
      postExecutionProvenanceSha256,
    }
    const archive = await buildBaselineReplayEvidenceArchive({
      repositoryRoot,
      captureDirectory,
      vitestReport,
      execution: boundExecution,
      provenance: preExecutionProvenance,
      sourceSnapshot,
    })
    const outputDirectory = resolve(
      process.env.BASELINE_REPLAY_OUTPUT_DIR ?? DEFAULT_BASELINE_REPLAY_OUTPUT_DIRECTORY,
    )
    try {
      await access(outputDirectory)
      throw new Error(
        `Refusing to mix replay generations in existing directory ${outputDirectory}; choose a new BASELINE_REPLAY_OUTPUT_DIR`,
      )
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await mkdir(dirname(outputDirectory), { recursive: true })
    stagingDirectory = await mkdtemp(join(dirname(outputDirectory), '.baseline-replay-staging-'))
    const written = await writeBaselineReplayEvidenceArchive({
      archive,
      outputDirectory: stagingDirectory,
    })
    const checksumVerification = await verifyBaselineReplayEvidenceArchive(stagingDirectory)
    if (checksumVerification.checksumFileSha256 !== written.checksumFileSha256 ||
        checksumVerification.checksummedFileCount !== written.checksummedFileCount) {
      throw new Error('Replay checksum verification summary differs from the writer summary')
    }
    await rename(stagingDirectory, outputDirectory)
    stagingDirectory = null
    const { fixtureAssertions, fixtureVerdicts, harnessStatuses } = written.index.summary
    process.stdout.write(
      `Replay harness: ${harnessStatuses.passed}/18 executed successfully.\n` +
      `Scientific assertions: ${fixtureAssertions.pass} pass, ${fixtureAssertions.fail} fail, ` +
      `${fixtureAssertions['not-executable']} not executable.\n` +
      `Fixture verdicts: ${fixtureVerdicts.pass} pass, ${fixtureVerdicts.fail} fail, ` +
      `${fixtureVerdicts['not-executable']} not executable.\n` +
      `Index: ${join(outputDirectory, 'development-behavior-replay.json')}\n` +
      `Index semantic SHA-256: ${written.index.indexSemanticSha256}\n` +
      `SHA256SUMS SHA-256: ${written.checksumFileSha256}\n` +
      `Checksummed files: ${written.checksummedFileCount}\n`,
    )
    if (harnessStatuses.failed > 0) process.exitCode = 1
    if (
      process.env.BASELINE_REPLAY_REQUIRE_ALL_PASS === '1' &&
      (fixtureAssertions.fail > 0 || fixtureAssertions['not-executable'] > 0)
    ) process.exitCode = 2
  } finally {
    if (stagingDirectory !== null) {
      await rm(stagingDirectory, { recursive: true, force: true })
    }
    await rm(workingDirectory, { recursive: true, force: true })
  }
}

const verifyMain = async () => {
  const outputDirectory = resolve(
    process.env.BASELINE_REPLAY_OUTPUT_DIR ?? DEFAULT_BASELINE_REPLAY_OUTPUT_DIRECTORY,
  )
  const verified = await verifyBaselineReplayEvidenceArchive(outputDirectory)
  process.stdout.write(
    `Verified ${verified.checksummedFileCount} replay archive files and rebuilt all 18 fixture results.\n` +
    `Index semantic SHA-256: ${verified.indexSemanticSha256}\n` +
    `SHA256SUMS SHA-256: ${verified.checksumFileSha256}\n`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entrypoint = process.argv.includes('--verify') ? verifyMain : main
  entrypoint().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
