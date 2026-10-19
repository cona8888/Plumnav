import { correctDirectionReadings } from './lib/m21-direction'
import { M21_NUISANCES, m21Calibrate } from './lib/m21-direction-study'
import { m24Angle, m24Episode, M24_DYNAMICS } from './lib/m24-time-aware'
import { M23_ANGLES } from './lib/m23-rotation-transfer'

const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x))
const solve3 = (a: number[][], b: number[]) => {
  const m = a.map((r, i) => [...r, b[i]!])
  for (let k = 0; k < 3; k++) { let p = k; for (let i = k + 1; i < 3; i++) if (Math.abs(m[i]![k]!) > Math.abs(m[p]![k]!)) p = i
    ;[m[k], m[p]] = [m[p]!, m[k]!]; const q = m[k]![k]!; if (Math.abs(q) < 1e-12) return null
    for (let j = k; j < 4; j++) m[k]![j] /= q
    for (let i = 0; i < 3; i++) if (i !== k) { const q2 = m[i]![k]!; for (let j = k; j < 4; j++) m[i]![j] -= q2 * m[k]![j]! }
  }
  return [m[0]![3]!, m[1]![3]!, m[2]![3]!]
}
const quadratic = (views: any[], calibration: any) => {
  const rows = views.map((v) => { const z = correctDirectionReadings(v.values, calibration), bx = z[0]! - z[2]!, by = z[3]! - z[1]!
    return { t: v.time - 0.25 - 10, a: Math.atan2(bx * Math.sin(v.heading) + by * Math.cos(v.heading), bx * Math.cos(v.heading) - by * Math.sin(v.heading)) } })
  const angles = [rows[0]!.a]; for (let i = 1; i < 4; i++) angles.push(angles[i - 1]! + wrap(rows[i]!.a - rows[i - 1]!.a))
  const sums = (power: number) => rows.reduce((s, r) => s + r.t ** power, 0), rhs = (power: number) => rows.reduce((s, r, i) => s + r.t ** power * angles[i]!, 0)
  const c = solve3([[4, sums(1), sums(2)], [sums(1), sums(2), sums(3)], [sums(2), sums(3), sums(4)]], [rhs(0), rhs(1), rhs(2)])!
  const pred = c[0]! + c[1]! * 2.5 + c[2]! * 2.5 ** 2, residual = Math.max(...rows.map((r, i) => Math.abs(wrap(angles[i]! - (c[0]! + c[1]! * r.t + c[2]! * r.t ** 2)))))
  return { pred, residual, acceleration: 2 * c[2]! }
}
const thresholds = [2, 5, 10, 15, 20, 30].map((x) => x * Math.PI / 180), stats = new Map<string, { n: number; ok: number }>()
for (const [ni, n] of M21_NUISANCES.entries()) if (n.lag <= 0.75) for (let rep = 0; rep < 2; rep++) {
  const calibration = m21Calibrate(n, 63000 + ni * 2 + rep).calibration
  for (const [di, dynamic] of M24_DYNAMICS.entries()) for (const [pi, phase] of M23_ANGLES.entries()) for (const [bi, body] of M23_ANGLES.entries()) for (let trial = 0; trial < 5; trial++) {
    const seed = 3000000 + ni * 200000 + rep * 100000 + di * 8000 + pi * 800 + bi * 10 + trial, e = m24Episode(n, dynamic, phase, body, seed, calibration), d = e.decisions.find((x) => x.arm === 'time-aware')!
    if (!d.direction) continue
    const truth = m24Angle(dynamic, phase, 12.5), linear = Math.atan2(d.direction.y, d.direction.x) + d.fittedRate!, quad = quadratic(e.views, calibration)
    for (const [method, pred, residual] of [['linear', linear, d.maximumResidual!], ['quadratic', quad.pred, quad.residual],
      ['hybrid-0.1', quad.acceleration > 0.1 ? quad.pred : linear, d.maximumResidual!], ['hybrid-0.2', quad.acceleration > 0.2 ? quad.pred : linear, d.maximumResidual!],
      ['hybrid-0.3', quad.acceleration > 0.3 ? quad.pred : linear, d.maximumResidual!]] as const) for (const threshold of thresholds) {
      const key = `${method}|${Math.round(threshold * 180 / Math.PI)}|${n.id}|${dynamic.id}`, s = stats.get(key) ?? { n: 0, ok: 0 }
      if (residual <= threshold) { s.n++; s.ok += Number(Math.cos(pred - truth) > 0) } stats.set(key, s)
    }
  }
}
for (const method of ['linear', 'quadratic']) for (const threshold of thresholds) {
  const rows = [...stats].filter(([k]) => k.startsWith(`${method}|${Math.round(threshold * 180 / Math.PI)}|`)).map(([, v]) => v), n = rows.reduce((s, v) => s + v.n, 0), ok = rows.reduce((s, v) => s + v.ok, 0)
  const supported = rows.filter((v) => v.n >= 320), failures = supported.filter((v) => v.ok / v.n < 0.9)
  console.log(JSON.stringify({ method, residualDegrees: Math.round(threshold * 180 / Math.PI), accepted: n, positive: ok / n, supportedCells: supported.length, failingCells: failures.length }))
}
for (const [key, value] of stats) if (key.includes('|30|gain-drift|reverse-positive')) console.log(JSON.stringify({ key, ...value, positive: value.ok / value.n }))
for (const method of ['linear','quadratic']) for (const dynamic of ['accelerate-positive','accelerate-negative','reverse-positive','reverse-negative']) { const rows=[...stats].filter(([k])=>k.startsWith(`${method}|30|`)&&k.endsWith(`|${dynamic}`)).map(([,v])=>v),n=rows.reduce((s,v)=>s+v.n,0),ok=rows.reduce((s,v)=>s+v.ok,0); console.log(JSON.stringify({method,dynamic,n,positive:ok/n})) }
for (const method of ['hybrid-0.1','hybrid-0.2','hybrid-0.3']) { const rows=[...stats].filter(([k])=>k.startsWith(`${method}|30|`)).map(([,v])=>v),n=rows.reduce((s,v)=>s+v.n,0),ok=rows.reduce((s,v)=>s+v.ok,0),fail=rows.filter(v=>v.n>=320&&v.ok/v.n<.9).length; console.log(JSON.stringify({method,n,positive:ok/n,failingCells:fail})) }
