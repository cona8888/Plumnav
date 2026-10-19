import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '../..')
const reviewRoot = resolve(projectRoot, 'research/literature_review_2026')
const manifestPath = resolve(reviewRoot, 'provenance/acquisition_manifest.json')
const outputDir = resolve(reviewRoot, 'screening')

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const sha1 = (value) => createHash('sha1').update(value).digest('hex')

const normalizeText = (value = '') => value
  .normalize('NFKC')
  .replace(/\s+/g, ' ')
  .trim()

const normalizeDoi = (value = '') => normalizeText(value)
  .toLowerCase()
  .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
  .replace(/^doi:\s*/, '')

const parseRis = (text, context) => {
  const records = []
  let current = null
  let lastTag = null

  // Clarivate RIS exports can contain a mixture of CRLF, LF, and bare CR
  // separators in the same file. Canonicalize all three before parsing so
  // fields such as WE and AN are not accidentally joined into one value.
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')

  for (const line of lines) {
    const match = line.match(/^([A-Z0-9]{2})  - ?(.*)$/)
    if (match) {
      const [, tag, value] = match
      if (tag === 'TY') current = { fields: {}, ...context }
      if (!current) continue
      if (!current.fields[tag]) current.fields[tag] = []
      current.fields[tag].push(value)
      lastTag = tag
      if (tag === 'ER') {
        records.push(current)
        current = null
        lastTag = null
      }
      continue
    }
    if (current && lastTag && normalizeText(line)) {
      const values = current.fields[lastTag]
      values[values.length - 1] = `${values[values.length - 1]} ${line}`
    }
  }
  if (current) throw new Error(`${context.rawRelativePath}: unterminated RIS record`)
  return records
}

const first = (fields, tag) => normalizeText(fields[tag]?.[0] ?? '')
const all = (fields, tag) => (fields[tag] ?? []).map(normalizeText).filter(Boolean)

const toNormalized = (record, rawIndex) => {
  const fields = record.fields
  const sourceRecordId = first(fields, 'AN')
  const doi = normalizeDoi(first(fields, 'DO'))
  const title = first(fields, 'TI')
  const year = first(fields, 'PY')
  const authors = all(fields, 'AU')
  const fallbackKey = `${title.toLowerCase()}|${year}|${authors[0]?.toLowerCase() ?? ''}`
  // A DOI identifies a report across database records and query batches. Use
  // the database accession when no DOI is available, then a conservative
  // title/year/first-author fallback for records lacking both identifiers.
  const stableKey = doi
    ? `doi:${doi}`
    : sourceRecordId
      ? `wos:${sourceRecordId.toLowerCase()}`
      : `fallback:${fallbackKey}`
  return {
    raw_record_id: `${record.queryId}:${String(rawIndex + 1).padStart(4, '0')}`,
    source_database: 'Web of Science Core Collection',
    source_record_id: sourceRecordId,
    doi,
    title,
    authors,
    publication_year: year,
    journal_or_source: first(fields, 'T2') || first(fields, 'JO') || first(fields, 'J9'),
    abstract: first(fields, 'AB'),
    language: first(fields, 'LA'),
    document_type: first(fields, 'TY'),
    keywords: [...all(fields, 'KW'), ...all(fields, 'DE'), ...all(fields, 'ID')],
    query_batch_id: record.queryId,
    raw_file_sha256: record.rawSha256,
    raw_relative_path: record.rawRelativePath,
    stable_key: stableKey,
    duplicate_group_id: `dup_${sha1(stableKey).slice(0, 16)}`,
    screen_title_abstract: '',
    screen_full_text: '',
    exclusion_reason: '',
    notes: '',
  }
}

const tsvCell = (value) => {
  const text = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '')
  return text.replace(/[\t\r\n]+/g, ' ').trim()
}

const toTsv = (rows, columns) => [
  columns.join('\t'),
  ...rows.map((row) => columns.map((column) => tsvCell(row[column])).join('\t')),
].join('\n') + '\n'

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const rawRecords = []
const batchValidation = []

for (const batch of manifest.batches) {
  const filePath = resolve(reviewRoot, batch.raw_relative_path)
  const buffer = await readFile(filePath)
  const digest = sha256(buffer)
  if (digest !== batch.sha256) throw new Error(`${batch.query_id}: SHA-256 mismatch`)
  if (buffer.byteLength !== batch.bytes) throw new Error(`${batch.query_id}: byte-count mismatch`)
  const parsed = parseRis(buffer.toString('utf8'), {
    queryId: batch.query_id,
    rawSha256: digest,
    rawRelativePath: batch.raw_relative_path,
  })
  if (parsed.length !== batch.result_count) {
    throw new Error(`${batch.query_id}: expected ${batch.result_count} records, parsed ${parsed.length}`)
  }
  batchValidation.push({
    query_id: batch.query_id,
    expected_records: batch.result_count,
    parsed_records: parsed.length,
    bytes: buffer.byteLength,
    sha256: digest,
    valid: true,
  })
  rawRecords.push(...parsed.map(toNormalized))
}

