/** Post-run falsification check: coherent model bias can evade residual checks. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { physicalBearingIntersection } from '../src/sim/algorithms/physicalBearingGeometry'
const root = 'research/evidence/m78_coherent_bias_counterexample_2026-09-13'
await mkdir(root, { recursive: true })
const files = ['scripts/m78-coherent-bias-check.ts', 'src/sim/algorithms/physicalBearingGeometry.ts', 'src/sim/math.ts']
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const sourceInventory = []
for (const [i, file] of files.entries()) {
  const bytes = await readFile(file)
  await writeFile(`${root}/source-${i}.ts`, bytes, { flag: 'wx' })
  sourceInventory.push({ file, snapshot: `source-${i}.ts`, sha256: hash(bytes) })
}
const truth = { x: 0.5, y: 0.5 }, apparent = { x: 0.502, y: 0.5 }
await writeFile(`${root}/manifest.json`, JSON.stringify({ purpose: 'Post-run coherent-bias falsification, not a random-noise coverage experiment',
  trueTarget: truth, apparentTarget: apparent, domainMetres: 100, sigmaRadians: 0.01, sourceInventory }, null, 2), { flag: 'wx' })
const rays = [[-0.4, -0.3], [0.4, -0.3], [0, 0.5], [-0.5, 0.1]].map(([x, y]) => {
  const origin = { x: truth.x + x! / 100, y: truth.y + y! / 100 }
  const dx = apparent.x - origin.x, dy = apparent.y - origin.y, length = Math.hypot(dx, dy)
  return { time: 0, origin, direction: { x: dx / length, y: dy / length }, weight: 1, angularSigma: 0.01 }
})
const fit = physicalBearingIntersection(rays, 0.001, 0.001)!
const errorMetres = Math.hypot(fit.point.x - truth.x, fit.point.y - truth.y) * 100
if (!fit.physicalUncertainty!.acceptable || errorMetres < 0.19) throw new Error('Counterexample was not reproduced')
const result = { fit, trueErrorMetres: errorMetres,
  nominalRadius95Metres: fit.physicalUncertainty!.nominalRadius95 * 100,
  implication: 'Conditional covariance cannot bound coherent model bias. This tests geometry only, not a false end-to-end declaration.' }
await writeFile(`${root}/result.json`, JSON.stringify(result, null, 2), { flag: 'wx' })
const inventory = []
for (const file of ['manifest.json', 'result.json']) inventory.push({ file, sha256: hash(await readFile(`${root}/${file}`)) })
await writeFile(`${root}/complete.json`, JSON.stringify({ complete: true, inventory }, null, 2), { flag: 'wx' })
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
