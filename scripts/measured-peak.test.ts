import { describe, expect, it } from 'vitest'
import { horizontalDistanceMetres, replayMeasuredPeak, replayTrackPeak } from './lib/measured-peak'

describe('measured peak on a recorded trajectory', () => {
  it('retains signed measurements, the first tied maximum and repeated GPS fixes', () => {
    const rows = [-2, -1, -3, -1].map((methanePpm, i) => ({ timeSeconds: i, latitude: 52, longitude: i < 3 ? -2 : -2.001, methanePpm }))
    expect(replayMeasuredPeak(rows)).toEqual({ index: 1, latitude: 52, longitude: -2, methanePpm: -1 })
    expect(horizontalDistanceMetres(rows[0]!, rows[3]!)).toBeCloseTo(68.46, 1)
  })
  it('rejects empty, corrupted and reversed time-series inputs', () => {
    expect(() => replayTrackPeak([])).toThrow(/Empty/)
    const first = { timeSeconds: 4, xMetres: 0, yMetres: 0, value: 1 }
    expect(() => replayTrackPeak([first, { ...first, value: NaN }])).toThrow(/Invalid/)
    expect(() => replayTrackPeak([first, { ...first, timeSeconds: 2 }])).toThrow(/unordered/)
  })
})
