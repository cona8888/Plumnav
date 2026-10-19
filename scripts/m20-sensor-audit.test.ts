import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { biasWitnesses, centralWitness, quadWitness, runM20, M20_DESIGN } from './lib/m20-sensor-audit'
import { M20_ROOT } from './m20-sensor-audit'
const relative = (actual: number, expected: number) => Math.abs(actual / expected - 1)
it('verifies direct production sensor response, clipping and mismatch witnesses', () => {
  const b = biasWitnesses()
  for (const r of b.crossTalk) expect(r.contrast).toBeCloseTo(r.expected, 12)
  expect(b.gainMismatch.falseContrast).toBeCloseTo(b.gainMismatch.expected, 12)
  const q = quadWitness(0.5, 0.05, 0.5, 20001)
  expect(relative(q.contrastVariance, q.interiorPrediction.contrastVariance)).toBeLessThan(0.08)
  const z = quadWitness(0, 0.05, 0, 20002)
  expect(relative(z.means[0]!, z.zeroMeanPrediction)).toBeLessThan(0.08)
  expect(z.zeroFraction).toBeGreaterThan(0.48); expect(z.zeroFraction).toBeLessThan(0.52)
  const c = centralWitness(0.5, 21001)
  expect(relative(c.variance, c.predictedVariance)).toBeLessThan(0.08)
  expect(c.correlation).toBeCloseTo(c.predictedCorrelation, 1)
})
it.skipIf(process.env.M20_VERIFY !== '1')('verifies frozen inputs, exactly replays all witnesses, and checks preregistered formulas', async () => {
  const read = async (name: string) => JSON.parse(await readFile(`${M20_ROOT}/${name}`, 'utf8'))
  const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
  const inventory = await read('checksums.json'); const design = await read('design.json')
  expect(inventory.complete).toBe(true); expect(design.sourceInventory).toHaveLength(86)
  for (const e of inventory.inventory) expect(hash(await readFile(`${M20_ROOT}/${e.path}`))).toBe(e.sha256)
  for (const e of design.sourceInventory) {
    expect(hash(await readFile(`${M20_ROOT}/source-snapshot/${e.path}`))).toBe(e.sha256)
    expect(hash(await readFile(e.path))).toBe(e.sha256)
  }
  const result = runM20(); expect(result).toEqual(await read('results.json'))
  expect(result.quad).toHaveLength(27); expect(result.central).toHaveLength(3)
  for (const r of result.quad.filter((r) => r.level === 0.5)) {
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(r.means[i]! - 0.5)).toBeLessThan(M20_DESIGN.biasTolerance)
      expect(relative(r.covariance[i]![i]!, r.interiorPrediction.variance)).toBeLessThan(M20_DESIGN.relativeTolerance)
    }
    const correlation = r.covariance[0]![2]! / Math.sqrt(r.covariance[0]![0]! * r.covariance[2]![2]!)
    expect(Math.abs(correlation - r.rho)).toBeLessThan(M20_DESIGN.correlationTolerance)
    expect(relative(r.contrastVariance, r.interiorPrediction.contrastVariance)).toBeLessThan(M20_DESIGN.relativeTolerance)
  }
  for (const r of result.central) {
    expect(relative(r.variance, r.predictedVariance)).toBeLessThan(M20_DESIGN.relativeTolerance)
    expect(Math.abs(r.correlation - r.predictedCorrelation)).toBeLessThan(M20_DESIGN.correlationTolerance)
    expect(Math.abs(r.mean)).toBeLessThan(M20_DESIGN.biasTolerance)
  }
  for (const r of result.quad.filter((r) => r.level === 0)) expect(relative(r.means[0]!, r.zeroMeanPrediction)).toBeLessThan(0.08)
})
