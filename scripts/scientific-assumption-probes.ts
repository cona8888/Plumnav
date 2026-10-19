import { m40LatentCycle } from './lib/m40-sampling-audit'
import { m40ContactDecision } from './lib/m40-contact-controller'

const origin = { x: 0.5, y: 0.5 }
const calibration = { slopes: [1, 1, 1, 1], offsets: [0, 0, 0, 0], rawVariance: 0.0001, correctedVariance: 0.0001 }
const fields = [
  { id: 'linear', gradient: { x: 2, y: 1 }, concentration: (x: number, y: number) => 0.5 + 2*x + y },
  { id: 'quadratic', gradient: { x: 2, y: 1 }, concentration: (x: number, y: number) => 0.5 + 2*x + y + 4*x*x + 2*y*y + 3*x*y },
  { id: 'cubic-reversal', gradient: { x: 0.1, y: 0 }, concentration: (x: number) => 0.5 + 0.1*x - 200*x*x*x },
]
const rows = fields.map((field) => {
  const concentration = (p: typeof origin) => field.concentration(p.x - 0.5, p.y - 0.5)
  const views = Array.from({ length: 8 }, (_, i) => ({ heading: 0, time: 13.5 + 0.5*i, intakeFraction: 1,
    values: m40LatentCycle(concentration, origin, 0, 13.5 + 0.5*i) }))
  const decision = m40ContactDecision(views, calibration, 17, 0.05)
  const truth = Math.atan2(field.gradient.y, field.gradient.x)
  const angle = decision.direction ? Math.atan2(decision.direction.y, decision.direction.x) : null
  const error = angle === null ? null : Math.abs(Math.atan2(Math.sin(angle-truth), Math.cos(angle-truth))) * 180/Math.PI
  return { field: field.id, localGradient: field.gradient, idealIntegratedChannels: views[0]!.values,
    state: decision.state, reason: decision.reason, acceptedDirectionErrorDegrees: error,
    maximumResidual: decision.maximumResidual }
})
const normalizedReach = 0.0975
const effectiveOffset = 0.67 * 0.78 * normalizedReach * (0.22*0.38 + 0.46*0.68 + 0.32)
console.log(JSON.stringify({ purpose: 'Analytical witnesses under ideal pre-electronics sampling; no performance benchmark',
  rows, normalizedReach, effectiveOffset, reachAt100Metres: normalizedReach*100,
  tauExample: { tau: 0.5, t10to90: Math.log(9)*0.5 },
  tubeDelayExample: { volumeMl: 10, flowMlPerMinute: 250, delaySeconds: 10/(250/60) } }, null, 2))
