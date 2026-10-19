// Read-only review of archived M71 outputs. Does not run or retune controllers.
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = resolve(process.argv[2] ?? 'research/results/m71-v7-output')
const slices = new Map()
const candidate = { emittingRuns: 0, passiveContactRuns: 0, samplingRuns: 0,
  formationGateRuns: 0, candidateEvaluationRuns: 0, abstentions: 0,
  finalProximity: 0, correctDeclarations: 0 }
let runs = 0, cells = 0
const signature = new Set()
for (const shard of (await readdir(root)).filter(s => /^part-\d{3}-of-004$/.test(s)).sort()) {
  const dir = resolve(root, shard, 'cells')
  for (const file of (await readdir(dir)).filter(s => s.endsWith('.json')).sort()) {
    const {cell, results} = JSON.parse(await readFile(resolve(dir, file), 'utf8'))
    cells++
    for (const r of results) {
      runs++
      const m = r.metrics, c = r.config
      signature.add(JSON.stringify({domain: c.domainMeters, speed: c.robotSpeed,
        reach: c.activeSniffReach, cycle: c.activeSniffCycleSeconds,
        dt: c.fixedDt, physics: c.physicsMode, buoyancy: c.gasBuoyancy}))
      const keys = cell.family === 'core'
        ? [`sensor:${cell.sensor.id}`, `soil:${cell.soilCaseId}`, `wind:${cell.windDirectionDegrees}`]
        : cell.family === 'safety' ? [`safety:${cell.targetStatus}`] : []
      for (const key of keys) {
        const g = slices.get(key) ?? {runs: 0, correct: 0, wrong: 0, declarations: 0, abstentions: 0}
        g.runs++; g.correct += Number(m.terminalOutcome === 'correct-declaration')
        g.wrong += Number(m.terminalOutcome === 'wrong-declaration')
        g.declarations += Number(m.nativeDeclaration); g.abstentions += Number(m.nativeAbstention)
        slices.set(key, g)
      }
      if (r.algorithmId === 'quad-sniff-refine' && cell.targetStatus === 'emitting') {
        candidate.emittingRuns++
        candidate.passiveContactRuns += Number(m.hitCount > 0)
        candidate.samplingRuns += Number(m.quadChannelReturns > 0)
        candidate.formationGateRuns += Number((m.quadCandidateGatePasses?.['surface-support'] ?? 0) > 0)
        candidate.candidateEvaluationRuns += Number(m.quadDeclarationCandidateEvaluations > 0)
        candidate.abstentions += Number(m.nativeAbstention)
        candidate.finalProximity += Number(m.success === true)
        candidate.correctDeclarations += Number(m.terminalOutcome === 'correct-declaration')
      }
    }
  }
}
if (cells !== 280 || runs !== 67200) throw new Error('Incomplete M71 input')
console.log(JSON.stringify({cells, runs, physicalSignatures: [...signature].map(JSON.parse),
  candidate, slices: Object.fromEntries([...slices].sort(([a],[b])=>a.localeCompare(b))),
  caveat: 'Slices pool algorithms descriptively. Gate counts are legacy diagnostic events, not a sequential bracket-completion funnel.'}, null, 2))
