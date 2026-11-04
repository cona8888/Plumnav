import { describe, expect, it } from 'vitest'
import { createDefaultConfig, validateSimulationConfig } from '../src/sim/config'
import { GSL_REFERENCE_DESIGN } from '../src/sim/physicalDesign'
import { parseBenchCsv, runBenchCalibration, syntheticBenchTraces, withCalibratedSIInlet } from './field-sensor-calibration'

describe('controlled input calibration', () => {
  const { training, holdout } = syntheticBenchTraces()
  const report = runBenchCalibration(training, holdout)

  it('recovers the manufactured parameters and predicts the independent pulse trace', () => {
    expect(report.fit.riseSeconds).toBeCloseTo(1.75, 1)
    expect(report.fit.recoverySeconds).toBeCloseTo(3.5, 1)
    expect(report.holdoutRmsePpm).toBeLessThan(0.003)
    expect(report.holdoutRmsePpm).toBeLessThan(report.baselineHoldoutRmsePpm)
  })

  it('carries the fit into the actual SI channel and recomputes stop-and-measure timing', () => {
    const base = createDefaultConfig('quad-sniff-refine', 'open')
    const design = { ...GSL_REFERENCE_DESIGN, referenceWindMetresPerSecond: 0.02 }
    const config = withCalibratedSIInlet(base, report.fit, design)
    validateSimulationConfig(config)
    expect(config.localInletSampling!.riseTimeConstantSeconds).toBe(report.fit.riseSeconds)
    expect(config.localInletSampling!.recoveryTimeConstantSeconds).toBe(report.fit.recoverySeconds)
    expect(config.activeSniffCycleSeconds).toBe(14.5)
    expect(() => withCalibratedSIInlet(base, report.fit, { ...design, actualFlowLitresPerMinute: 2 })).toThrow(/setups differ/)
  })

  it('accepts signed blank-corrected readings and checks trace excitation and separation', () => {
    const csv = 'time_s,inlet_ppm,measured_ppm\n0,0,-0.001\n1,1,0\n2,1,0.3\n3,0,0.5'
    expect(parseBenchCsv(csv)[0].measuredPpm).toBe(-0.001)
    expect(() => parseBenchCsv(csv.replace('3,0', '2,0'))).toThrow(/timestamp/)
    expect(() => parseBenchCsv(csv.replace('3,0', '3,1'))).toThrow(/falling/)
    expect(() => parseBenchCsv(csv.replace('2,1,0.3', '2,,0.3'))).toThrow(/fields/)
    expect(() => runBenchCalibration(training, structuredClone(training))).toThrow(/separate/)
  })
})
