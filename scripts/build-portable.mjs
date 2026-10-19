import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDirectory = path.join(projectRoot, 'dist')
const releaseDirectory = path.join(projectRoot, 'release')
const outputPath = path.join(releaseDirectory, 'OPEN_ME_PlumeNav_Lab.html')

const htmlPath = path.join(distDirectory, 'index.html')
const html = await readFile(htmlPath, 'utf8')
const scriptTag = html.match(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/)
const styleTag = html.match(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/)

if (!scriptTag?.[0] || !scriptTag[1] || !styleTag?.[0] || !styleTag[1]) {
  throw new Error('Could not find the production JavaScript and stylesheet in dist/index.html')
}

const assetPath = (assetUrl) => path.join(distDirectory, assetUrl.replace(/^\//, ''))
const [rawJavaScript, rawCss] = await Promise.all([
  readFile(assetPath(scriptTag[1]), 'utf8'),
  readFile(assetPath(styleTag[1]), 'utf8'),
])

// Prevent embedded source text from accidentally closing its containing tag.
// Source maps are intentionally omitted so the portable demo remains one file.
const javascript = rawJavaScript
  .replace(/\n?\/\/# sourceMappingURL=.*$/u, '')
  .replace(/<\/script/giu, '<\\/script')
const css = rawCss.replace(/<\/style/giu, '<\\/style')

const portableHtml = html
  .replace(
    '<meta charset="UTF-8" />',
    '<meta charset="UTF-8" />\n    <!-- Self-contained offline build: CSS and JavaScript are embedded below. -->',
  )
  // Function replacers preserve JavaScript sequences such as `$&` and `$$`
  // literally instead of treating them as String.replace substitution tokens.
  .replace(styleTag[0], () => `<style>\n${css}\n</style>`)
  .replace(scriptTag[0], () => `<script type="module">\n${javascript}\n</script>`)

await mkdir(releaseDirectory, { recursive: true })
await writeFile(outputPath, portableHtml, 'utf8')

const sizeKiB = Math.round(Buffer.byteLength(portableHtml) / 1024)
process.stdout.write(`Created ${outputPath} (${sizeKiB} KiB)\n`)
