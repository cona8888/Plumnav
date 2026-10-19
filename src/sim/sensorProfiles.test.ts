import { describe, expect, it } from 'vitest'
import { createDefaultConfig, effectiveSensorThreshold, validateSimulationConfig } from './config'
import {
  COMMERCIAL_SENSOR_PROFILES,
  commercialSensorPatch,
  sensorT90Seconds,
} from './sensorProfiles'

describe('commercial sensor profiles', () => {
  it('maps native ppm limits through the declared dimensionless bridge', () => {
    for (const profile of COMMERCIAL_SENSOR_PROFILES) {
      const patch = commercialSensorPatch(profile, 1_000)
      expect(patch.sensorDetectionFloor).toBeCloseTo(profile.lowerLimitPpm / 1_000, 12)
      expect(sensorT90Seconds(patch.sensorLag)).toBeCloseTo(profile.responseT90Seconds, 12)
      expect(() => validateSimulationConfig({ ...createDefaultConfig(), ...patch })).not.toThrow()
    }
  })

  it('uses the commercial floor instead of the legacy scenario threshold', () => {
    const profile = COMMERCIAL_SENSOR_PROFILES.find(({ id }) => id === 'tdlas-extractive')!
    const config = { ...createDefaultConfig(), ...commercialSensorPatch(profile, 1_000) }
    expect(effectiveSensorThreshold(config)).toBeCloseTo(0.0004, 12)
  })

  it('retains the legacy dimensionless reference when no commercial floor is selected', () => {
    const config = createDefaultConfig()
    expect(config.sensorDetectionFloor).toBe(0)
    expect(effectiveSensorThreshold(config)).toBeCloseTo(0.115, 12)
  })

  it('defines the lower-cost MEMS-MOS class from its documented LEL range', () => {
    const profile = COMMERCIAL_SENSOR_PROFILES.find(({ id }) => id === 'mems-mos-tgs8410')!
    expect(profile.lowerLimitPpm).toBe(500)
    expect(profile.rangeMaxPpm).toBe(12_500)
    expect(profile.responseLabel).toMatch(/timing proxy; T90 not specified/)
    const config = { ...createDefaultConfig(), ...commercialSensorPatch(profile, 1_000) }
    expect(effectiveSensorThreshold(config)).toBeCloseTo(0.5, 12)
    expect(() => validateSimulationConfig(config)).not.toThrow()
  })

  it('defines the sub-£50 MQ-4 class without treating its range floor as a certified LOD', () => {
    const profile = COMMERCIAL_SENSOR_PROFILES.find(({ id }) => id === 'budget-mq4')!
    expect(profile.lowerLimitPpm).toBe(300)
    expect(profile.rangeMaxPpm).toBe(10_000)
    expect(profile.lowerLimitLabel).toMatch(/not a certified LOD/)
    expect(profile.priceEvidence).toMatch(/£4\.08/)
    const config = { ...createDefaultConfig(), ...commercialSensorPatch(profile, 1_000) }
    expect(effectiveSensorThreshold(config)).toBeCloseTo(0.3, 12)
    expect(() => validateSimulationConfig(config)).not.toThrow()
  })
})
