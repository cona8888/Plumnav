import { clamp } from './math'
import { deterministicNoise, hashNumbers } from './rng'
import type { Obstacle } from './types'

export const OBSTACLE_COMPLEXITY_LEVELS = [0, 1, 2, 3, 4, 5] as const
export const FRACTAL_OBSTACLE_GENERATOR_VERSION = 'bsp-fractal-v1'

export const OBSTACLE_COMPLEXITY_LABELS: Record<number, string> = {
  0: 'Clear control',
  1: 'Sparse',
  2: 'Light',
  3: 'Medium',
  4: 'Dense',
  5: 'Labyrinth',
}

type Cell = {
  x: number
  y: number
  width: number
  height: number
  zone: number
  node: number
}

// The central service aisle and open left/right margins provide a known
// topological route between any admissible start and source position. The
// recursive equipment lives only inside these two process bays.
const PROCESS_BAYS: ReadonlyArray<Omit<Cell, 'zone' | 'node'>> = [
  { x: 0.1875, y: 0.0625, width: 0.5625, height: 0.375 },
  { x: 0.1875, y: 0.5625, width: 0.5625, height: 0.375 },
]

const splitCell = (cell: Cell, seed: number): [Cell, Cell] => {
  const aspect = cell.width / Math.max(cell.height, 1e-9)
  const splitVertically = aspect > 1.25
    ? true
    : aspect < 0.8
      ? false
      : deterministicNoise(seed, cell.zone, cell.node, 401) >= 0
  // Exact bisection keeps the hierarchy aligned across 32², 48² and 64²
  // solver grids. Seeded variation is introduced inside each leaf instead of
  // by creating arbitrarily thin partition cells.
  const ratio = 0.5

  if (splitVertically) {
    const firstWidth = cell.width * ratio
    return [
      { ...cell, width: firstWidth, node: cell.node * 2 },
      {
        ...cell,
        x: cell.x + firstWidth,
        width: cell.width - firstWidth,
        node: cell.node * 2 + 1,
      },
    ]
  }

  const firstHeight = cell.height * ratio
  return [
    { ...cell, height: firstHeight, node: cell.node * 2 },
    {
      ...cell,
      y: cell.y + firstHeight,
      height: cell.height - firstHeight,
      node: cell.node * 2 + 1,
    },
  ]
}

const recursivelySubdivide = (
  cells: readonly Cell[],
  depth: number,
  seed: number,
): Cell[] => {
  let leaves = [...cells]
  for (let currentDepth = 0; currentDepth < depth; currentDepth += 1) {
    leaves = leaves.flatMap((cell) => splitCell(cell, seed))
  }
  return leaves
}

/**
 * Builds a deterministic, fractal-style binary spatial subdivision.
 *
 * This is a procedural complexity model rather than a claim that an industrial
 * floor has a measured mathematical fractal dimension. Higher levels add one
 * recursive split per bay and double the equipment count. Occupied area is
 * held approximately constant so the main controlled change is boundary
 * fragmentation/perimeter, while the reserved service corridors remain fixed.
 */
export const generateFractalObstacles = (
  seed: number,
  complexityLevel: number,
): Obstacle[] => {
  if (complexityLevel === 0) return []
  const level = Math.round(clamp(complexityLevel, 1, 5))
  const roots: Cell[] = PROCESS_BAYS.map((bay, zone) => ({
    ...bay,
    zone,
    node: 1,
  }))
  const leaves = recursivelySubdivide(roots, level - 1, seed)
  const baseFill = 0.55

  return leaves.map((cell) => {
    const fillX = clamp(
      baseFill + deterministicNoise(seed, cell.zone, cell.node, 421) * 0.018,
      0.5,
      0.6,
    )
    const fillY = clamp(
      baseFill + deterministicNoise(seed, cell.zone, cell.node, 431) * 0.018,
      0.5,
      0.6,
    )
    const width = cell.width * fillX
    const height = cell.height * fillY
    const offsetX =
      (cell.width - width) *
      clamp(0.5 + deterministicNoise(seed, cell.zone, cell.node, 439) * 0.22, 0.2, 0.8)
    const offsetY =
      (cell.height - height) *
      clamp(0.5 + deterministicNoise(seed, cell.zone, cell.node, 443) * 0.22, 0.2, 0.8)
    return {
      id: `fractal-l${level}-z${cell.zone}-n${cell.node}`,
      x: cell.x + offsetX,
      y: cell.y + offsetY,
      width,
      height,
    }
  })
}

export const summarizeObstacleComplexity = (obstacles: readonly Obstacle[]) => ({
  count: obstacles.length,
  occupiedFraction: obstacles.reduce(
    (total, obstacle) => total + obstacle.width * obstacle.height,
    0,
  ),
  normalizedPerimeter: obstacles.reduce(
    (total, obstacle) => total + 2 * (obstacle.width + obstacle.height),
    0,
  ),
})

/** Fraction of a cell-centred numerical grid represented as solid. */
export const rasterizedObstacleFraction = (
  obstacles: readonly Obstacle[],
  resolution: number,
) => {
  if (!Number.isInteger(resolution) || resolution <= 0) {
    throw new RangeError('resolution must be a positive integer')
  }
  let blocked = 0
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const pointX = (x + 0.5) / resolution
      const pointY = (y + 0.5) / resolution
      if (obstacles.some((obstacle) =>
        pointX >= obstacle.x &&
        pointX <= obstacle.x + obstacle.width &&
        pointY >= obstacle.y &&
        pointY <= obstacle.y + obstacle.height
      )) blocked += 1
    }
  }
  return blocked / (resolution * resolution)
}

export const obstacleLayoutHash = (obstacles: readonly Obstacle[]) =>
  hashNumbers(
    ...obstacles.flatMap((obstacle) => [
      obstacle.x,
      obstacle.y,
      obstacle.width,
      obstacle.height,
    ]),
  ).toString(16).padStart(8, '0')
