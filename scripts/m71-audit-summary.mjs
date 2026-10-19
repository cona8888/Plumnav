// Descriptive audit only: the locked campaign's cells, not pooled missions,
// are the independent design strata. No inferential ranking is made here.
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(process.argv[2] ?? 'research/results/m71-v7-output')
const groups = new Map()
const outcomes = new Map()
const paired = new Map()
const cellOutcomes = new Map()
const algorithms = ['coverage', 'surge-cast', 'infotaxis', 'smc-kl', 'pmfs',
  'quad-passive', 'quad-sniff-wind', 'quad-sniff-refine']
for (const shard of (await readdir(root)).filter((s) => /^part-\d{3}-of-004$/.test(s)).sort()) {
  const cells = resolve(root, shard, 'cells')
  for (const filename of (await readdir(cells)).filter((s) => s.endsWith('.json'))) {
    const { cell, results } = JSON.parse(await readFile(resolve(cells, filename), 'utf8'))
    if (results.length !== 240) throw new Error(`Wrong results per cell ${cell.index}`)
    const byAlgorithm = new Map(results.map((r) => [`${r.algorithmId}|${r.seed}`, r]))
    const seeds = new Set(results.map((r) => r.seed))
    if (seeds.size !== 30) throw new Error(`Wrong replicate count ${cell.index}`)
    for (const algorithmId of algorithms) for (const seed of seeds) {
      if (!byAlgorithm.has(`${algorithmId}|${seed}`)) throw new Error(`Unpaired result ${cell.index}/${algorithmId}/${seed}`)
    }
    for (const algorithmId of ['quad-passive', 'quad-sniff-wind']) {
      const key = `${cell.family}|${algorithmId}`
      const row = paired.get(key) ?? { compared: 0, candidateOnly: 0, controlOnly: 0, both: 0, neither: 0 }
      for (const seed of seeds) {
        const candidate = byAlgorithm.get(`quad-sniff-refine|${seed}`)
        const control = byAlgorithm.get(`${algorithmId}|${seed}`)
        if (!candidate || !control) throw new Error(`Missing pair ${cell.index}/${seed}`)
        const good = (r) => cell.targetStatus === 'emitting'
          ? r.metrics.terminalOutcome === 'correct-declaration'
          : r.metrics.correctRejection === true
        const c = good(candidate), b = good(control)
        row.compared++
        if (c && b) row.both++
        else if (c) row.candidateOnly++
        else if (b) row.controlOnly++
        else row.neither++
      }
      paired.set(key, row)
    }
    for (const r of results) {
      const m = r.metrics
      const key = `${cell.family}|${r.algorithmId}`
      const g = groups.get(key) ?? { missions: 0, correctDeclarations: 0, wrongDeclarations: 0,
        noDeclarationPresent: 0, correctRejections: 0, spuriousDeclarations: 0,
        finalProximity: 0, errorSum: 0, errors: 0, timeSum: 0, pathSum: 0,
        contactsSum: 0, activeProbesSum: 0, quadSniffCyclesSum: 0,
        quadChannelReturnsSum: 0, candidateEvaluationsSum: 0,
        declarationEvaluationsSum: 0, noLeakDeclarations: 0, nativeAbstentions: 0 }
      g.missions++
      if (m.terminalOutcome === 'correct-declaration') g.correctDeclarations++
      if (m.terminalOutcome === 'wrong-declaration') g.wrongDeclarations++
      if (m.terminalOutcome === 'deadline-nondeclaration-present' || m.terminalOutcome === 'missed-source-abstention') g.noDeclarationPresent++
      if (m.correctRejection === true) g.correctRejections++
      if (m.spuriousDeclaration) g.spuriousDeclarations++
      if (cell.targetStatus !== 'emitting' && m.nativeDeclaration) g.noLeakDeclarations++
      if (m.nativeAbstention) g.nativeAbstentions++
      if (m.success === true) g.finalProximity++
      if (m.normalizedError !== null) { g.errorSum += m.normalizedError; g.errors++ }
      g.timeSum += m.elapsedSeconds
      g.pathSum += m.pathLengthNormalized
      g.contactsSum += m.contactEpisodes
      g.activeProbesSum += m.activeProbeCount
      g.quadSniffCyclesSum += m.quadSniffCycles
      g.quadChannelReturnsSum += m.quadChannelReturns
      g.candidateEvaluationsSum += m.quadCandidateFormationEvaluations
      g.declarationEvaluationsSum += m.quadDeclarationCandidateEvaluations
      groups.set(key, g)
      outcomes.set(m.terminalOutcome, (outcomes.get(m.terminalOutcome) ?? 0) + 1)
      const ck = `${cell.index}|${r.algorithmId}`
      const cg = cellOutcomes.get(ck) ?? { family: cell.family, algorithmId: r.algorithmId, correct: 0, n: 0 }
      cg.correct += cell.targetStatus === 'emitting'
        ? Number(m.terminalOutcome === 'correct-declaration')
        : Number(m.correctRejection === true)
      cg.n++
      cellOutcomes.set(ck, cg)
    }
  }
}
const table = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, g]) => ({
  family: key.split('|')[0], algorithm: key.split('|')[1], missions: g.missions,
  correctDeclarations: g.correctDeclarations, wrongDeclarations: g.wrongDeclarations,
  noDeclarationPresent: g.noDeclarationPresent, correctRejections: g.correctRejections,
  spuriousDeclarations: g.spuriousDeclarations, finalProximity: g.finalProximity,
  noLeakDeclarations: g.noLeakDeclarations, nativeAbstentions: g.nativeAbstentions,
  meanNormalizedError: g.errors ? g.errorSum / g.errors : null,
  meanElapsedSeconds: g.timeSum / g.missions,
  meanPathNormalized: g.pathSum / g.missions,
  meanContactEpisodes: g.contactsSum / g.missions,
  meanActiveProbes: g.activeProbesSum / g.missions,
  meanQuadSniffCycles: g.quadSniffCyclesSum / g.missions,
  meanQuadChannelReturns: g.quadChannelReturnsSum / g.missions,
  meanCandidateEvaluations: g.candidateEvaluationsSum / g.missions,
  meanDeclarationEvaluations: g.declarationEvaluationsSum / g.missions,
}))
const cellRates = [...cellOutcomes.values()]
const families = [...new Set(table.map((r) => r.family))]
const rankings = families.map((family) => ({ family, algorithms: [...new Set(table.filter((r) => r.family === family).map((r) => r.algorithm))]
  .map((algorithm) => {
    const rows = cellRates.filter((r) => r.family === family && r.algorithmId === algorithm)
    return { algorithm, cells: rows.length, meanCellCorrectRate: rows.reduce((s, r) => s + r.correct / r.n, 0) / rows.length }
  }).sort((a, b) => b.meanCellCorrectRate - a.meanCellCorrectRate) }))
console.log(JSON.stringify({ table, outcomes: Object.fromEntries(outcomes),
  paired: Object.fromEntries(paired), descriptiveCellRankings: rankings }, null, 2))
