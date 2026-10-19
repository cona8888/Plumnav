import { GSL_REFERENCE_DESIGN, normalizeGslDesign, hemisphericalSuctionVelocity,
  hemisphericalRequiredFlow, conservativeBurstDwell, tubeTransportSeconds } from './lib/gsl-dimensional-design'
const p = GSL_REFERENCE_DESIGN
console.log(JSON.stringify({ purpose: 'Literature-informed design calculations; proposed settings, not experimental results',
  reference: p, normalized: normalizeGslDesign(p),
  alternativeA2Geometry: normalizeGslDesign({ ...p, robotLengthMetres: 0.82, robotWidthMetres: 0.44 }),
  sameHeadOnOneMetreDomain: normalizeGslDesign({ ...p, domainMetres: 1 }),
  conservativeEightSampleDwellSeconds: conservativeBurstDwell(tubeTransportSeconds(p.tubeLengthMetres,
    p.tubeInnerDiameterMetres, p.actualFlowLitresPerMinute), p.sensorTimeConstantSeconds, p.sampleIntervalSeconds, 8),
  suctionExample: { model: 'Ideal hemispherical sink; no jet, no capture guarantee', distanceMetres: 9.75,
    velocityAt2LitresPerMinute: hemisphericalSuctionVelocity(2, 9.75),
    litresPerMinuteForPointOneMetresPerSecond: hemisphericalRequiredFlow(9.75, 0.1) } }, null, 2))
