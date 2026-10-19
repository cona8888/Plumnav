import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SimulationEngine } from '../src/sim/engine'
import { evaluateMultiView, MULTIVIEW_POLICY, selectSniffTurnPlan } from './lib/multiview-source-evidence'
import { evaluateFlowSourceEvidence } from './lib/flow-source-evidence'

const input = 'research/evidence/m14_sniff_turn_bearing_corrected_2026-09-06'
const output = 'research/analysis/m14_sniff_turn_bearing_corrected_2026-09-06'
const old = 'research/evidence/m13_flow_confirmation_2026-09-06'
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const read = async (path: string) => JSON.parse(await readFile(join(input, path), 'utf8'))
const safe = (path: string) => {
  if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('Unsafe inventory path')
  return path
}
const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b); const n = s.length
  return n ? (s[Math.floor((n - 1) / 2)]! + s[Math.floor(n / 2)]!) / 2 : null
}
export const analyzeM14 = async () => {
  const design = await read('design.json'); const summary = await read('summary.json'); const checksums = await read('checksums.json')
  if (!summary.complete || !checksums.complete || design.jobs.length !== 40 || summary.summaries.length !== 40) throw new Error('Incomplete M14')
  const expected = ['design.json', 'summary.json', ...design.jobs.map((j: any) => `${j.id}.json`)].sort()
  if (json(expected) !== json(checksums.inventory.map((e: any) => e.path).sort())) throw new Error('Unexpected M14 inventory')
  for (const e of checksums.inventory) {
    const b = await readFile(join(input, safe(e.path)))
    if (b.length !== e.bytes || hash(b) !== e.sha256) throw new Error(`Invalid artifact: ${e.path}`)
  }
  if (hash(json(design.sourceInventory)) !== design.sourceInventorySha256 ||
      summary.sourceInventorySha256 !== design.sourceInventorySha256 || json(design.policy) !== json(MULTIVIEW_POLICY)) throw new Error('Frozen policy mismatch')
  for (const e of design.sourceInventory) {
    const b = await readFile(join(input, 'source-snapshot', safe(e.path)))
    if (b.length !== e.bytes || hash(b) !== e.sha256) throw new Error(`Invalid source snapshot: ${e.path}`)
    if ((e.path.startsWith('src/sim/') || e.path.startsWith('scripts/lib/')) && hash(await readFile(e.path)) !== e.sha256) {
      throw new Error(`Current scorer/engine differs: ${e.path}`)
    }
  }
  const oldInventory = JSON.parse(await readFile(join(old, 'checksums.json'), 'utf8')).inventory
  if (hash(await readFile(join(old, 'design.json'))) !== design.m13DesignSha256) throw new Error('M13 reference changed')
  let replayedScores = 0; let replayedM13Scores = 0; let matchedM13Returns = 0
  const runs: Array<Record<string, any>> = []
  for (const job of design.jobs) {
    const r = await read(`${job.id}.json`)
    if (json(r.job) !== json(job) || json(r.summary) !== json(summary.summaries.find((s: any) => s.id === job.id))) throw new Error('Job identity mismatch')
    const reasons: Record<string, number> = {}
    let budgetPassed = false
    if (r.available) {
      const engine = new SimulationEngine(job.config)
      if (job.policy === 'sniff-turn') {
        const plan = selectSniffTurnPlan(job.anchor, job.armId === 'geometry-active' ? 'active-suction' : 'passive-array',
          job.config.activeSniffReach, job.config.activeSniffStrength, engine.environment.isBlocked, job.config.robotSpeed,
          ((job.config.robotStartHeadingDegrees ?? 0) * Math.PI) / 180)
        if (json(plan) !== json(job.plan)) throw new Error(`Geometry plan replay changed: ${job.id}`)
      }
      for (const record of r.records) {
        const e = evaluateMultiView({ ...record, isBlocked: engine.environment.isBlocked })
        if (json(e) !== json(record.evidence)) throw new Error(`M14 score replay changed: ${job.id}/${record.time}`)
        replayedScores++; reasons[e.reason] = (reasons[e.reason] ?? 0) + 1
        if (job.policy === 'fixed') {
          const scan = record.scans.at(-1)
          const m13 = evaluateFlowSourceEvidence({ ...record, position: scan.position, cycleSeconds: scan.cycleSeconds,
            quad: scan.quad, isBlocked: engine.environment.isBlocked })
          if (json(m13) !== json(record.frozenM13)) throw new Error('M13 ablation changed')
          replayedM13Scores++
        }
      }
      if (job.policy === 'fixed' && ['source', 'far-downwind', 'absent'].includes(job.poseId)) {
        const path = `${job.world}-${job.poseId}-${job.armId}.json`
        const bytes = await readFile(join(old, path)); const expectedOld = oldInventory.find((e: any) => e.path === path)
        if (!expectedOld || hash(bytes) !== expectedOld.sha256) throw new Error(`Invalid M13 reference: ${path}`)
        const prior = JSON.parse(bytes.toString())
        if (prior.scans.length !== r.scans.length) throw new Error('M13 reference scan count mismatch')
        for (let i = 0; i < prior.scans.length; i++) {
          if (prior.scans[i].time !== r.scans[i].time || json(prior.scans[i].quad.readings) !== json(r.scans[i].quad.readings) ||
              json(prior.scans[i].flowEvidence) !== json(r.records[i].frozenM13)) throw new Error(`Fixed sensor replay differs: ${job.id}/${i}`)
          matchedM13Returns++
        }
      }
      budgetPassed = r.finalTime === 40 && r.records.length === 12 && r.missedSlots.length === 0 &&
        r.costs.collisionAttempts === 0 && r.timing.length === 12 && r.timing.every((t: any, i: number) =>
          t.slot === i && t.issuedAt === 10 + i * 2.5 && t.settledSeconds >= 0.5) &&
        // The frozen runner named the engine's inclusive quadSniffCycles
        // counter "activeCycles". Passive cycles are a subset, not additive.
        r.costs.activeCycles === 12 && r.costs.passiveCycles === (job.armId === 'geometry-passive' ? 12 : 0) &&
        r.costs.activeSamplingSeconds === (job.armId === 'geometry-active' ? 9 : 0) &&
        r.costs.passiveSamplingSeconds === (job.armId === 'geometry-passive' ? 9 : 0) &&
        (job.policy === 'fixed' ? r.costs.turnRadians === 0 && r.costs.pathLengthNormalized === 0
          : Math.abs(r.costs.turnRadians - 11 * Math.PI / 4) < 1e-10 && Math.abs(r.costs.turningSeconds - 5.5) < 1e-10)
    }
    const final = r.records.slice(-6); const positives = final.filter((record: any) => record.evidence.positive).length
    if (r.summary.casePositive !== (final.length === 6 && positives >= 4) || r.summary.finalPositiveScans !== positives) throw new Error('Case vote mismatch')
    runs.push({ ...r.summary, budgetPassed, costs: r.costs ? { ...r.costs,
      quadCycles: r.costs.activeCycles, activeCycles: r.costs.activeCycles - r.costs.passiveCycles } : null, reasons,
      finalUsableScans: final.filter((record: any) => record.evidence.usable).length,
      medianCondition: median(r.records.flatMap((record: any) => record.evidence.condition === null ? [] : [record.evidence.condition])),
      medianFitRms: median(r.records.flatMap((record: any) => record.evidence.fitRms === null ? [] : [record.evidence.fitRms])),
      medianResidual: median(r.records.flatMap((record: any) => record.evidence.nominalResidual === null ? [] : [record.evidence.nominalResidual])),
      medianNoiseBound: median(r.records.flatMap((record: any) => record.evidence.maximumNoiseBound === null ? [] : [record.evidence.maximumNoiseBound])) })
  }
  // Pump and observation costs must match within sensing-arm fixed/turn pairs.
  const pairedCosts = runs.filter((r) => r.policy === 'fixed').every((fixed) => {
    const turned = runs.find((r) => r.world === fixed.world && r.poseId === fixed.poseId && r.armId === fixed.armId && r.policy === 'sniff-turn')!
    return fixed.costs && turned.costs && ['elapsedSeconds', 'activeSamplingSeconds', 'passiveSamplingSeconds', 'suctionEnergy']
      .every((key) => fixed.costs[key] === turned.costs[key])
  })
  const active = runs.filter((r) => r.armId === 'geometry-active' && r.policy === 'sniff-turn')
  const fixedObstructed = runs.find((r) => r.world === 'obstructed-downwind-0' && r.poseId === 'source' && r.armId === 'geometry-active' && r.policy === 'fixed')!
  const turnedObstructed = active.find((r) => r.world === 'obstructed-downwind-0' && r.poseId === 'source')!
  const gates = {
    matchedBudgets: runs.every((r) => r.budgetPassed) && pairedCosts,
    obstructedOperatorImproved: turnedObstructed.identifiableScans > fixedObstructed.identifiableScans,
    exactSourcesPositive: active.filter((r) => r.poseId === 'source').every((r) => r.casePositive),
    insideTolerancePositive: active.filter((r) => r.poseId === 'inside-tolerance').every((r) => r.casePositive),
    outsideAndFarNegative: active.filter((r) => ['outside-tolerance', 'far-downwind'].includes(r.poseId)).every((r) => !r.casePositive),
    absentNoPositive: active.filter((r) => r.poseId === 'absent').every((r) => !r.casePositive),
    emittingEvidenceAvailable: active.filter((r) => r.poseId !== 'absent').every((r) => r.finalUsableScans >= 4),
  }
  const analysis = { diagnosticOnly: true, verifiedArtifacts: checksums.inventory.length, verifiedSourceFiles: design.sourceInventory.length,
    sourceInventorySha256: design.sourceInventorySha256, replayedScores, replayedM13Scores, matchedM13Returns,
    elapsedWallSeconds: (Date.parse(summary.completedAt) - Date.parse(summary.startedAt)) / 1000,
    peakRssBytes: summary.peakRssBytes, gates, candidateAdvances: Object.values(gates).every(Boolean), runs }
  const table = [
    '| World / pose | Sensors | Policy | Identifiable / 12 | Usable final / 6 | Positive final / 6 | Case positive |',
    '|---|---|---|---:|---:|---:|---|',
    ...runs.map((r) => `| ${r.world} / ${r.poseId} | ${r.armId === 'geometry-active' ? 'Active' : 'Passive'} | ${r.policy} | ${r.identifiableScans}/12 | ${r.finalUsableScans}/6 | ${r.finalPositiveScans}/6 | ${r.casePositive ? 'yes' : 'no'} |`),
  ].join('\n')
  const report = [
    '# M14 sniff–turn–sniff diagnostic: bearing-corrected rerun',
    'The initial global-bearing run failed the planned cross-M13 reference check and is preserved separately. This complete rerun aligns both policies to the archived scenario starting heading. No score threshold or scientific condition was tuned to the first outcomes; no trajectories were spliced. See m14_sniff_turn_corrected_protocol.md.',
    `All 40 jobs accounted for. Verified ${analysis.verifiedArtifacts} artifacts, ${analysis.verifiedSourceFiles} source snapshots, ${replayedScores} M14 score replays and ${replayedM13Scores} frozen-M13 score replays. ${matchedM13Returns} matching fixed four-channel returns and M13 decisions exactly reproduced their M13 archive.`,
    `Mac-only serial execution: ${analysis.elapsedWallSeconds.toFixed(1)} s, peak process RSS ${(analysis.peakRssBytes / 2 ** 30).toFixed(2)} GiB. No AWS. M12/M13 and the app remain unchanged.`,
    '## Predefined decision',
    `Candidate advances: **${analysis.candidateAdvances ? 'YES, to further development only' : 'NO; do not replace the live declaration rule'}**.`,
    Object.entries(gates).map(([key, pass]) => `- ${key}: ${pass ? 'PASS' : 'FAIL'}`).join('\n'),
    `At the obstructed active source, the transport operator was identifiable in ${fixedObstructed.identifiableScans}/12 fixed versus ${turnedObstructed.identifiableScans}/12 sniff-turn returns. Identifiability is not sufficient evidence of a source: the corresponding case decisions were fixed=${fixedObstructed.casePositive}, sniff-turn=${turnedObstructed.casePositive}.`,
    '## Full diagnostic table', table,
    'Case positive means four of the final six residual checks passed, not a native source declaration or successful navigation. The diagnostic anchor is evaluator prescribed; truth is not given to the scoring or geometry-planning function. Repeated scans and near-source offsets in two reused worlds do not estimate population performance.',
    '## Cost and geometry interpretation',
    'Counter-label audit: in the frozen raw runner, costs.activeCycles stores the engine total quadSniffCycles, including passive arrays; costs.passiveCycles is its subset. The first analysis incorrectly added these counters and failed the budget gate. That analysis is preserved in m14_sniff_turn_bearing_corrected_counter_audit_2026-09-06. This corrected analysis reports quadCycles = raw activeCycles and actual activeCycles = raw activeCycles minus passiveCycles; it checks all twelve issued slots and the separate nine-second sampling-duration counters. No simulation, observation, score, threshold or candidate decision was changed.',
    `All paired observation/pump costs matched: ${pairedCosts}. The extra intake-bearing proxy charges eleven 45-degree turns, 5.5 ideal turning seconds, inside the shared 40-second horizon. These are not calibrated motor joules or body-yaw dynamics. Travel and collision logs are retained. ${runs.filter((r) => r.planMode === 'turn-and-reposition').length} experimental jobs selected repositioning; the fallback is separately exercised by a kinematic regression witness, not credited as an empirical benefit where it was not selected.`,
    'The fixed comparator uses the same multiview scorer and is not automatically failed for an unmeasured mixed-curvature coefficient if the transport operator remains identifiable. Poor conditioning and the propagated noise/model-fit allowance remain independent failure reasons. Active/passive footprints and pump energy differ; their outcomes do not isolate suction benefit.',
    '## Scientific limits and next decision',
    'This candidate explicitly accounts for clipped first/second footprint moments and combines orientations. Its quadratic-plus-linear-time approximation, coefficient intervals, fit-RMS allowance and intake model remain unvalidated engineering assumptions. A solvable local inverse problem does not guarantee an accurate transport residual or a 1%-accurate source coordinate. The nonconservative residual is not an exact mass-flux balance or a soil-permeability estimate.',
    'Preserve these outcomes without adjusting the thresholds to the two worlds. Before another competitive benchmark, separate forward-model/finite-footprint bias, temporal aliasing and sensor-noise amplification with analytical or calibrated field controls, then freeze any revised confirmation model. If measured identification improves but the evidence margin does not, more orientation diversity alone is not the next justified cure. Broader outdoor/urban performance and biological novelty remain unestablished.',
    `Source inventory SHA-256: ${analysis.sourceInventorySha256}\nAnalysis SHA-256: ${hash(json(analysis))}`,
  ].join('\n\n') + '\n'
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'm14-sniff-turn-analysis.json'), json(analysis))
  await writeFile(join(output, 'm14-sniff-turn-report.md'), report)
  await copyFile('scripts/m14-analyze-sniff-turn.ts', join(output, 'analysis-source.ts'))
  const inventory = await Promise.all(['m14-sniff-turn-analysis.json', 'm14-sniff-turn-report.md', 'analysis-source.ts'].map(async (path) => {
    const bytes = await readFile(join(output, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }
  }))
  await writeFile(join(output, 'analysis-checksums.json'), json(inventory))
  process.stdout.write(json({ ...analysis, runs: runs.map(({ costs, ...r }) => r), analysisSha256: hash(json(analysis)), reportSha256: hash(report) }))
}
if (process.env.M14_ANALYSIS_RUN === '1') analyzeM14().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1
})
