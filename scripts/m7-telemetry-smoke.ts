/** Real-simulation smoke check for uncensored M7 candidate-formation telemetry. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { batchResultsToCsv, runBatch } from '../src/sim/batch'
import type { BatchResult, SimulationConfig } from '../src/sim/types'
import { createM7Manifest, M7_ARMS } from './m7-precandidate-manifest'

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message)
}

const main = async () => {
  const manifest = createM7Manifest()
  const emitting = manifest.cells.find((cell) => cell.condition === 'emitting' && cell.scenarioKind === 'open')!
  const results: BatchResult[] = []
  for (const arm of M7_ARMS) {
    const config: SimulationConfig = {
      ...emitting.config,
      ...arm.configOverrides,
      algorithmId: arm.algorithmId,
      durationSeconds: 180,
      checkpointSeconds: [180],
      gridResolution: 64,
      physicsStepSeconds: 0.025,
    }
    const batch = await runBatch(config, [arm.algorithmId], [emitting.scenarioKind], 1)
    assert(batch.results.length === 1, `${arm.id}: expected one smoke result`)
    const result = batch.results[0]!
    assert(result.metrics.quadCandidateFormationEvaluations > 0, `${arm.id}: no formation evaluations`)
    assert(result.metrics.quadCandidateFormationEvaluations === result.metrics.quadDeclarationEvaluations,
      `${arm.id}: formation/declaration evaluation counts diverged`)
    assert(result.metrics.quadCandidateProvisionalRayEvaluations ===
      result.metrics.quadCandidateGatePasses['provisional-ray'],
    `${arm.id}: provisional-ray gate count mismatch`)
    results.push(result)
  }
  assert(results.some((result) => result.metrics.quadCandidateMaxGradientRayPoolCount > 0),
    'Smoke world produced no gradient ray in any Quad arm')
  const csv = batchResultsToCsv(results)
  const header = csv.split('\n')[0]!.split(',')
  for (const column of [
    'quad_candidate_provisional_ray_evaluations',
    'quad_candidate_max_gradient_ray_pool_count',
    'quad_candidate_max_provisional_ray_count',
    'quad_candidate_max_quality',
    'quad_candidate_min_residual',
    'quad_candidate_max_surface_support',
    'quad_candidate_gate_passes_surface_support',
  ]) assert(header.includes(column), `CSV missing ${column}`)
  const outputDirectory = '/private/tmp/plumenav-m7-telemetry-smoke-2026-09-03'
  await mkdir(outputDirectory, { recursive: true })
  const outputPath = join(outputDirectory, 'm7-telemetry-smoke.csv')
  await writeFile(outputPath, csv, 'utf8')
  process.stdout.write(`${JSON.stringify({
    status: 'complete',
    outputPath,
    runs: results.length,
    formationEvaluations: results.reduce((sum, result) => sum + result.metrics.quadCandidateFormationEvaluations, 0),
    provisionalRayEvaluations: results.reduce((sum, result) => sum + result.metrics.quadCandidateProvisionalRayEvaluations, 0),
    rowsWithProvisionalRay: results.filter((result) => result.metrics.quadCandidateProvisionalRayEvaluations > 0).length,
    maxRayPoolCount: Math.max(...results.map((result) => result.metrics.quadCandidateMaxGradientRayPoolCount)),
    maxProvisionalRayCount: Math.max(...results.map((result) => result.metrics.quadCandidateMaxProvisionalRayCount)),
    maxSurfaceSupport: Math.max(...results.map((result) => result.metrics.quadCandidateMaxSurfaceSupport)),
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`M7 telemetry smoke failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