const groups = new Map()
for (const record of rawRecords) {
  const group = groups.get(record.stable_key) ?? []
  group.push(record)
  groups.set(record.stable_key, group)
}

const richness = (record) =>
  record.abstract.length + record.title.length + record.keywords.length * 20 + record.authors.length * 10

const canonicalRecords = []
const duplicateMap = []
for (const group of groups.values()) {
  const ordered = [...group].sort((a, b) => richness(b) - richness(a) || a.raw_record_id.localeCompare(b.raw_record_id))
  const canonical = { ...ordered[0] }
  canonical.query_batch_id = [...new Set(group.map((item) => item.query_batch_id))].sort()
  canonical.raw_file_sha256 = [...new Set(group.map((item) => item.raw_file_sha256))].sort()
  canonical.raw_relative_path = [...new Set(group.map((item) => item.raw_relative_path))].sort()
  canonicalRecords.push(canonical)
  for (const item of group) {
    duplicateMap.push({
      raw_record_id: item.raw_record_id,
      canonical_record_id: canonical.source_record_id || canonical.doi || canonical.duplicate_group_id,
      duplicate_group_id: canonical.duplicate_group_id,
      match_basis: canonical.stable_key.startsWith('doi:')
        ? 'doi'
        : canonical.stable_key.startsWith('wos:')
          ? 'source_record_id'
          : 'title_year_first_author',
      retained_as_canonical: item.raw_record_id === canonical.raw_record_id,
      query_batch_id: item.query_batch_id,
    })
  }
}

canonicalRecords.sort((a, b) =>
  Number(b.publication_year || 0) - Number(a.publication_year || 0) || a.title.localeCompare(b.title)
)
duplicateMap.sort((a, b) => a.raw_record_id.localeCompare(b.raw_record_id))

const normalizedColumns = [
  'raw_record_id', 'source_database', 'source_record_id', 'doi', 'title', 'authors',
  'publication_year', 'journal_or_source', 'abstract', 'language', 'document_type',
  'keywords', 'query_batch_id', 'raw_file_sha256', 'raw_relative_path',
  'duplicate_group_id', 'screen_title_abstract', 'screen_full_text',
  'exclusion_reason', 'notes',
]
const duplicateColumns = [
  'raw_record_id', 'canonical_record_id', 'duplicate_group_id', 'match_basis',
  'retained_as_canonical', 'query_batch_id',
]

const metadataCoverage = Object.fromEntries(
  ['source_record_id', 'doi', 'title', 'authors', 'publication_year', 'journal_or_source', 'abstract', 'language', 'document_type']
    .map((field) => {
      const present = canonicalRecords.filter((record) => Array.isArray(record[field]) ? record[field].length > 0 : Boolean(record[field])).length
      return [field, { present, missing: canonicalRecords.length - present, proportion: canonicalRecords.length ? present / canonicalRecords.length : 0 }]
    }),
)

const queryOverlap = {}
for (const record of canonicalRecords) {
  const key = record.query_batch_id.join('+')
  queryOverlap[key] = (queryOverlap[key] ?? 0) + 1
}

const summary = {
  generated_at: new Date().toISOString(),
  manifest: 'provenance/acquisition_manifest.json',
  batch_validation: batchValidation,
  raw_record_count: rawRecords.length,
  canonical_record_count: canonicalRecords.length,
  duplicate_raw_rows: rawRecords.length - canonicalRecords.length,
  duplicate_group_count: [...groups.values()].filter((group) => group.length > 1).length,
  query_overlap: queryOverlap,
  metadata_coverage: metadataCoverage,
  screening_status: 'not_started',
}

await mkdir(outputDir, { recursive: true })
await writeFile(resolve(outputDir, 'all_raw_records.tsv'), toTsv(rawRecords, normalizedColumns))
await writeFile(resolve(outputDir, 'normalized_records.tsv'), toTsv(canonicalRecords, normalizedColumns))
await writeFile(resolve(outputDir, 'duplicate_map.tsv'), toTsv(duplicateMap, duplicateColumns))
await writeFile(resolve(outputDir, 'normalization_summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

console.log(JSON.stringify(summary, null, 2))
