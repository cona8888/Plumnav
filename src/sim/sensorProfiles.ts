import type { SensorProfileId, SimulationConfig } from './types'

export type CommercialSensorProfile = {
  id: Exclude<SensorProfileId, 'normalized-reference' | 'custom'>
  shortLabel: string
  product: string
  technology: string
  measurement: 'point / extractive'
  lowerLimitPpm: number
  lowerLimitLabel: string
  responseT90Seconds: number
  responseLabel: string
  precisionProxyPpm: number
  rangeMaxPpm: number
  rangeLabel: string
  deploymentNote: string
  sourceUrl: string
  sourceLabel: string
  priceEvidence?: string
  priceUrl?: string
}

export const COMMERCIAL_SENSOR_PROFILES: readonly CommercialSensorProfile[] = [
  {
    id: 'mps-mems',
    shortLabel: 'MEMS · MPS methane',
    product: 'NevadaNano MPS Methane Gas Sensor',
    technology: 'MEMS molecular-property sensor',
    measurement: 'point / extractive',
    lowerLimitPpm: 50,
    lowerLimitLabel: '0.1% LEL resolution (≈50 ppm CH₄)',
    responseT90Seconds: 20,
    responseLabel: 'T90 < 20 s',
    precisionProxyPpm: 50,
    rangeMaxPpm: 50_000,
    rangeLabel: '0–100% LEL standard range',
    deploymentNote: 'Compact safety-class sensor. The 0.1% LEL resolution is converted using 5% vol methane LEL and used as a quantisation/noise proxy, not a certified statistical noise standard deviation.',
    sourceUrl: 'https://nevadanano.com/products/mps-methane-gas-sensor/',
    sourceLabel: 'NevadaNano product specification',
  },
  {
    id: 'mems-mos-tgs8410',
    shortLabel: 'Lower-cost MEMS-MOS · TGS8410',
    product: 'Figaro TGS8410 Methane Sensor',
    technology: 'MEMS metal-oxide semiconductor (MOS)',
    measurement: 'point / extractive',
    lowerLimitPpm: 500,
    lowerLimitLabel: '1% LEL lower range (≈500 ppm CH₄)',
    responseT90Seconds: 30,
    responseLabel: '30 s heater/readout cycle used as timing proxy; T90 not specified',
    precisionProxyPpm: 500,
    rangeMaxPpm: 12_500,
    rangeLabel: '1–25% LEL (≈500–12,500 ppm CH₄)',
    deploymentNote: 'Lower-cost, ultra-low-power class: Figaro reports 0.087 mW average heater power and a more affordable cost than NDIR. The output is resistance-based and nonlinear; the lower range and heater cycle are conservative simulation proxies, not LOD, noise-SD or T90 specifications.',
    sourceUrl: 'https://www.figarosensor.com/product/entry/tgs8410.html',
    sourceLabel: 'Figaro product specification',
  },
  {
    id: 'budget-mq4',
    shortLabel: 'Budget <£50 · MQ-4 module',
    product: 'MQ-4 commodity methane module class',
    technology: 'heated SnO₂ semiconductor (MOS)',
    measurement: 'point / extractive',
    lowerLimitPpm: 300,
    lowerLimitLabel: '300 ppm lower specified range; not a certified LOD',
    responseT90Seconds: 30,
    responseLabel: '30 s modelling proxy; manufacturer T90 not specified',
    precisionProxyPpm: 300,
    rangeMaxPpm: 10_000,
    rangeLabel: '300–10,000 ppm CH₄',
    deploymentNote: 'Very-low-cost qualitative comparator. The manufacturer requires at least 48 h preheating and reports up to 1 W heater demand. Temperature, humidity, oxygen content, ageing, load resistance and calibration strongly affect the nonlinear output; the 300 ppm floor/noise and 30 s timing are conservative modelling proxies.',
    sourceUrl: 'https://www.winsen-sensor.com/product/mq-4.html',
    sourceLabel: 'Winsen MQ-4 specification',
    priceEvidence: 'UK retail example: £4.08 including VAT when checked 11 September 2026; price and availability can change',
    priceUrl: 'https://www.skpang.co.uk/products/methane-cng-gas-sensor-mq-4',
  },
  {
    id: 'ndir-platinum',
    shortLabel: 'NDIR · Platinum CH₄',
    product: 'Dynament Platinum Hydrocarbon Sensor',
    technology: 'non-dispersive infrared (NDIR)',
    measurement: 'point / extractive',
    lowerLimitPpm: 100,
    lowerLimitLabel: '0.01% vol (100 ppm) display resolution',
    responseT90Seconds: 30,
    responseLabel: 'T90 < 30 s',
    precisionProxyPpm: 100,
    rangeMaxPpm: 50_000,
    rangeLabel: '0–5% vol high-resolution range',
    deploymentNote: 'Resolution is not the same as limit of detection. The preset therefore represents a conservative engineering response class, not a calibration certificate.',
    sourceUrl: 'https://dynament.com/product/hydrocarbon-infrared-platinum-sensors/',
    sourceLabel: 'Dynament product specification',
  },
  {
    id: 'tdlas-extractive',
    shortLabel: 'TDLAS · Compact-A CH₄',
    product: 'Axetris LGD Compact-A CH₄',
    technology: 'extractive tunable-diode laser spectroscopy',
    measurement: 'point / extractive',
    lowerLimitPpm: 0.4,
    lowerLimitLabel: '< 0.4 ppm lower detection limit',
    responseT90Seconds: 1.8,
    responseLabel: 'T90 1.8 s at 2 L/min',
    precisionProxyPpm: 0.8,
    rangeMaxPpm: 40_000,
    rangeLabel: 'up to 40,000 ppm',
    deploymentNote: 'The stated response assumes 2 L/min sample flow. Tubing length, pump dynamics and inlet filtering must be added for a deployed robot.',
    sourceUrl: 'https://www.axetris.com/en-us/product/LGD-Compact-A-CH4',
    sourceLabel: 'Axetris product specification',
  },
  {
    id: 'crds-g2401',
    shortLabel: 'CRDS · G2401 analyzer',
    product: 'Picarro G2401 Gas Concentration Analyzer',
    technology: 'cavity ring-down spectroscopy (CRDS)',
    measurement: 'point / extractive',
    lowerLimitPpm: 0.001,
    lowerLimitLabel: '1 ppb CH₄ precision at 5 s',
    responseT90Seconds: 5,
    responseLabel: '< 5 s rise/fall time',
    precisionProxyPpm: 0.001,
    rangeMaxPpm: 20,
    rangeLabel: '0–20 ppm CH₄ range',
    deploymentNote: 'High sensitivity but laboratory-analyzer mass, power and pump requirements make four onboard analyzers unrealistic. A shared analyzer with multiplexed inlets would need extra switching delay.',
    sourceUrl: 'https://www.picarro.com/analytical/products/g2401_gas_concentration_analyzer',
    sourceLabel: 'Picarro product specification',
  },
] as const

