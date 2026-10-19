import type { Vec2 } from '../../src/sim/types'

export const M15_CALIBRATION = Object.freeze({
  version: 'm15-manufactured-measurement-v1', diagnosticOnly: true,
  durationSeconds: 40, dt: 0.25, cycleSeconds: 0.75, firstScan: 10, interval: 2.5, scans: 12,
  wind: { x: 0.018, y: 0.006 }, diffusivity: 0.0004, center: { x: 0.5, y: 0.5 },
  gaussianWidth: 0.03, modulationPeriod: 8, modulationAmplitude: 0.25,
  strength: 0.78, bearing: 0.31, sensorLag: 0.05, saturation: 1.5,
  reaches: [0.065, 0.0325, 0.01625], windows: [6, 4], noiseSeeds: [15101, 15102, 15103, 15104],
  expectedTrajectories: 1440, expectedWindowAnalyses: 2880,
})
export const M15_FIELDS = ['quadratic-steady', 'quadratic-pulsing', 'gaussian-steady',
  'gaussian-pulsing', 'source-free-wave', 'zero'] as const
export type FieldId = typeof M15_FIELDS[number]
export type ExactFieldValue = { concentration: number; gradient: Vec2; laplacian: number; temporal: number; residual: number }

/** Evaluator-owned manufactured truth. No truth arguments enter the scorer. */
export const exactField = (field: FieldId, p: Vec2, t: number): ExactFieldValue => {
  const c = M15_CALIBRATION; const x = p.x - c.center.x; const y = p.y - c.center.y
  let concentration = 0; let gx = 0; let gy = 0; let laplacian = 0; let temporal = 0
  if (field === 'source-free-wave') {
    const kx = 8; const ky = 6; const k2 = kx * kx + ky * ky
    const ku = kx * c.wind.x + ky * c.wind.y
    const phase = kx * x + ky * y - ku * t
    const a = 0.2 * Math.exp(-c.diffusivity * k2 * t)
    const excess = a * Math.cos(phase)
    concentration = 0.8 + excess
    gx = -a * kx * Math.sin(phase); gy = -a * ky * Math.sin(phase)
    laplacian = -k2 * excess
    temporal = -c.diffusivity * k2 * excess + a * ku * Math.sin(phase)
  } else if (field !== 'zero') {
    const omega = 2 * Math.PI / c.modulationPeriod
    const pulsing = field.endsWith('pulsing')
    const a = pulsing ? 1 + c.modulationAmplitude * Math.sin(omega * t) : 1
    const at = pulsing ? c.modulationAmplitude * omega * Math.cos(omega * t) : 0
    let shape: number; let sx: number; let sy: number; let sl: number; let background = 0
    if (field.startsWith('gaussian')) {
      const s2 = c.gaussianWidth ** 2; const r2 = x * x + y * y
      shape = 0.8 * Math.exp(-r2 / (2 * s2)); background = 0.1
      sx = -x / s2 * shape; sy = -y / s2 * shape
      sl = (r2 / s2 ** 2 - 2 / s2) * shape
    } else {
      shape = 0.8 + 0.4 * x - 0.3 * y - 20 * x * x + 6 * x * y - 15 * y * y
      sx = 0.4 - 40 * x + 6 * y; sy = -0.3 + 6 * x - 30 * y; sl = -70
    }
    concentration = background + a * shape; gx = a * sx; gy = a * sy
    laplacian = a * sl; temporal = at * shape
  }
  return { concentration, gradient: { x: gx, y: gy }, laplacian, temporal,
    residual: temporal + c.wind.x * gx + c.wind.y * gy - c.diffusivity * laplacian }
}
export type CalibrationJob = {
  id: string; field: FieldId; offset: number; anchor: Vec2;
  sensing: 'active-suction' | 'passive-array'; reach: number; policy: 'fixed' | 'sniff-turn';
  delivery: 'midpoint' | 'integrated' | 'sensor'; noise: number; seed: number;
}
export const m15Jobs = (): CalibrationJob[] => M15_FIELDS.flatMap((field) =>
  (field.startsWith('gaussian') ? [0, 0.005, 0.015, 0.06] : [0]).flatMap((offset) =>
    ([...M15_CALIBRATION.reaches.map((reach) => ({ sensing: 'active-suction' as const, reach })),
      { sensing: 'passive-array' as const, reach: 0.0125 }]).flatMap((geometry) =>
      (['fixed', 'sniff-turn'] as const).flatMap((policy) =>
        (['midpoint', 'integrated', 'sensor'] as const).flatMap((delivery) =>
          [{ noise: 0, seed: 15101 }, ...M15_CALIBRATION.noiseSeeds.map((seed) => ({ noise: 0.025, seed }))].map((noise) => ({
            field, offset, anchor: { x: 0.5 + offset, y: 0.5 }, ...geometry, policy, delivery, ...noise,
            id: `${field}-x${offset}-${geometry.sensing}-r${geometry.reach}-${policy}-${delivery}-n${noise.noise}-s${noise.seed}`,
          })))))))
