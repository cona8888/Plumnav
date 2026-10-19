import type { AlgorithmController, AlgorithmId } from '../types'
import { createInfotaxisController } from './infotaxis'
import { createPmfsController } from './pmfs'
import { createPulseSniffController } from './pulseSniff'
import {
  createQuadPassiveController,
  createQuadConfirmationController,
  createQuadAdaptiveController,
  createQuadLegacyController,
  createQuadStagedController,
  createQuadSoilSniffController,
  createQuadWindController,
  createQuadRangeController,
  createQuadCorridorController,
  createQuadBracketController,
  createQuadRefineController,
} from './quadSoilSniff'
import {
  createCoverageController,
  createSurgeCastController,
  createZigzagSpiralController,
} from './reactive'
import { createSmcKlController } from './smc'

const FACTORIES: Record<AlgorithmId, () => AlgorithmController> = {
  coverage: createCoverageController,
  'surge-cast': createSurgeCastController,
  'zigzag-spiral': createZigzagSpiralController,
  infotaxis: createInfotaxisController,
  'smc-kl': createSmcKlController,
  pmfs: createPmfsController,
  'pulse-sniff': createPulseSniffController,
  'quad-sniff': createQuadSoilSniffController,
  'quad-sniff-wind': createQuadWindController,
  'quad-sniff-range': createQuadRangeController,
  'quad-sniff-corridor': createQuadCorridorController,
  'quad-sniff-bracket': createQuadBracketController,
  'quad-sniff-refine': createQuadRefineController,
  'quad-sniff-confirmation': createQuadConfirmationController,
  'quad-sniff-adaptive': createQuadAdaptiveController,
  'quad-sniff-staged': createQuadStagedController,
  'quad-sniff-legacy': createQuadLegacyController,
  'quad-passive': createQuadPassiveController,
}

export const createController = (algorithmId: AlgorithmId) => FACTORIES[algorithmId]()

export { ALGORITHM_METADATA, ALGORITHM_ORDER } from './metadata'