export const OPEN_PATH_TDLAS_PROFILE = {
  product: 'Heath RMLD-IS',
  technology: 'open-path TDLAS',
  measurement: 'path-integrated',
  sensitivity: '5 ppm·m at 0–15 m; 10 ppm·m at 15–30 m',
  range: '0–99,999 ppm·m',
  note: 'Not applied to the present point-sensor engine. It requires ray/path integration through the plume and a beam-geometry observation model.',
  sourceUrl: 'https://heathus.com/wp-content/uploads/2023/08/101296-0-RMLD-IS-Manual-Rev-K.pdf',
} as const

export const commercialSensorProfile = (id: SensorProfileId) =>
  COMMERCIAL_SENSOR_PROFILES.find((profile) => profile.id === id)

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value))

/**
 * Maps manufacturer-native ppm and timing values into the dimensionless sensor
 * interface. The concentration bridge is an explicit sensitivity-analysis
 * assumption, not a claim that the plume solver predicts calibrated ppm.
 */
export const commercialSensorPatch = (
  profile: CommercialSensorProfile,
  ppmPerNormalizedUnit: number,
): Pick<
  SimulationConfig,
  | 'sensorProfileId'
  | 'sensorPpmPerNormalizedUnit'
  | 'sensorDetectionFloor'
  | 'sensorNoise'
  | 'sensorLag'
  | 'sensorThresholdScale'
  | 'sensorSaturation'
> => {
  const detectionFloor = profile.lowerLimitPpm / ppmPerNormalizedUnit
  const saturation = clamp(profile.rangeMaxPpm / ppmPerNormalizedUnit, detectionFloor, 2)
  return {
    sensorProfileId: profile.id,
    sensorPpmPerNormalizedUnit: ppmPerNormalizedUnit,
    sensorDetectionFloor: detectionFloor,
    sensorNoise: clamp(profile.precisionProxyPpm / ppmPerNormalizedUnit, 0, 0.5),
    // The simulator uses a first-order time constant, tau. T90 = ln(10) * tau.
    sensorLag: profile.responseT90Seconds / Math.log(10),
    sensorThresholdScale: 1,
    sensorSaturation: saturation,
  }
}

export const sensorT90Seconds = (sensorLag: number) => sensorLag * Math.log(10)
