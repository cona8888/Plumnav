import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { M19_ORDERS, type studyM19Setting } from './lib/m19-scan-order'

type SettingResult = ReturnType<typeof studyM19Setting>
export const m19TransitionGraph = (result: SettingResult) => {
  const graph: Record<string, string[]> = {}
  for (const order of M19_ORDERS) for (const bearing of [0, 1]) graph[`${order}-${bearing}`] = []
  for (const r of result.factorial) {
    const c = r.context
    if (c.previousOrder === null || c.previousBearing === c.currentBearing) continue
    graph[`${c.previousOrder}-${c.previousBearing}`] = r.candidates.filter((a) => a.feasible).map((a) => `${a.order}-${c.currentBearing}`)
  }
  let viable = new Set(Object.keys(graph)); let pruningRounds = 0
  while (true) {
    const next = new Set([...viable].filter((s) => graph[s]!.some((t) => viable.has(t))))
    if (next.size === viable.size) break
    viable = next; pruningRounds++
  }
  const longest = new Map<string, number>()
  const length = (s: string): number => {
    if (!longest.has(s)) longest.set(s, graph[s]!.length ? 1 + Math.max(...graph[s]!.map(length)) : 0)
    return longest.get(s)!
  }
  const longestFiniteQualifiedStreak = viable.size ? null : Math.max(...Object.keys(graph).map(length))
  return { setting: result.setting, graph, states: Object.keys(graph).length,
    edges: Object.values(graph).reduce((n, e) => n + e.length, 0), pruningRounds,
    indefinitelyViableStates: [...viable].sort(), longestFiniteQualifiedStreak }
}

const root = 'research/evidence/m19_scan_order_2026-09-08'
const analysisRoot = 'research/analysis/m19_scan_order_2026-09-08'
const output = join(analysisRoot, 'posthoc-transition-audit')
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
export const auditM19Transitions = async () => {
  const inventory = JSON.parse(await readFile(join(root, 'checksums.json'), 'utf8'))
  const checked: Array<{ path: string; sha256: string }> = []
  const readChecked = async (path: string) => {
    const e = inventory.inventory.find((r: any) => r.path === path); const b = await readFile(join(root, path))
    if (!e || b.length !== e.bytes || hash(b) !== e.sha256) throw new Error(`Artifact mismatch: ${path}`)
    checked.push({ path: join(root, path), sha256: e.sha256 }); return JSON.parse(b.toString())
  }
  const design = await readChecked('design.json'); const graphs = []
  for (const setting of design.settings) {
    const result = await readChecked(`${setting.id}.json`) as SettingResult
    if (json(result.setting) !== json(setting) || result.factorial.length !== 34) throw new Error('Setting mismatch')
    for (const r of result.factorial) for (const c of r.candidates) if (c.feasible !== Object.values(c.gates).every(Boolean)) throw new Error('Saved gate mismatch')
    graphs.push(m19TransitionGraph(result))
  }
  if (graphs.length !== 18 || graphs.some((g) => g.states !== 16)) throw new Error('Incomplete graph audit')
  const audit = { postHoc: true, geometryOnly: true, noPolicyChanges: true, advancesToPhysicalPlumeBenchmark: false,
    scope: 'Fixed M19 maps, reaches, models, noise/caps, six-second window, five-second block interval and alternating two bearings only.',
    sourceInventorySha256: design.sourceInventorySha256, inputHashes: checked, graphs }
  const report = ['# M19 transition audit — post hoc, no new policy or outcome data',
    'This audit asks whether a longer-horizon order planner could evade the greedy selector failure while leaving the tested alternating bearings, interval, reach pair, model and acceptance rules unchanged.',
    'A state is the immediately preceding three-sniff order and its bearing (16 states). An edge is a current order that passes every archived geometry/noise check at the opposite bearing. With the six-second window and five-second block interval, only the immediately preceding block is retained; the row geometry repeats under whole-block time translation after warm-up. Remove states with no successor until a fixed point remains. If the surviving set is empty, the graph is acyclic and every fully qualified sequence terminates.',
    '| Setting | Feasible edges | Indefinitely viable states | Longest qualified streak |\n|---|---:|---:|---:|\n' + graphs.map((g) =>
      `| ${g.setting.id} | ${g.edges} | ${g.indefinitelyViableStates.length} | ${g.longestFiniteQualifiedStreak ?? 'cyclic'} |`).join('\n'),
    'This is a finite-graph statement about these archived nominal-noise checks, not an information-theoretic impossibility result for gas localization or all active-sensing designs. It does not cover other bearings, longer integrations, robot movement, different uncertainty models, a different confirmation statistic or additional sensors. Exploration-only fallback measurements can reset history, but cannot be counted as qualified confirmation decisions.',
    'The graph does not change the frozen M19 eligibility decision and uses no plume outcomes. It prevents proposing another greedy-versus-lookahead order campaign when the existing finite transition graph already rules out an uninterrupted qualified sequence under the fixed assumptions.',
  ].join('\n\n') + '\n'
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'audit.json'), json(audit), { flag: 'wx' })
  await writeFile(join(output, 'audit.md'), report, { flag: 'wx' })
  await copyFile('scripts/m19-transition-audit.ts', join(output, 'audit-source.ts'))
  const checksums = await Promise.all(['audit.json', 'audit.md', 'audit-source.ts'].map(async (path) => {
    const b = await readFile(join(output, path)); return { path, bytes: b.length, sha256: hash(b) }
  }))
  await writeFile(join(output, 'checksums.json'), json(checksums), { flag: 'wx' })
  process.stdout.write(json({ postHoc: true, graphs: graphs.map(({ graph, ...g }) => g), noPolicyChanges: true }))
}
if (process.env.M19_TRANSITION_AUDIT_RUN === '1') auditM19Transitions().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
