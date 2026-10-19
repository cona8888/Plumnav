import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  benchmarkManifestSha256,
  createManifest,
  type BenchmarkManifest,
} from './headless-benchmark'

export const M5_PROFILE = 'm5-development' as const

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

const stableJson = (value: unknown) =>
  `${JSON.stringify(canonicalize(value), null, 2)}\n`

export const createM5DevelopmentManifest = (): BenchmarkManifest =>
  createManifest(M5_PROFILE)

export const writeM5DevelopmentManifest = async (outputDirectory: string) => {
  const manifest = createM5DevelopmentManifest()
  const manifestSha256 = benchmarkManifestSha256(manifest)
  await mkdir(outputDirectory, { recursive: true })
  const outputPath = join(outputDirectory, 'm5-development-screen-manifest.json')
  const temporaryPath = `${outputPath}.tmp`
  await writeFile(
    temporaryPath,
    stableJson({ ...manifest, manifestSha256 }),
    'utf8',
  )
  await rename(temporaryPath, outputPath)
  return { manifest, manifestSha256, outputPath }
}
