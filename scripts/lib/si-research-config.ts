import { SENSOR_THRESHOLD_BY_SCENARIO, validateSimulationConfig } from '../../src/sim/config'
import { withLocalInletDesign } from '../../src/sim/localInletSampling'
import { methanePpmPerMassConcentration } from '../../src/sim/physicalAtmosphere'
import { GSL_REFERENCE_DESIGN, type GslPhysicalDesign } from '../../src/sim/physicalDesign'
import type { PhysicalAtmosphereConfig, SimulationConfig } from '../../src/sim/types'

/** M80 SI values, now attached to the engine without replacing query methods.
 * No calibrated sensor or soil-boundary interpretation is implied.
 */
export const SI_HALFSPACE_REFERENCE: PhysicalAtmosphereConfig = {
  version: 'halfspace-si-v1', diffusivityMetresSquaredPerSecond: .001,
  sourceWidthMetres: .15, releaseHeightMetres: .025, emissionRateKgPerSecond: 2e-9,
  sourceAgeAtMissionStartSeconds: 300, quadraturePanelSeconds: 2,
  measurement: { concentrationScaleKgPerCubicMetre: 1e-6, backgroundKgPerCubicMetre: 0,
    noiseKgPerCubicMetre: 1e-9, thresholdKgPerCubicMetre: 1.15e-7, saturationKgPerCubicMetre: 1.5e-6,
    temperatureKelvin: 298.15, pressurePascal: 101325 },
}
export function withSIResearchDesign(base: SimulationConfig,
  design: GslPhysicalDesign = { ...GSL_REFERENCE_DESIGN, referenceWindMetresPerSecond: .02 },
  atmosphere: PhysicalAtmosphereConfig = SI_HALFSPACE_REFERENCE,
  response = { recoveryTimeConstantSeconds: 2, maximumTurnRateRadiansPerSecond: Math.PI / 4 }) {
  if (design.effectiveDiffusivityMetresSquaredPerSecond !== undefined &&
      design.effectiveDiffusivityMetresSquaredPerSecond !== atmosphere.diffusivityMetresSquaredPerSecond) {
    throw new Error('Design and atmosphere specify different SI diffusivities')
  }
  const config = withLocalInletDesign(structuredClone(base), {
    ...design, effectiveDiffusivityMetresSquaredPerSecond: atmosphere.diffusivityMetresSquaredPerSecond,
  }, response)
  const m = atmosphere.measurement, scale = m.concentrationScaleKgPerCubicMetre
  config.physicalAtmosphere = structuredClone(atmosphere)
  config.physicsMode = 'filament'
  config.windSpeedScale = config.diffusivityScale = config.emissionRateScale = 1
  config.gustStrength = config.turbulenceScale = 0
  config.sensorNoise = m.noiseKgPerCubicMetre / scale
  config.sensorSaturation = m.saturationKgPerCubicMetre / scale
  config.sensorDetectionFloor = 0
  config.sensorThresholdScale = m.thresholdKgPerCubicMetre / scale / SENSOR_THRESHOLD_BY_SCENARIO[config.scenarioKind]
  config.sensorPpmPerNormalizedUnit = scale * methanePpmPerMassConcentration(m.temperatureKelvin, m.pressurePascal)
  validateSimulationConfig(config)
  return config
}
