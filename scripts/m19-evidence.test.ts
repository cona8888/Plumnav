import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { M19_DESIGN, m19Settings, m19Contexts, studyM19Setting, m19Rows, m19Events } from './lib/m19-scan-order'
import { m19TransitionGraph } from './m19-transition-audit'

const root = 'research/evidence/m19_scan_order_2026-09-08'
const read = async (p: string) => JSON.parse(await readFile(join(root, p), 'utf8'))
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
it('verifies all M19 artifacts, unchanged inherited sources and frozen design', async () => {
  const design = await read('design.json'); const inventory = await read('checksums.json')
  expect(inventory.complete).toBe(true); expect(inventory.inventory).toHaveLength(20)
  expect(design.sourceInventory).toHaveLength(82); expect(design.settings).toEqual(m19Settings()); expect(design.contexts).toEqual(m19Contexts())
  for (const [k, v] of Object.entries(M19_DESIGN)) expect(design[k]).toEqual(v)
  for (const [prefix, entries] of [['', inventory.inventory], ['source-snapshot/', design.sourceInventory]] as const) {
    for (const e of entries) {
      const b = await readFile(join(root, `${prefix}${e.path}`)); expect(hash(b), e.path).toBe(e.sha256); expect(b.length).toBe(e.bytes)
      if (prefix) expect(hash(await readFile(e.path)), e.path).toBe(e.sha256)
    }
  }
})
it('replays all 6048 candidate checks and independently checks selection, costs and eligibility', async () => {
  const summary = await read('summary.json')
  expect(summary.complete).toBe(true); expect(summary.factorialChecks).toBe(4896); expect(summary.rolloutChecks).toBe(1152)
  expect(summary.plumeTrajectories).toBe(0)
  let checks = 0; const eligibleIds = []
  for (const setting of m19Settings()) {
    const archived = await read(`${setting.id}.json`); const replay = studyM19Setting(setting)
    expect(JSON.stringify(replay)).toBe(JSON.stringify(archived))
    const decisions = [...replay.factorial, ...replay.rollouts.flatMap((r) => r.steps.flatMap((s) => s.decision ? [s.decision] : []))]
    for (const d of decisions) {
      checks += d.candidates.length
      const feasible = d.candidates.filter((c) => Object.values(c.gates).every(Boolean))
      if (!feasible.length) expect(d.selectedOrder).toBeNull()
      else {
        const minimum = Math.min(...feasible.map((c) => c.score!))
        const tied = feasible.filter((c) => c.score! <= minimum + 1e-10)
        const minSwitches = Math.min(...tied.map((c) => c.switches))
        expect(d.selectedOrder).toBe(tied.filter((c) => c.switches === minSwitches).map((c) => c.order).sort()[0])
      }
    }
    for (const r of replay.rollouts) {
      expect(r.budget.samplingSeconds).toBe(r.events.reduce((n, e) => n + e.duration, 0))
      expect(r.budget.samplingSeconds).toBe(9); expect(r.events).toHaveLength(18)
      expect(r.budget.reachSwitches).toBe(r.events.slice(1).filter((e, i) => e.reach !== r.events[i]!.reach).length)
    }
    const qualifies = replay.factorial.filter((c) => c.context.previousOrder !== null).every((c) => c.selectedOrder !== null) &&
      replay.rollouts.every((r) => r.steps.slice(2).every((s) => s.decision!.selectedOrder !== null))
    expect(replay.eligibleForManufacturedDiagnostic).toBe(qualifies)
    if (qualifies) eligibleIds.push(setting.id)
  }
  expect(checks).toBe(6048)
  const folder = 'research/analysis/m19_scan_order_2026-09-08'
  const inventory = JSON.parse(await readFile(join(folder, 'analysis-checksums.json'), 'utf8'))
  for (const e of inventory) {
    const b = await readFile(join(folder, e.path)); expect(hash(b)).toBe(e.sha256); expect(b.length).toBe(e.bytes)
  }
  const analysis = JSON.parse(await readFile(join(folder, 'm19-analysis.json'), 'utf8'))
  expect(analysis.eligibleSettings).toEqual(eligibleIds); expect(analysis.advancesToPhysicalPlumeBenchmark).toBe(false)
})
it('checks the post-hoc transition graph independently and verifies steady schedule time translation', async () => {
  const folder = 'research/analysis/m19_scan_order_2026-09-08/posthoc-transition-audit'
  const inventory = JSON.parse(await readFile(join(folder, 'checksums.json'), 'utf8'))
  for (const e of inventory) {
    const b = await readFile(join(folder, e.path)); expect(hash(b)).toBe(e.sha256); expect(b.length).toBe(e.bytes)
  }
  const audit = JSON.parse(await readFile(join(folder, 'audit.json'), 'utf8'))
  expect(audit.postHoc).toBe(true); expect(audit.noPolicyChanges).toBe(true); expect(audit.graphs).toHaveLength(18)
  for (const e of audit.inputHashes) expect(hash(await readFile(e.path))).toBe(e.sha256)
  for (const setting of m19Settings()) {
    const raw = await read(`${setting.id}.json`); const result = m19TransitionGraph(raw)
    expect(result).toEqual(audit.graphs.find((g: any) => g.setting.id === setting.id))
    // Independent path enumeration (no dead-end pruning) checks acyclicity and
    // the maximum streak for this completed archive.
    const lengths: number[] = []
    const visit = (state: string, path: string[]) => {
      expect(path.includes(state), 'Cycle found').toBe(false)
      const next = result.graph[state]!
      if (!next.length) lengths.push(path.length)
      for (const target of next) visit(target, [...path, state])
    }
    for (const state of Object.keys(result.graph)) visit(state, [])
    expect(result.indefinitelyViableStates).toEqual([])
    expect(result.longestFiniteQualifiedStreak).toBe(Math.max(...lengths))
    for (const context of m19Contexts().filter((c) => c.previousOrder !== null)) {
      const at = (start: number) => m19Rows(setting, [
        ...m19Events(context.previousOrder!, start, context.previousBearing!, setting.reach, 0),
        ...m19Events('BLL', start + 5, context.currentBearing, setting.reach, 1),
      ], 1)
      const a = at(10); const b = at(30)
      expect(a.training).toEqual(b.training); expect(a.testing).toEqual(b.testing)
    }
  }
})
